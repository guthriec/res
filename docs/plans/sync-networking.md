# Sync: Server & Client Networking

## Overview

Two-way sync between `res` instances over HTTP + SSE.

- `res serve` — long-lived HTTP server that exposes shared channels.
- `res sync` — background daemon (pid file pattern, matching `res start`) that
  connects to one or more servers, subscribes to changes, and publishes local edits.

One server instance, one client instance. Architecture scales to many-to-many in
future iterations.

---

## Content Identity

Content is identified by `(channelId, filename)` within a sync. **No contentId is
exchanged in the network protocol.** ContentIds remain purely local to each
reservoir's `ContentIdAllocator`.

The subscription config in `.res/sync.json` is the sole mapping:

```json
{
  "subscriptions": [
    {
      "serverUrl": "http://127.0.0.1:9876",
      "serverChannelId": "wiki",
      "localChannelId": "wiki"
    }
  ]
}
```

- SSE event `{ channelId: "wiki", filename: "foo.md" }` → file at `wiki/foo.md`
  in the local reservoir (the subscription maps server channel → local channel
  and the filename is preserved).
- Publish request `{ filename: "foo.md", ... }` → publisher finds the matching
  subscription by reverse-lookup of the local channel name, and posts to
  `serverUrl / channels / serverChannelId / publish`.

---

## Version Chain Merging (Hash-Based LCA)

Two independent reservoirs have different version IDs and contentIds for the
same file. The last common ancestor is found by **shared content hash**, not by
shared version ID.

```typescript
findLCA(localChain: ContentVersion[], remoteChain: ContentVersion[]): ContentVersion | null {
  const localHashes = new Set(localChain.map(v => v.hash));
  for (let i = remoteChain.length - 1; i >= 0; i--) {
    if (remoteChain[i].hash !== null && localHashes.has(remoteChain[i].hash)) {
      return remoteChain[i];
    }
  }
  return null;
}
```

**Example:**

| | Server chain | Client chain |
|---|---|---|
| v1 | hash: `a` | hash: `a` |
| v2 | hash: `d` (edit) | hash: `b` (edit) |
| v3 | — | hash: `c` (edit) |

LCA hash set from client: `{a, b, c}`. Walk server chain backward: `d` (not in
set), `a` (in set) → LCA is server's v1. Three-way merge can proceed.

---

## Sidecar Tracking

Each `.res-version.json` sidecar gets an optional `lastPublishedVersionId` field
used by the publisher to determine what needs publishing:

```json
{
  "contentId": "15",
  "chain": [
    { "id": "v1", "parentIds": [],       "hash": "aabbcc", "timestamp": "..." },
    { "id": "v2", "parentIds": ["v1"],   "hash": "ddeeff", "timestamp": "..." },
    { "id": "v3", "parentIds": ["v2"],   "hash": "112233", "timestamp": "..." }
  ],
  "lastPublishedVersionId": "v2"
}
```

This field is the last version the server has acknowledged (either via a
successful publish response or by receiving a merge from the server that
incorporates the local edit). Any version after it that contains a linear edit
(parentIds.length === 1) should be published.

An optional `source` field records which subscription this file belongs to,
for the publisher's reverse-lookup:

```json
{
  "source": {
    "serverUrl": "http://127.0.0.1:9876",
    "serverChannelId": "wiki"
  }
}
```

Without the `source` field, the publisher infers the subscription from the
local channel name by reverse-looking up `.res/sync.json`. The `source` field
is a performance hint to avoid scanning the config on every publish tick.

---

## Publish Algorithm

Walk the chain from tip backward. If any version between `lastPublishedVersionId`
(exclusive) and the tip is a linear edit (`parentIds.length === 1`), the user
has unpublished changes. Publish the **tip's** content (which includes all
changes up through any subsequent merge).

```
chain: [v1, v2(linear), v3(merge)], lastPublished = v1

walk backward:
  v3 (merge, parentIds.length=2) → skip
  v2 (linear, parentIds.length=1) → found! → publish v3's content

chain: [v1, v2(merge)], lastPublished = v1

walk backward:
  v2 (merge, parentIds.length=2) → skip
  v1 → id === lastPublished → stop, nothing to publish
```

