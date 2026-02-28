# res

> [!WARNING]
> To date, this project has been mostly vibe-coded and has not been hardened. There are missing features and likely bugs, and there will likely be breaking changes.

`res` is a CLI tool and Typescript library to continually collect web content into a local "reservoir" (organized directory) of markdown files for use as a personal document corpus in RAG pipelines or in search/discovery applications.

## Documentation

- [CLI command reference](docs/cli/commands.md)
- [CI/CD and publishing](docs/ci-cd.md)

## Key Concepts

### Channels

A channel represents a content source, along with logic around fetching items from the source and converting them into markdown files.
`res` ships with one built-in channel type, for periodically fetching RSS feeds.
`res` also allows users to define their own channel types by providing custom "fetcher" executables which handle the fetching and Markdown conversion from custom sources.

Channels are managed via the `res channel` command, and the automated background fetching can be toggled via `res start` and `res stop`.

Channel configurations allow for specifying logic around refresh intervals, rate-limits, and deduplication logic.

### Content Items

Items consist of:

- a markdown file
- optional supplementary static resources

All items are stored within a directory corresponding to its channel of origin.

Each item must have a filename which is unique within its channel, which will also be the name of the item subdirectory containing related static resources.

Outside of the Markdown files, `res` tracks items by a globally unique and increasing-in-time serial number, and stores their fetch time and retention information (see below).

The `res content list` command lists content matching the given query.

### Retention Locks

Users may keep track of whether a particular content item still needs to be processed by a given workflow by placing a "retention lock" on an unprocessed item.
This lock is identified by a user-defined name (or defaults to the name "[global]"), and serves two overlapping functions:

- tags content items
- signals to the system not to delete the content item if the reservoir begins to consume too much disk space

The `res retain` and `res release` commands are used to apply or release locks, respectively. Locks may be applied automatically to new content from a particular channel via `res retain channel`, and may be added/removed in bulk to contiguous sequences of content IDs via `res retain range`.

### Custom Fetchers

The `res add-fetcher` command can be called with an executable as an argument.
The executable will be copied to `~/.config/res` or a similar platform-appropriate directory, assuming there are no duplicates.
Users can then create channels using a type identified by the name of the executable.
The executable will be run from an ephemeral directory on the channel's schedule, prepopulated with an `outs` directory at the top level.
When the user executable completes running, `res` will look in `outs` directory for Markdown files and any subdirectories with the same name as a Markdown file, track those files as `res` items, and place those files into the configured channel.
