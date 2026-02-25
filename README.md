# res

res is a CLI tool + TS library to collect web content into a local "reservoir" (organized directory) of markdown files for use in personal RAG, local note-taking, or application support.

## Key Concepts

### Channels

Channels represent data sources along with logic around fetching from them and converting data into markdown files. res ships with two built-in channel types, one for periodically fetching RSS feeds and another for scraping a particular web address. res also allows users to define their own channel types by implementing a custom Typescript function.

Channels are managed via the `res channel` commands, and the automated background fetching can be toggled via `res start` and `res stop`.

### Content Items

Items consist of:

- a Markdown file plus frontmatter, which should include a detailed summary or copy of the item's core content
- optional supplementary static resources

Items are identified by a globally unique and increasing-in-time serial number. Each item must have a title, which will be used to name the file and its supplementary resources directory. Items may also specify IDs within their channel for deduplication.

All content is stored within a directory corresponding to its channel of origin.

### Retention Locks

Users may keep track of whether a particular content item has been processed by a given workflow by placing a "retention lock" on an unprocessed item. This lock is identified by a user-defined name (or defaults to a "[global]" lock name), and serves two overlapping functions:

- keeps track of content which may yet be useful to the user, and for what reason
- signals to the system not to delete the content item if the reservoir begins to consume too much disk space

The `res retain` and `res release` commands (or the `Reservoir.retain()` and `Reservoir.release()` methods) are used to create or release locks, respectively. Locks may be applied automatically to new content from a particular channel, and may be added/removed to bulk sequences of content IDs.

The `res retained` command lists retained content matching the given query.