On successful publish → update `lastPublishedVersionId = tip.id`.

On restart: same algorithm. Walks from tip, finds the latest linear edit
post-dating `lastPublishedVersionId`.

**Publish request body:**

```json
{
  "filename": "foo.md",
  "content": "...",
  "localVersionChain": [
    { "id": "v1", "parentIds": [], "hash": "aabbcc", "timestamp": "..." },
    { "id": "v2", "parentIds": ["v1"], "hash": "ddeeff", "timestamp": "..." }
  ]
}
```

---

## Server Merge on Publish

### Endpoint

```
POST /api/v1/channels/:channelId/publish
```

### Response

```typescript
interface PublishResponse {
  filename: string;
  merged: boolean;                  // true if server created a new version
  content: string;                  // server's current content
  serverVersionChain: ContentVersion[];
}
```

### Merge logic

1. Look up the content by `(channelId, filename)` on the server.
2. Find the LCA between `localVersionChain` and the server's version chain
   (hash-based).
3. Three-way merge using `UnsafeAutoMerge` (shared ancestor, ours=server,
   theirs=client).
4. If merged content is **byte-identical** to the server's current content:
   - Return `{ merged: false, content: currentContent, serverVersionChain }`.
   - No new version, no SSE event. This is the **loop breaker** — the client
     just advances `lastPublishedVersionId` without writing or creating a
     merge commit.
5. If merged content differs:
   - Write merged content to disk. The server's `ChangeDetector` records a
     new version (a merge commit with `parentIds` referencing both the
     server's tip and the client's tip).
   - Push a `content-updated` SSE event to all subscribers of this channel.
   - Return `{ merged: true, content: mergedContent, serverVersionChain }`.

---

## Protocol: REST + SSE

### Endpoints

All under `/api/v1`.

**`GET /channels`** — list shared channels.

**`GET /channels/:channelId/content`** — initial bulk sync. Returns all
content in the channel with current version chains.

Response:
```typescript
interface SyncContentResponse {
  items: Array<{
    filename: string;
    content: string;
    versionChain: ContentVersion[];
  }>;
}
```

**`GET /channels/:channelId/events`** — SSE stream.

Events:
```
event: content-updated
data: { "channelId": "wiki", "filename": "foo.md", "content": "...",
        "versionChain": [...] }

event: content-deleted
data: { "channelId": "wiki", "filename": "foo.md" }

event: heartbeat
data: { "timestamp": "..." }
```

**`POST /channels/:channelId/publish`** — client publishes a change (see above
for request/response shape).

---

## Loop Breaking: Summary

Three mechanisms prevent infinite update loops:

| Mechanism | Where | How |
|-----------|-------|-----|
| Merge commits not published | Client | Only `parentIds.length === 1` versions are published |
| Byte-identical merge skip | Server | If merged content matches current content, no version or event is created |
| `lastPublishedVersionId` | Client | Restart-safe tracking of what the server has acknowledged |

---

## Channel Sharing: Opt-In

A channel must be explicitly marked as shared before the server will serve it.

- `res channel edit <id> --share` sets `shared: true` on the channel config.
- `res channel edit <id> --unshare` sets `shared: false`.
- `res serve` serves only channels with `shared: true`.

A new field `shared: boolean` is added to `ChannelConfig`:

```typescript
interface ChannelConfig {
  // existing fields...
  shared?: boolean;
}
```

The `GET /channels` endpoint returns only shared channels. The `GET /channels/:id/content`
and `POST /channels/:id/publish` endpoints reject requests for non-shared channels.

---

## Server Lifecycle

```
res serve --port 9876
```

- Starts an HTTP server on `127.0.0.1:9876`.
- No authentication in v1 (localhost-only).
- Runs its own `ChangeDetector` (file watcher) to detect local edits.
- When a local edit is detected, pushes a `content-updated` SSE event to all
  subscribers of the affected channel.
- Writes a pid file (`.res-server.pid`) and a status file (`.res-server-status.json`),
  matching the pattern used by `res start` / `res stop`.
