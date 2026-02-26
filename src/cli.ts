#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import { Reservoir } from './reservoir';
import { FetchMethod } from './types';
import { getBackgroundFetcherStatus, startBackgroundFetcher, stopBackgroundFetcher } from './background-fetcher';

const program = new Command();

program
  .name('res')
  .description('Reservoir – collect web content into local markdown directories')
  .version('0.1.0');

function loadReservoir(dir: string): Reservoir {
  return Reservoir.load(path.resolve(dir));
}

function collectOptionValue(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function normalizeStringList(values?: string[]): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return normalized.length > 0 ? [...new Set(normalized)] : [];
}

// ─── init ────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize a reservoir directory')
  .option('--dir <path>', 'directory to initialize as a reservoir', process.cwd())
  .option('--max-size <mb>', 'maximum total content size in MB')
  .action((opts: { dir: string; maxSize?: string }) => {
    const maxSizeMB = opts.maxSize !== undefined ? parseFloat(opts.maxSize) : undefined;
    Reservoir.initialize(opts.dir, { maxSizeMB });
    console.log(`Initialized reservoir at ${path.resolve(opts.dir)}`);
  });

program
  .command('add-fetcher <executable>')
  .description('Register a custom fetcher executable in the user config directory')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((executable: string, opts: { dir: string }) => {
    const registered = loadReservoir(opts.dir).addFetcher(executable);
    console.log(JSON.stringify(registered, null, 2));
  });

// ─── channel ─────────────────────────────────────────────────────────────────

const channelCmd = program.command('channel').description('Manage channels');

channelCmd
  .command('add <name>')
  .description('Add a new channel')
  .requiredOption('--type <type>', 'type: rss | web_page | <registered-fetcher-name>')
  .option('--fetch-arg <value>', 'fetcher argument (repeatable)', collectOptionValue)
  .option('--rate-limit <seconds>', 'rate-limit interval in seconds')
  .option('--refresh-interval <seconds>', 'background refresh interval in seconds')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((name: string, opts: {
    type: string; fetchArg?: string[];
    rateLimit?: string; refreshInterval?: string; dir: string;
  }) => {
    const reservoir = loadReservoir(opts.dir);
    const channel = reservoir.addChannel({
      name,
      fetchMethod: opts.type as FetchMethod,
      fetchArgs: normalizeStringList(opts.fetchArg),
      rateLimitInterval: opts.rateLimit !== undefined ? parseInt(opts.rateLimit, 10) : undefined,
      refreshInterval: opts.refreshInterval !== undefined ? parseInt(opts.refreshInterval, 10) : undefined,
    });
    console.log(JSON.stringify(channel, null, 2));
  });

channelCmd
  .command('edit <id>')
  .description('Edit an existing channel')
  .option('--name <name>', 'new channel name')
  .option('--type <type>', 'new type: rss | web_page | <registered-fetcher-name>')
  .option('--fetch-arg <value>', 'new fetcher argument list (repeatable)', collectOptionValue)
  .option('--rate-limit <seconds>', 'new rate-limit interval in seconds')
  .option('--refresh-interval <seconds>', 'new background refresh interval in seconds')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((id: string, opts: {
    name?: string; type?: string; fetchArg?: string[];
    rateLimit?: string; refreshInterval?: string; dir: string;
  }) => {
    const reservoir = loadReservoir(opts.dir);
    const updates: Record<string, unknown> = {};
    if (opts.name) updates.name = opts.name;
    if (opts.type) updates.fetchMethod = opts.type as FetchMethod;
    if (opts.fetchArg) updates.fetchArgs = normalizeStringList(opts.fetchArg);
    if (opts.rateLimit !== undefined) updates.rateLimitInterval = parseInt(opts.rateLimit, 10);
    if (opts.refreshInterval !== undefined) updates.refreshInterval = parseInt(opts.refreshInterval, 10);
    const channel = reservoir.editChannel(id, updates);
    console.log(JSON.stringify(channel, null, 2));
  });

channelCmd
  .command('delete <id>')
  .description('Delete a channel and all its content')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((id: string, opts: { dir: string }) => {
    loadReservoir(opts.dir).deleteChannel(id);
    console.log(`Deleted channel ${id}`);
  });

