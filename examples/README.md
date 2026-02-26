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

When passing args through `res channel add`, use `key=value` strings:

- `--fetch-arg lat=40.7128`
- `--fetch-arg lon=-74.0060`
- `--fetch-arg location="New York, NY"`

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
  --fetch-arg lat=40.7128 \
  --fetch-arg lon=-74.0060 \
  --fetch-arg location="New York, NY" \
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
channels/weather-nyc/content/
```
