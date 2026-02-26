# CLI Command Reference

All commands support `--help`.

## Global

- Program name: `res`
- Version: `0.1.0`
- Description: collect web content into local markdown directories

## `init`

Initialize a reservoir directory.

```bash
res init [--dir <path>] [--max-size <mb>]
```

Options:

- `--dir <path>`: directory to initialize (default: current working directory)
- `--max-size <mb>`: max total content size in MB for `clean`

## `add-fetcher`

Register a custom fetcher executable in user config.

```bash
res add-fetcher <executable> [--dir <path>]
```

Options:

- `--dir <path>`: reservoir directory (default: current working directory)

Behavior:

- Copies executable to platform config dir (typically `~/.config/res/fetchers/`)
- Fails if file does not exist or fetcher name already exists

## `channel`

Manage channels.

### `channel add`

```bash
res channel add <name> --type <type> \
  [--fetch-arg <value> ...] \
  [--rate-limit <seconds>] \
  [--refresh-interval <seconds>] \
  [--dir <path>]
```

Options:

- `--type <type>`: required; one of:
  - built-in: `rss`, `web_page`
  - custom: registered fetcher name
- `--fetch-arg <value>`: repeatable fetcher argument
- `--rate-limit <seconds>`: rate-limit interval
- `--refresh-interval <seconds>`: background refresh interval (default is 24h)
- `--dir <path>`: reservoir directory

### `channel edit`

```bash
res channel edit <id> \
  [--name <name>] \
  [--type <type>] \
  [--fetch-arg <value> ...] \
  [--rate-limit <seconds>] \
  [--refresh-interval <seconds>] \
  [--dir <path>]
```

Updates any provided fields on the channel.

### `channel delete`

```bash
res channel delete <id> [--dir <path>]
```

Deletes the channel and all content under it.

### `channel view`

```bash
res channel view <id> [--dir <path>]
```

Prints channel JSON.

### `channel list`

```bash
res channel list [--dir <path>]
```

Prints JSON array of channels with an additional `path` field (`channels/<channel-id>`).

## Background fetcher

### `start`

```bash
res start [--dir <path>]
```

Runs background fetching in the current process.

### `status`

```bash
res status [--dir <path>]
```

Shows process status JSON when running, otherwise prints `Background fetcher is not running`.

### `stop`

```bash
res stop [--dir <path>]
```

Stops the running background fetcher process for the reservoir.

## Retention commands

Default lock name when omitted is `[global]`.

### `retain content`

```bash
res retain content <id> [lockName] [--dir <path>]
```

### `retain range`

```bash
res retain range [lockName] \
  [--from <id>] \
  [--to <id>] \
  [--channel <id>] \
  [--dir <path>]
```

Notes:

- Must include at least one of `--from` or `--to`
- IDs are numeric strings; invalid ranges error out

### `retain channel`

```bash
res retain channel <id> [lockName] [--dir <path>]
```

Adds a channel-level lock applied automatically to newly fetched content.

### `release content`

```bash
res release content <id> [lockName] [--dir <path>]
```

### `release range`

```bash
res release range [lockName] \
  [--from <id>] \
  [--to <id>] \
  [--channel <id>] \
  [--dir <path>]
```

### `release channel`

```bash
res release channel <id> [lockName] [--dir <path>]
```

Removes a channel-level lock for newly fetched content.

## `retained`

List retained items.

```bash
res retained [--channels <ids>] [--dir <path>]
```

Options:

- `--channels <ids>`: comma-separated channel IDs to filter
- `--dir <path>`: reservoir directory

Output includes each retained item metadata and relative `filePath`.

## `clean`

Delete unlocked content beyond configured max size.

```bash
res clean [--dir <path>]
```

Behavior:

- No-op when no `maxSizeMB` is configured
- Deletes oldest unlocked content first
- Preserves content with one or more locks