channelCmd
  .command('view <id>')
  .description('View channel configuration')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((id: string, opts: { dir: string }) => {
    const channel = loadReservoir(opts.dir).viewChannel(id);
    console.log(JSON.stringify(channel, null, 2));
  });

channelCmd
  .command('list')
  .description('List all channels')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((opts: { dir: string }) => {
    const reservoir = loadReservoir(opts.dir);
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
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    const reservoir = loadReservoir(opts.dir);
    await startBackgroundFetcher(reservoir.directory, {
      logger: (message) => console.log(message),
      errorLogger: (message) => console.error(message),
    });
  });

program
  .command('status')
  .description('Show background fetching process status')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((opts: { dir: string }) => {
    const dir = path.resolve(opts.dir);
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
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((opts: { dir: string }) => {
    const dir = path.resolve(opts.dir);
    const result = stopBackgroundFetcher(dir);
    console.log(result.message);
  });

// ─── retain / release ───────────────────────────────────────────────────────

const retainCmd = program.command('retain').description('Apply a lock to content or channels');

retainCmd
  .command('content <id> [lockName]')
  .description('Retain a content item by adding a lock name (defaults to [global])')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((id: string, lockName: string | undefined, opts: { dir: string }) => {
    loadReservoir(opts.dir).retainContent(id, lockName);
    console.log(`Retained content ${id}${lockName ? ` with lock ${lockName}` : ''}`);
  });

retainCmd
  .command('range [lockName]')
  .description('Retain content by ID range (defaults to [global])')
  .option('--from <id>', 'start from this ID (inclusive)')
  .option('--to <id>', 'up to this ID (inclusive)')
  .option('--channel <id>', 'restrict to this channel')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((lockName: string | undefined, opts: { from?: string; to?: string; channel?: string; dir: string }) => {
    if (!opts.from && !opts.to) {
      console.error('Error: Must specify at least --from or --to');
      process.exit(1);
    }
    const count = loadReservoir(opts.dir).retainContentRange({
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
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((id: string, lockName: string | undefined, opts: { dir: string }) => {
    const channel = loadReservoir(opts.dir).retainChannel(id, lockName);
    console.log(JSON.stringify(channel, null, 2));
  });

const releaseCmd = program.command('release').description('Remove a lock from content or channels');

releaseCmd
  .command('content <id> [lockName]')
  .description('Release a content item lock name (defaults to [global])')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((id: string, lockName: string | undefined, opts: { dir: string }) => {
    loadReservoir(opts.dir).releaseContent(id, lockName);
    console.log(`Released content ${id}${lockName ? ` lock ${lockName}` : ''}`);
  });

releaseCmd
  .command('range [lockName]')
  .description('Release content locks by ID range (defaults to [global])')
  .option('--from <id>', 'start from this ID (inclusive)')
  .option('--to <id>', 'up to this ID (inclusive)')
  .option('--channel <id>', 'restrict to this channel')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((lockName: string | undefined, opts: { from?: string; to?: string; channel?: string; dir: string }) => {
    if (!opts.from && !opts.to) {
      console.error('Error: Must specify at least --from or --to');
      process.exit(1);
    }
    const count = loadReservoir(opts.dir).releaseContentRange({
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
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((id: string, lockName: string | undefined, opts: { dir: string }) => {
    const channel = loadReservoir(opts.dir).releaseChannel(id, lockName);
    console.log(JSON.stringify(channel, null, 2));
  });

// ─── retained ──────────────────────────────────────────────────────────────

program
  .command('retained')
  .description('List retained content items (any lock applied)')
  .option('--channels <ids>', 'comma-separated channel IDs to restrict to')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((opts: { channels?: string; dir: string }) => {
    const channelIds = opts.channels ? opts.channels.split(',').map((s) => s.trim()) : undefined;
    const items = loadReservoir(opts.dir).listRetained(channelIds);
    const output = items.map(({ content, ...item }) => item);
    console.log(JSON.stringify(output, null, 2));
  });

// ─── clean ───────────────────────────────────────────────────────────────────

program
  .command('clean')
  .description('Delete content beyond the configured max size')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((opts: { dir: string }) => {
    loadReservoir(opts.dir).clean();
    console.log('Clean complete');
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
