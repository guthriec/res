#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import { Reservoir } from './reservoir';
import { FetchMethod } from './types';
import { getBackgroundFetcherStatus, startBackgroundFetcher, stopBackgroundFetcher } from './background-fetcher';
import { buildChannelAddConfig, buildChannelEditUpdates, ChannelAddCliOptions, ChannelEditCliOptions } from './cli-channel-options';

const program = new Command();

program
  .name('res')
  .description('Reservoir – collect web content into local markdown directories')
  .version('0.1.0')
  .option('--dir <path>', 'global reservoir directory override');

function getGlobalDir(): string | undefined {
  const opts = program.opts<{ dir?: string }>();
  if (opts.dir && opts.dir.trim().length > 0) {
    return opts.dir;
  }
  return undefined;
}

function loadReservoir(dir?: string): Reservoir {
  if (dir && dir.trim().length > 0) {
    return Reservoir.load(path.resolve(dir));
  }
  return Reservoir.loadNearest(process.cwd());
}

function parseOptionalBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`Invalid boolean value '${value}'. Expected 'true' or 'false'.`);
}

function parseNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name} value '${value}'. Expected a non-negative integer.`);
  }
  return parsed;
}

function parseRetainedByList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (values.length === 0) {
    return ['[global]'];
  }
  return values;
}

// ─── init ────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize a reservoir directory')
  .option('--max-size <mb>', 'maximum total content size in MB')
  .action((opts: { maxSize?: string }) => {
    const dir = getGlobalDir() ?? process.cwd();
    const maxSizeMB = opts.maxSize !== undefined ? parseFloat(opts.maxSize) : undefined;
    Reservoir.initialize(dir, { maxSizeMB });
    console.log(`Initialized reservoir at ${path.resolve(dir)}`);
  });

program
  .command('add-fetcher <executable>')
  .description('Register a custom fetcher executable in the user config directory')
  .action((executable: string) => {
    const registered = loadReservoir(getGlobalDir()).addFetcher(executable);
    console.log(JSON.stringify(registered, null, 2));
  });

// ─── channel ─────────────────────────────────────────────────────────────────

const channelCmd = program.command('channel').description('Manage channels');

channelCmd
  .command('add <name>')
  .description('Add a new channel')
  .requiredOption('--type <type>', 'type: rss | web_page | <registered-fetcher-name>')
  .option('--fetch-param <json>', 'fetcher params JSON merge patch object')
  .option('--rate-limit <seconds>', 'rate-limit interval in seconds')
  .option('--refresh-interval <seconds>', 'background refresh interval in seconds')
  .option('--id-field <field>', 'optional field name in fetched item content frontmatter used for deduplication')
  .option('--duplicate-strategy <strategy>', 'duplicate handling: overwrite | keep both')
  .action((name: string, opts: ChannelAddCliOptions) => {
    const reservoir = loadReservoir(getGlobalDir());
    const channel = reservoir.addChannel(buildChannelAddConfig(name, opts));
    console.log(JSON.stringify(channel, null, 2));
  });

channelCmd
  .command('edit <id>')
  .description('Edit an existing channel')
  .option('--name <name>', 'new channel name')
  .option('--type <type>', 'new type: rss | web_page | <registered-fetcher-name>')
  .option('--fetch-param <json>', 'fetcher params JSON merge patch object')
  .option('--rate-limit <seconds>', 'new rate-limit interval in seconds')
  .option('--refresh-interval <seconds>', 'new background refresh interval in seconds')
  .option('--id-field <field>', 'new field name in fetched item content frontmatter used for deduplication')
  .option('--duplicate-strategy <strategy>', 'new duplicate handling: overwrite | keep both')
  .action((id: string, opts: ChannelEditCliOptions) => {
    const reservoir = loadReservoir(getGlobalDir());
    const existing = reservoir.viewChannel(id);
    const updates = buildChannelEditUpdates(existing.fetchParams, opts);
    const channel = reservoir.editChannel(id, updates);
    console.log(JSON.stringify(channel, null, 2));
  });

channelCmd
  .command('delete <id>')
  .description('Delete a channel and all its content')
  .action((id: string) => {
    loadReservoir(getGlobalDir()).deleteChannel(id);
    console.log(`Deleted channel ${id}`);
  });

channelCmd
  .command('view <id>')
  .description('View channel configuration')
  .action((id: string) => {
    const channel = loadReservoir(getGlobalDir()).viewChannel(id);
    console.log(JSON.stringify(channel, null, 2));
  });

channelCmd
  .command('list')
  .description('List all channels')
  .action(() => {
    const reservoir = loadReservoir(getGlobalDir());
    const channels = reservoir.listChannels();
    const output = channels.map((channel) => ({
      ...channel,
      path: `channels/${channel.id}`,
    }));
    console.log(JSON.stringify(output, null, 2));
  });

// ─── background fetcher ─────────────────────────────────────────────────────

program
  .command('start')
  .description('Run background fetching in this process')
  .option('--log-level <level>', 'logging verbosity: error | info | debug | silent')
  .action(async (opts: { logLevel?: 'error' | 'info' | 'debug' | 'silent' }) => {
    const reservoir = loadReservoir(getGlobalDir());
    await startBackgroundFetcher(reservoir.directory, {
      logLevel: opts.logLevel,
      logger: (message) => console.log(message),
      errorLogger: (message) => console.error(message),
    });
  });

program
  .command('status')
  .description('Show background fetching process status')
  .action(() => {
    const reservoir = loadReservoir(getGlobalDir());
    const dir = reservoir.directory;
    const status = getBackgroundFetcherStatus(dir);
    if (!status.running) {
      console.log('Background fetcher is not running');
      return;
    }
    console.log(JSON.stringify(status, null, 2));
  });

program
  .command('stop')
  .description('Stop background fetching process')
  .action(() => {
    const reservoir = loadReservoir(getGlobalDir());
    const dir = reservoir.directory;
    const result = stopBackgroundFetcher(dir);
    console.log(result.message);
  });

// ─── retain / release ───────────────────────────────────────────────────────

const retainCmd = program.command('retain').description('Apply a lock to content or channels');

retainCmd
  .command('content <id> [lockName]')
  .description('Retain a content item by adding a lock name (defaults to [global])')
  .action((id: string, lockName: string | undefined) => {
    loadReservoir(getGlobalDir()).retainContent(id, lockName);
    console.log(`Retained content ${id}${lockName ? ` with lock ${lockName}` : ''}`);
  });

retainCmd
  .command('range [lockName]')
  .description('Retain content by ID range (defaults to [global])')
  .option('--from <id>', 'start from this ID (inclusive)')
  .option('--to <id>', 'up to this ID (inclusive)')
  .option('--channel <id>', 'restrict to this channel')
  .action((lockName: string | undefined, opts: { from?: string; to?: string; channel?: string }) => {
    if (!opts.from && !opts.to) {
      console.error('Error: Must specify at least --from or --to');
      process.exit(1);
    }
    const count = loadReservoir(getGlobalDir()).retainContentRange({
      fromId: opts.from,
      toId: opts.to,
      channelId: opts.channel,
      lockName,
    });
    console.log(`Retained ${count} item(s)${lockName ? ` with lock ${lockName}` : ''}`);
  });

retainCmd
  .command('channel <id> [lockName]')
  .description('Retain a channel by adding a lock applied to newly fetched content')
  .action((id: string, lockName: string | undefined) => {
    const channel = loadReservoir(getGlobalDir()).retainChannel(id, lockName);
    console.log(JSON.stringify(channel, null, 2));
  });

const releaseCmd = program.command('release').description('Remove a lock from content or channels');

releaseCmd
  .command('content <id> [lockName]')
  .description('Release a content item lock name (defaults to [global])')
  .action((id: string, lockName: string | undefined) => {
    loadReservoir(getGlobalDir()).releaseContent(id, lockName);
    console.log(`Released content ${id}${lockName ? ` lock ${lockName}` : ''}`);
  });

releaseCmd
  .command('range [lockName]')
  .description('Release content locks by ID range (defaults to [global])')
  .option('--from <id>', 'start from this ID (inclusive)')
  .option('--to <id>', 'up to this ID (inclusive)')
  .option('--channel <id>', 'restrict to this channel')
  .action((lockName: string | undefined, opts: { from?: string; to?: string; channel?: string }) => {
    if (!opts.from && !opts.to) {
      console.error('Error: Must specify at least --from or --to');
      process.exit(1);
    }
    const count = loadReservoir(getGlobalDir()).releaseContentRange({
      fromId: opts.from,
      toId: opts.to,
      channelId: opts.channel,
      lockName,
    });
    console.log(`Released ${count} item(s)${lockName ? ` lock ${lockName}` : ''}`);
  });

releaseCmd
  .command('channel <id> [lockName]')
  .description('Release a channel lock that applies to newly fetched content')
  .action((id: string, lockName: string | undefined) => {
    const channel = loadReservoir(getGlobalDir()).releaseChannel(id, lockName);
    console.log(JSON.stringify(channel, null, 2));
  });

// ─── content ───────────────────────────────────────────────────────────────

const contentCmd = program.command('content').description('Manage content items');

contentCmd
  .command('list')
  .description('List content items with filtering and pagination')
  .option('--channels <ids>', 'comma-separated channel IDs to restrict to')
  .option('--retained <true|false>', 'filter by retained status (default: true)')
  .option('--retained-by <names>', 'filter retained content by lock name(s), comma-separated')
  .option('--page-size <count>', 'maximum number of items to return')
  .option('--page-offset <count>', 'number of matching items to skip before returning results')
  .action((opts: {
    channels?: string;
    retained?: string;
    retainedBy?: string;
    pageSize?: string;
    pageOffset?: string;
  }) => {
    const retained = parseOptionalBoolean(opts.retained, true);
    const retainedBy = parseRetainedByList(opts.retainedBy);
    if (retainedBy && !retained) {
      throw new Error('--retained-by requires --retained true');
    }
    const pageSize = parseNonNegativeInteger(opts.pageSize, 'page-size');
    const pageOffset = parseNonNegativeInteger(opts.pageOffset, 'page-offset') ?? 0;
    const channelIds = opts.channels
      ? opts.channels.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;

    const items = loadReservoir(getGlobalDir()).listContent({
      channelIds,
      retained,
      retainedBy,
      pageSize,
      pageOffset,
    });
    const output = items.map(({ content, ...item }) => item);
    console.log(JSON.stringify(output, null, 2));
  });

// ─── clean ───────────────────────────────────────────────────────────────────

program
  .command('clean')
  .description('Delete content beyond the configured max size')
  .action(() => {
    loadReservoir(getGlobalDir()).clean();
    console.log('Clean complete');
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
