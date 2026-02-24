# res

TS tool to collect web content into local "reservoirs" (organized directories) of markdown files for use in AI question-answering, local note-taking, or application support

## Content storage format

Each channel stores content under `channels/<channel-slug>/content/`.

- Content filenames are based on title slugs (for example, `my-article-title.md`).
- If multiple items share a title slug, numeric suffixes are added (`my-article-title-2.md`, etc).
- Content IDs are global serial numbers for the reservoir (`1`, `2`, `3`, ...), allocated through a lock-protected counter to avoid collisions.
- Content metadata is stored in Markdown frontmatter in each content file:
	- `id`
	- `channelId`
	- `title`
	- `fetchedAt`
	- optional `url`
- RSS content bodies include two markdown sections:
	- `## Feed Content` (raw content provided by the RSS feed)
	- `## Fetched Page Content` (markdown converted from fetching the item URL)
- `channels/<channel-slug>/metadata.json` stores only read state (`id` + `read`).

## Background fetching

- `res start --dir <path>` runs the background fetch loop in the current process (use shell backgrounding like `res start --dir <path> &` if desired).
- `res status --dir <path>` prints the current worker status (pid, heartbeat, and channel fetch/error timestamps).
- `res stop --dir <path>` stops a running background fetch loop.
- Channels are fetched in the background only when `refreshInterval` is configured.
