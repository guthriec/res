# Version Tracking

## Overview

`res` detects local edits to markdown files in the reservoir, records a content-addressed
version DAG per file, and performs automatic three-way merge when conflicting edits are
detected. This is the foundation for eventual two-way sync — networking is deferred.

All markdown files in the reservoir are tracked. No channel-level opt-in/opt-out.

---

## Data Model

### Content hash

SHA-256 of the **full file** (frontmatter + body, no exclusions). Any byte change produces
a new version. Uses Node.js built-in `crypto.createHash("sha256")`. No new dependency.

### Sidecar: `<filename>.res-version.json`

Each `.md` file at `<channel>/foo.md` gets a sibling sidecar `<channel>/foo.res-version.json`:

```json
{
  "contentId": "42",
  "chain": [
    { "id": "v1", "parentIds": [],       "hash": "aabbcc", "timestamp": "2026-07-03T00:00:00Z" },
    { "id": "v2", "parentIds": ["v1"],   "hash": "ddeeff", "timestamp": "2026-07-03T12:00:00Z" }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `contentId` | The `ContentIdAllocator`-managed document ID for this file |
| `chain` | Ordered version list forming a DAG (linear in single-user case) |
| `parentIds.length === 0` | Root (initial version) |
| `parentIds.length === 1` | Linear edit |
| `parentIds.length >= 2` | Merge commit (resolved conflict, once sync exists) |
| `hash: null` | Tombstone (file was deleted) |

### Tombstones

When a `.md` file is deleted but its `.res-version.json` sidecar still exists, the change
detector appends a tombstone:

```json
{ "id": "v3", "parentIds": ["v2"], "hash": null, "timestamp": "2026-07-03T18:00:00Z" }
```

A tombstone **preserves** the content ID mapping and version history so that a future sync
peer knows the file was intentionally deleted, not just missing. Sidecars for tombstoned
files are never deleted (~200 bytes each).

### No frontmatter changes

No `res-*` fields are added to the user's markdown. The sidecar carries all version
metadata. The existing `ContentIdAllocator` map resolves content IDs to file paths.

---

## Change Detection

### Triggers

The change detector runs in two ways, both feeding the same
`recordVersionIfChanged(filePath)` codepath:

1. **File watcher** — `fs.watch` (recursive) on channel content directories. Detects
   edits in real time while the `res` process is running. Debounced (250ms) so rapid
   saves trigger a single recheck.

2. **Periodic full pass** — runs as a step in the background worker loop. Iterates over
   all tracked `.md` files and compares on-disk hash against sidecar tip hash. This
   catches changes that happened while the watcher wasn't running (process stopped,
   crash, or an external tool that didn't trigger OS watch events).

### Algorithm

**For each `.md` file in the reservoir:**

1. Read the sidecar at `<filePath>.res-version.json`.
2. If **sidecar absent**:
   - Compute SHA-256 of the file.
   - Resolve or assign a `contentId` via `ContentIdAllocator`.
   - Create sidecar with `chain: [{ id: "v1", parentIds: [], hash, timestamp: now }]`.
3. If **sidecar present**:
   - Compute SHA-256 of the file.
   - If hash equals `chain[last].hash` → no change, skip.
   - If hash differs → append new version:
     `{ id: v<n+1>, parentIds: [chain[last].id], hash, timestamp: now }`.
   - Write the updated sidecar.

**For each `.res-version.json` sidecar:**

4. If the matching `.md` file does **not** exist:
   - If `chain[last].hash === null` → already tombstoned, skip.
   - If `chain[last].hash !== null` → append tombstone:
     `{ id: v<n+1>, parentIds: [chain[last].id], hash: null, timestamp: now }`.
   - Write the updated sidecar.

---

## Version Store

### Component: `VersionStore`

Wraps sidecar file I/O. No centralized index — lookups are path-based.

```typescript
class VersionStore {
  /** Read the sidecar for a given .md file path, or null if none exists. */
  read(mdFilePath: string): VersionSidecar | null;

  /** Atomically write a sidecar. Uses writeJSONAtomic (temp file + rename). */
  write(mdFilePath: string, sidecar: VersionSidecar): Promise<void>;

  /** True if the sidecar exists and the chain tip has hash: null. */
  isTombstoned(mdFilePath: string): boolean;