- Runs until SIGINT/SIGTERM.

---

## Client Daemon Lifecycle

```
res sync
```

- Starts a background daemon (pid file, matching `res start`).
- Reads `.res/sync.json` for subscriptions.
- For each subscription, creates a `SyncClient` instance:

```
SyncClient loop:
  1. Initial pull: GET /content for all files.
     For each file: write locally, create sidecar with initial version
     and lastPublishedVersionId set to the pulled version.
  2. SSE subscribe: GET /events, read the stream with fetch + ReadableStream.
     Auto-reconnect on disconnect with exponential backoff.
  3. On each SSE content-updated event:
     a. Resolve local path via subscription mapping.
     b. Find LCA between local chain and received chain (hash-based).
     c. Merge using UnsafeAutoMerge.
     d. Write merged content → local ChangeDetector records merge commit.
  4. Publish tick (every N seconds, e.g. 10s):
     For each sidecar in the subscription's local channel:
       a. If chain tip is a merge (parentIds.length >= 2) AND
          tip.id !== lastPublishedVersionId:
          - Walk chain backward; if any linear edit after
            lastPublishedVersionId is found → publish tip content
       b. If chain tip is linear (parentIds.length === 1) AND
          tip.id !== lastPublishedVersionId → publish tip content
       c. On success response:
          - Update lastPublishedVersionId = tip.id
          - If merged: true → write merged content, create merge commit
```

---

## SSE Client Implementation

Node.js built-in `fetch()` with `ReadableStream`:

```typescript
async function subscribeEvents(
  serverUrl: string,
  channelId: string,
  onContentUpdated: (data: ContentUpdatedEvent) => void,
): Promise<void> {
  const response = await fetch(`${serverUrl}/api/v1/channels/${channelId}/events`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Parse SSE frames from buffer...
  }
}
```

---

## New Files

```
src/sync-protocol.ts    — request/response/event types (PublishRequest,
                          PublishResponse, SseEvent, SyncContentResponse, etc.)
src/sync-server.ts      — HTTP server using Node.js built-in http module
src/sync-config.ts      — read/write .res/sync.json subscriptions
src/sync-client.ts      — SyncClient daemon per subscription
```

## Modified Files

```
src/types.ts            — ChannelConfig gets shared?: boolean
src/channel-controller.ts — handle shared field in add/edit/view/list
src/cli.ts              — add 'serve', 'sync', 'sync stop', 'sync status'
                          subcommands; channel --share/--unshare flags
src/index.ts            — export new types
```

## Dependencies

None new. Node.js built-in `http`, `crypto`, `fetch` (available globally since
Node 18; target is Node 20+).

## Implementation Sequence

### Step 1: Protocol types + config I/O
- `sync-protocol.ts`: PublishRequest, PublishResponse, SseEvent, SyncContentResponse
- `sync-config.ts`: read/write subscriptions, read/write per-sidecar sync fields
- Tests: round-trip config, type validation

### Step 2: Channel sharing flag
- Add `shared: boolean` to `ChannelConfig` and `Channel`
- Wire into `channel-controller.ts` (addChannel, editChannel accept updates to shared)
- CLI: `res channel edit <id> --share` / `--unshare`
- Tests: channel creation, toggling share

### Step 3: Server
- `sync-server.ts`: HTTP server with /content, /events, /publish, /channels
- SSE connection tracking per channel
- Publish handler with merge + loop breaker
- File watcher (ChangeDetector) for local edits → push SSE events
- PID/status file pattern matching `res start`
- Tests: start server, publish to it, verify SSE event sent

### Step 4: Client daemon
- `sync-client.ts`: SyncClient with initial pull, SSE subscribe, publish tick
- Hash-based LCA (modify VersionStore.findLCA if needed)
- Publish loop: walk chain, find unpublised edits, POST, handle response
- PID/status file pattern
- Tests: in-memory server → verify bidirectional sync round-trip

### Step 5: CLI subcommands
- `res serve` — starts server (foreground)
- `res sync` / `res sync stop` / `res sync status` — daemon lifecycle
- `res channel edit --share / --unshare`
