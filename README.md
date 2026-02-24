# res

TS tool to collect web content into local "reservoirs" (organized directories) of markdown files for use in AI question-answering, local note-taking, or application support

## Background fetching

- `res start --dir <path>` runs the background fetch loop in the current process (use shell backgrounding like `res start --dir <path> &` if desired).
- `res status --dir <path>` prints the current worker status (pid, heartbeat, and channel fetch/error timestamps).
- `res stop --dir <path>` stops a running background fetch loop.
- Channels are fetched in the background only when `refreshInterval` is configured.
