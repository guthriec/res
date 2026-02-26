# CLI Examples

## Add RSS and webpage channels

```bash
res channel add hn \
  --type rss \
  --fetch-arg https://news.ycombinator.com/rss \
  --refresh-interval 900 \
  --dir ./my-reservoir

res channel add docs-homepage \
  --type web_page \
  --fetch-arg https://example.com \
  --dir ./my-reservoir
```

## Register and use a custom fetcher

```bash
res add-fetcher ./examples/weather-fetcher.mjs --dir ./my-reservoir

res channel add weather-nyc \
  --type weather-fetcher.mjs \
  --fetch-arg nyc \
  --refresh-interval 1800 \
  --dir ./my-reservoir
```

## Start, inspect, and stop background fetching

```bash
res start --dir ./my-reservoir
res status --dir ./my-reservoir
res stop --dir ./my-reservoir
```

## Retain and release content locks

```bash
# Keep a single item
res retain content 100012 --dir ./my-reservoir

# Keep a range under a named lock
res retain range summarizer --from 100000 --to 100250 --dir ./my-reservoir

# Release that named lock for the same range
res release range summarizer --from 100000 --to 100250 --dir ./my-reservoir
```

## Apply a channel-level lock for newly fetched items

```bash
res retain channel hn summarizer --dir ./my-reservoir
res release channel hn summarizer --dir ./my-reservoir
```

## List retained items for selected channels

```bash
res retained --channels hn,weather-nyc --dir ./my-reservoir
```

## Enforce storage limit

```bash
res init --dir ./my-reservoir --max-size 4096
res clean --dir ./my-reservoir
```