  /** Walk two chains from tip backward to find the last common ancestor version. */
  findLCA(
    localSidecar: VersionSidecar,
    remoteChain: ContentVersion[],
  ): ContentVersion | null;
}
```

**When writes happen:**

| Trigger | What's written |
|---------|---------------|
| New file detected (no sidecar) | Initial sidecar with v1 |
| File content changed (hash mismatch) | Sidecar updated with new version appended |
| File deleted (sidecar exists, no `.md`) | Sidecar updated with tombstone appended |
| New content fetched (`FetchOrchestrator`) | Initial sidecar with v1 (created inline after file write) |

---

## Merge Strategy

### Pluggable interface

```typescript
interface MergeStrategy {
  /**
   * Three-way merge for a version chain with concurrent tips.
   *
   * @param ancestor  The last common ancestor version, or null if no shared history.
   * @param ours      The local tip version (full metadata).
   * @param theirs    The incoming tip version from a peer (full metadata).
   * @param oursContent     File content at the local tip.
   * @param theirsContent   File content at the incoming tip.
   * @param ancestorContent File content at the LCA, or null if no common ancestor.
   * @returns The merged file content string.
   */
  merge(params: {
    ancestor: ContentVersion | null;
    ours: ContentVersion;
    theirs: ContentVersion;
    ancestorContent: string | null;
    oursContent: string;
    theirsContent: string;
  }): string;
}
```

**Semantics of `ancestor` / `ours` / `theirs`:**

- `ancestor` — the last common ancestor version (LCA) of the two chains. This is the
  version in the DAG that both `ours` and `theirs` descended from. Resolved by
  `VersionStore.findLCA`. If `null`, the chains share no common version (e.g., a file was
  independently created in two reservoirs with the same content ID).

- `ours` — the local reservoir's current tip version (full `ContentVersion` with id,
  parentIds, hash, timestamp). The merge output replaces `ours` with a merge commit.

- `theirs` — the incoming tip version received from a peer (future sync). Full
  `ContentVersion` metadata.

### Default strategy: Unsafe auto-merge

Implemented using `node-diff3` (new dependency, MIT, zero transitive deps).

1. If `ancestor` is `null`: fall back to **LWW** — compare `ours.timestamp` vs
   `theirs.timestamp`, return the newer side's content.
2. If `ancestor` is not null:
   a. Split `ancestorContent`, `oursContent`, `theirsContent` into lines.
   b. Call `diff3Merge(ancestorLines, oursLines, theirsLines)`.
   c. For each chunk:
      - Non-conflicting → use the resolved text.
      - Conflicting → use LWW on `ours.timestamp` vs `theirs.timestamp` to pick a side.
   d. Join resolved chunks and return.

No conflict markers are ever produced. Overlapping edits from the earlier-timestamp side
are silently discarded — this is the "unsafe" part. The interface is designed to be
replaced with a CRDT-based strategy later, which can deterministically resolve conflicts
instead of dropping data.

### Version metadata for CRDTs

The `ours` / `theirs` / `ancestor` parameters are full `ContentVersion` objects
(parentIds, id, timestamp, hash). A future CRDT strategy has enough information to
reconstruct the version graph and drive its merge logic. No content is passed into
the strategy — it receives raw file contents via `oursContent` / `theirsContent` /
`ancestorContent`.

---

## Shared File Watcher

### Component: `src/file-watcher.ts`

Extracted from `watchChannelsForResync` in `background-fetch-worker.ts:376-419` — a
single place for `fs.watch` + debounce + cleanup:

```typescript
/**
 * Watch a directory recursively and invoke `onChange` (debounced).
 * Returns a cleanup function that closes the watcher and cancels pending callbacks.
 * Gracefully handles filesystems that don't support fs.watch (logs and returns no-op cleanup).
 */
function createDirectoryWatcher(
  dir: string,
  onChange: () => void,
  debounceMs?: number,   // default 250
): () => void;
```

The existing `watchChannelsForResync` will be refactored to use this. The change
detector will create a separate watcher on the reservoir's content root.

---

## Interaction with Existing Components

### FilesystemSynchronizer (`src/filesystem-synchronizer.ts`)

**Problem:** `syncContentTracking()` (line 29-32) removes `ContentIdAllocator` mappings
for any file absent from disk. This would destroy the content ID mapping for tombstoned
files, breaking sync references.

**Fix:** Before removing a mapping, check whether the sidecar exists at that path.
If the sidecar exists (tombstoned or otherwise), preserve the mapping. Only remove
mappings for files that have neither `.md` nor sidecar.

### EvictionController (`src/eviction-controller.ts`)

**No change needed.** When eviction deletes an unlocked `.md`, the sidecar remains.
The next change-detection pass will find the sidecar without a `.md` file and record a
tombstone. This is acceptable: evicted == deleted from the system's perspective.
Sidecars are negligible in size.

### ContentIdAllocator (`src/content-id-allocator.ts`)

**No change needed.** Mappings are preserved for tombstoned files (via the
`FilesystemSynchronizer` fix). Mappings are removed as before for files with no sidecar.

### ContentParser (`src/content-parser.ts`)

**No change needed.** No frontmatter changes for version tracking.

### FetchOrchestrator (`src/fetch-orchestrator.ts`)

**Change:** After writing a new content file to disk, create the initial sidecar.
This ensures newly-fetched content enters the version system immediately.

### BackgroundFetchWorker (`src/background-fetch-worker.ts`)

**Changes:**
1. Refactor `watchChannelsForResync` to use shared `createDirectoryWatcher`.
2. Add change-detection pass in the worker loop (after `syncContentTracking`,
   before `fetchChannel`).

---

## Code Layout

```
New:
  src/file-watcher.ts           — shared fs.watch + debounce utility (extracted)
  src/version-store.ts          — sidecar read / write / isTombstoned / findLCA
  src/change-detector.ts        — scan + watch + version recording
  src/merge-strategy.ts         — MergeStrategy interface + UnsafeAutoMerge (node-diff3)

