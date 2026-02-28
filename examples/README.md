# Examples

## Weather custom fetcher

This example script fetches current weather from Open-Meteo and writes one markdown file to `outs/` in the format expected by `res` custom fetchers.

### Files

- `weather-fetcher.mjs` – custom fetcher executable

### Script arguments

`weather-fetcher.mjs` accepts named args:

- `--lat` or `--latitude` (default: `37.7749`)
- `--lon` or `--longitude` (default: `-122.4194`)
- `--location` (default: `San Francisco, CA`)

When passing params through `res channel add`, use a single JSON object:

- `--fetch-param '{"lat":40.7128,"lon":-74.0060,"location":"New York, NY"}'`

### End-to-end weather example

Assumes:

- `res` is already installed and available on `PATH`
- you are already inside an initialized reservoir directory

From the repository root:

```bash
chmod +x examples/weather-fetcher.mjs

# Register the fetcher globally for res
res add-fetcher ./examples/weather-fetcher.mjs

# Create a channel that uses the fetcher name returned above (usually weather-fetcher.mjs)
res channel add weather-nyc \
  --type weather-fetcher.mjs \
  --fetch-param '{"lat":40.7128,"lon":-74.0060,"location":"New York, NY"}' \
  --refresh-interval 60
```

### Retain the weather channel

Apply a lock so newly fetched items from that channel are automatically retained:

```bash
res retain channel weather-nyc weather-lock
```

### Fetch and verify output

Start the fetch loop in one terminal:

```bash
res start
```

Then, in another terminal after a minute, inspect and stop:

```bash
res status
res channel list
res retained
res stop
```

Fetched markdown appears under:

```bash
<content-slug>/content.md
```

## Hacker News RSS + Ollama summarization workflow

This example provides three shell scripts:

- `hn-setup-channel.sh` – creates (or updates) a Hacker News RSS channel with a 1-hour refresh interval and applies a channel retention lock
- `hn-recurring-summarize-to-obsidian.sh` – finds retained items for that lock, summarizes each item with a local Ollama instance, appends summaries to a markdown file, and (by default) releases the lock on processed content
- `hn-schedule-launchd.sh` – installs/uninstalls a macOS `launchd` job to run the recurring summarizer on a fixed interval

Prerequisites for these scripts:

- `res` on `PATH`
- `jq`
- `curl`
- local Ollama server for summarization script

### Files

- `hn-setup-channel.sh`
- `hn-recurring-summarize-to-obsidian.sh`
- `hn-schedule-launchd.sh`

### Setup script

From the repository root (inside an initialized reservoir):

```bash
chmod +x examples/hn-setup-channel.sh examples/hn-recurring-summarize-to-obsidian.sh examples/hn-schedule-launchd.sh

./examples/hn-setup-channel.sh
```

The setup script will:

- create/update `hacker-news` RSS channel using `https://hnrss.org/frontpage`
- set refresh interval to 1 hour
- apply `news-summarization` as a channel lock for new content
- assume `channel_id = channel_name` (`hacker-news`)

### Recurring summarization script

Assumes a local Ollama server is running (default URL: `http://127.0.0.1:11434`):

```bash
./examples/hn-recurring-summarize-to-obsidian.sh
```

This script uses fixed defaults inside the file (`news-summarization`, `mistral-nemo:latest`), writes date+batch files in a flat structure (`news-summaries-YYYY-MM-DD-batch-N.md`), tags each digest title with the batch number, sends retained posts in one prompt per batch, and loops until no retained posts remain. It releases processed items with `res release range`.

### Typical loop

```bash
# terminal 1: run background fetching
res --dir . start

# terminal 2: run manually / from scheduler
./examples/hn-recurring-summarize-to-obsidian.sh
```

### Schedule on macOS with launchd

Install a launch agent to run every 15 minutes:

```bash
./examples/hn-schedule-launchd.sh install
```

Check status:

```bash
./examples/hn-schedule-launchd.sh status
```

Uninstall:

```bash
./examples/hn-schedule-launchd.sh uninstall
```

This scheduler script is intentionally minimal and only supports `install` (default), `status`, and `uninstall`.
