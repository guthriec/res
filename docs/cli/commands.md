# CLI Command Reference

All commands support `--help`.

## Global

- Program name: `res`
- Version: `0.1.0`
- Description: collect web content into local markdown directories
- Global option: `--dir <path>`
  - Use as `res --dir <path> <command> ...`
  - For `res init`, omitted `--dir` defaults to the current working directory
  - For all other commands, omitted `--dir` searches from the current working directory upward for the nearest initialized reservoir

## `init`

Initialize a reservoir directory.

```bash
res init [--max-size <mb>]
```

Options:

- `--max-size <mb>`: max total content size in MB for `clean`

## `config`

Manage reservoir-level configuration.

### `config set-max-size`

```bash
res config set-max-size <mb>
```

Behavior:

- Updates `maxSizeMB` in reservoir config
- If the new value is lower than the previous value, runs an eviction pass immediately (same behavior as `res clean`)
- `<mb>` must be a positive number

## `add-fetcher`

Register a custom fetcher executable in user config.

```bash
res add-fetcher <executable>
```

Behavior:

- Copies executable to platform config dir (typically `~/.config/res/fetchers/`)
- Fails if file does not exist or fetcher name already exists

## `channel`

Manage channels.

### `channel add`

```bash
res channel add <name> --type <type> \
  [--fetch-param <json>] \
  [--rate-limit <seconds>] \
  [--refresh-interval <seconds>] \
  [--id-field <field>] \
  [--duplicate-strategy <overwrite|keep both>]
```

Options:

- `--type <type>`: required; one of:
  - built-in: `rss`, `web_page`
  - custom: registered fetcher name
- `--fetch-param <json>`: JSON object patch for fetcher parameters
- For built-in fetchers:
  - `rss`: include `--fetch-param '{"url":"<feed-url>"}'`
  - `web_page`: include `--fetch-param '{"url":"<page-url>"}'`
- `--rate-limit <seconds>`: rate-limit interval
- `--refresh-interval <seconds>`: background refresh interval (default is 24h)
- `--id-field <field>`: optional fetched-item frontmatter field name used as the per-channel unique content identifier
  - when the field is missing on an item, deduplication falls back to filename
- `--duplicate-strategy <overwrite|keep both>`: controls how duplicates are handled
  - `overwrite`: replace the existing content item for the same dedupe key
  - `keep both`: keep both files; duplicate filenames get `-1`, `-2`, etc. suffixes

### `channel edit`

```bash
res channel edit <id> \
  [--name <name>] \
  [--type <type>] \
  [--fetch-param <json>] \
  [--rate-limit <seconds>] \
  [--refresh-interval <seconds>] \
  [--id-field <field>] \
  [--duplicate-strategy <overwrite|keep both>]
```

Updates any provided fields on the channel.

Deduplication fields:

- `--id-field` sets or updates the fetched-item frontmatter field used as the unique identifier
- `--duplicate-strategy` sets duplicate handling to `overwrite` or `keep both`

`--fetch-param` edits use JSON Merge Patch-like semantics:

- Only provided keys are updated
- Omitted keys are left unchanged
- A key set to `null` removes that key (for example `--fetch-param '{"timeout":null}'`)

### `channel delete`

```bash
res channel delete <id>
```

Deletes the channel and all content under it.

### `channel view`

```bash
res channel view <id>
```

Prints channel JSON.

### `channel list`

```bash
res channel list
```

Prints JSON array of channels with an additional `path` field (`.res/channels/<channel-id>`).

## Background fetcher

### `start`

```bash
res start [--log-level <error|info|debug|silent>]
```

Runs background fetching in the current process.

Behavior:

- On startup, scans channel directories for untracked markdown files, assigns global IDs, and applies each channel's `retainedLocks` to newly tracked files
- While running, periodically re-scans before each scheduled tick and also watches `.res/channels/` for filesystem changes to trigger fast re-sync
- `--log-level` controls all background-fetcher logging:
  - `error`: only errors
  - `info` (default): startup + fetch summaries + errors
  - `debug`: debug logging
  - `silent`: no background-fetcher logs

### `status`

```bash
res status
```

Shows process status JSON when running, otherwise prints `Background fetcher is not running`.

### `stop`

```bash
res stop
```

Stops the running background fetcher process for the reservoir.

## Retention commands

Default lock name when omitted is `[global]`.

### `retain content`

```bash
res retain content <id> [lockName]
```

### `retain range`

```bash
res retain range [lockName] \
  [--from <id>] \
  [--to <id>] \
  [--channel <id>]
```

Notes:

- Must include at least one of `--from` or `--to`
- IDs are numeric strings; invalid ranges error out

### `retain channel`

```bash
res retain channel <id> [lockName]
```

Adds a channel-level lock applied automatically to newly fetched content.

### `release content`

```bash
res release content <id> [lockName]
```

### `release range`

```bash
res release range [lockName] \
  [--from <id>] \
  [--to <id>] \
  [--channel <id>]
```

### `release channel`

```bash
res release channel <id> [lockName]
```

Removes a channel-level lock for newly fetched content.

## `content list`

List content items with filters and pagination.

```bash
res content list \
  [--channels <ids>] \
  [--retained <true|false>] \
  [--retained-by <names>] \
  [--page-size <count>] \
  [--page-offset <count>]
```

Options:

- `--channels <ids>`: comma-separated channel IDs to filter by
- `--retained <true|false>`: whether to restrict to only content retained by some lock (default: `true`)
- `--retained-by <names>`: only include content retained by the provided lock names (comma-separated; requires `--retained true`)
  - if provided but empty, defaults to `[global]`
- `--page-size <count>`: max number of matching items to return
- `--page-offset <count>`: number of matching items to skip before returning results

Output includes each item metadata and relative `filePath`.

## `clean`

Delete unlocked content beyond configured max size.

```bash
res clean
```

Behavior:

- No-op when no `maxSizeMB` is configured
- Deletes oldest unlocked content first
- Preserves content with one or more locks