Modified:
  src/background-fetch-worker.ts   — use shared FileWatcher; add change-detection step
  src/filesystem-synchronizer.ts   — preserve mappings for tombstoned files
  src/fetch-orchestrator.ts        — create initial sidecar on fetched content

New dependency:
  node-diff3 (MIT, zero transitive deps)
```

---

## Edge Cases

1. **Sidecar absent, `.md` present** — untracked content. Create initial sidecar (v1).
   Assign or resolve `contentId` via `ContentIdAllocator`.

2. **Both sidecar and `.md` absent** — fully cleaned up (e.g., `rm -rf`).
   `FilesystemSynchronizer` removes metadata and mapping. No sidecar implies
   no tombstone needed.

3. **Sidecar present, `.md` present, hash match** — no change. Skip.

4. **Sidecar present, `.md` present, hash mismatch** — record new version.

5. **Sidecar present, `.md` absent, not tombstoned** — record tombstone.

6. **Sidecar present, `.md` absent, already tombstoned** — skip.

7. **Concurrent sidecar writes** — `writeJSONAtomic` (temp + rename) prevents corruption.
   Last rename wins; next scan reconciles if needed.

8. **Renamed `.md` file** — old path sidecar gets tombstoned; new path gets a new sidecar
   with a new content ID. Version history does not follow renames in v1. Future:
   heuristic rename detection by matching content hashes.

---

## Implementation Sequence

### Step 1: Extract shared FileWatcher
- `src/file-watcher.ts` → `createDirectoryWatcher(dir, onChange, debounceMs)`.
- Refactor `watchChannelsForResync` to use it.
- Tests: debounce, cleanup, unsupported-fs fallback.

### Step 2: Content hashing utility
- `hashFile(absPath: string): string` → `crypto.createHash("sha256")`.
- Place in `src/version-store.ts`.

### Step 3: VersionStore + sidecar I/O
- `src/version-store.ts` → `read`, `write`, `isTombstoned`, `findLCA`.
- Tests: round-trip, tombstone detection, LCA walk.

### Step 4: ChangeDetector
- `src/change-detector.ts` → `scanAll()`, `startWatching()`.
- Tests: initial sidecar creation, edit detection, tombstone on deletion.

### Step 5: MergeStrategy + UnsafeAutoMerge
- `src/merge-strategy.ts` → interface + implementation.
- Install `node-diff3`.
- Tests: non-conflicting merge, LWW on conflict, null-ancestor LWW.

### Step 6: Modify existing components
- `FilesystemSynchronizer`: check sidecar before removing mappings.
- `FetchOrchestrator`: create initial sidecar on fetch.
- `BackgroundFetchWorker`: wire change-detection step into the loop.

---

## Prior Art / Alternatives Considered

- **Git as the version store**: Attractive (free VCS, existing expertise, Obsidian Git
  plugin compatibility). Rejected as a dependency: git requires separate installation,
  its data model (commits are repository-wide, not per-file) doesn't map cleanly to
  per-content-file version chains, and it introduces branch/tag management complexity.

- **CRDT-first design (Yjs / Automerge)**: Would avoid conflict resolution entirely.
  Rejected for v1: CRDT formats are binary and opaque — users can't inspect their
  version history as plain JSON. The goal is to support CRDTs eventually, which the
  swappable `MergeStrategy` interface enables without committing to them now.

- **Frontmatter-based versioning**: Would keep everything inline in the `.md` file.
  Rejected: contaminates user content, limited to string values, fragile to user edits.
