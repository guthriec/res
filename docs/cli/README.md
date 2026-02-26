# CLI Documentation

`res` collects web content into a local reservoir of Markdown files.

## Install

From this repository:

```bash
npm install
npm run build
```

Run the CLI from source tree:

```bash
node dist/cli.js --help
```

If installed as a package, the executable is `res`.

## Reservoir layout

After `res init`, the reservoir directory contains:

- `.res-config.json`
- `channels/`
  - `<channel-id>/channel.json`
  - `<channel-id>/metadata.json`
  - `<channel-id>/content/*.md`

## Quickstart

1) Initialize a reservoir:

```bash
res init --dir ./my-reservoir --max-size 2048
```

2) Add a channel (RSS example):

```bash
res channel add hacker-news \
  --type rss \
  --fetch-arg https://news.ycombinator.com/rss \
  --refresh-interval 600 \
  --dir ./my-reservoir
```

3) Start background fetching:

```bash
res start --dir ./my-reservoir
```

4) Check status in another shell:

```bash
res status --dir ./my-reservoir
```

5) List retained items:

```bash
res retained --dir ./my-reservoir
```

## Notes

- Most commands default `--dir` to the current working directory.
- `channel add` requires `--type` and accepts repeatable `--fetch-arg` values.
- Channel IDs are generated from channel names (slug form) and are used in later commands.

See `commands.md` for complete command details and `examples.md` for common workflows.
