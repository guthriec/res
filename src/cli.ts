#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import { Reservoir } from './reservoir';
import { FetchMethod, RetentionStrategy } from './types';
import { getBackgroundFetcherStatus, startBackgroundFetcher, stopBackgroundFetcher } from './background-fetcher';

const program = new Command();

program
  .name('res')
  .description('Reservoir – collect web content into local markdown directories')
  .version('0.1.0');

function loadReservoir(dir: string): Reservoir {
  return Reservoir.load(path.resolve(dir));
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

// ─── channel ─────────────────────────────────────────────────────────────────

const channelCmd = program.command('channel').description('Manage channels');

channelCmd
  .command('add <name>')
  .description('Add a new channel')
  .requiredOption('--type <type>', 'type: rss | web_page | custom')
  .option('--url <url>', 'URL (for rss or web_page types)')
  .option('--script <filename>', 'script filename in scripts/ dir (for custom type)')
  .option('--rate-limit <ms>', 'rate-limit interval in milliseconds')
  .option('--refresh-interval <ms>', 'background refresh interval in milliseconds')
  .option('--retention <strategy>', 'retain_all | retain_unread | retain_none', 'retain_all')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((name: string, opts: {
    type: string; url?: string; script?: string;
    rateLimit?: string; refreshInterval?: string; retention: string; dir: string;
  }) => {
    const reservoir = loadReservoir(opts.dir);
    const channel = reservoir.addChannel({
      name,
      fetchMethod: opts.type as FetchMethod,
      url: opts.url,
      script: opts.script,
      rateLimitInterval: opts.rateLimit !== undefined ? parseInt(opts.rateLimit, 10) : undefined,
      refreshInterval: opts.refreshInterval !== undefined ? parseInt(opts.refreshInterval, 10) : undefined,
      retentionStrategy: opts.retention as RetentionStrategy,
    });
    console.log(JSON.stringify(channel, null, 2));
  });

channelCmd
  .command('edit <id>')
  .description('Edit an existing channel')
  .option('--name <name>', 'new channel name')
  .option('--type <type>', 'new type: rss | web_page | custom')
  .option('--url <url>', 'new URL')
  .option('--script <filename>', 'new script filename')
  .option('--rate-limit <ms>', 'new rate-limit interval in milliseconds')
  .option('--refresh-interval <ms>', 'new background refresh interval in milliseconds')
  .option('--retention <strategy>', 'new retention strategy: retain_all | retain_unread | retain_none')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((id: string, opts: {
    name?: string; type?: string; url?: string; script?: string;
    rateLimit?: string; refreshInterval?: string; retention?: string; dir: string;
  }) => {
    const reservoir = loadReservoir(opts.dir);
    const updates: Record<string, unknown> = {};
    if (opts.name) updates.name = opts.name;
    if (opts.type) updates.fetchMethod = opts.type as FetchMethod;
    if (opts.url) updates.url = opts.url;
    if (opts.script) updates.script = opts.script;
    if (opts.rateLimit !== undefined) updates.rateLimitInterval = parseInt(opts.rateLimit, 10);
    if (opts.refreshInterval !== undefined) updates.refreshInterval = parseInt(opts.refreshInterval, 10);
    if (opts.retention) updates.retentionStrategy = opts.retention as RetentionStrategy;
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
    const channels = loadReservoir(opts.dir).listChannels();
    console.log(JSON.stringify(channels, null, 2));
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

// ─── unread ──────────────────────────────────────────────────────────────────

program
  .command('unread')
  .description('List unread content items')
  .option('--channels <ids>', 'comma-separated channel IDs to restrict to')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((opts: { channels?: string; dir: string }) => {
    const channelIds = opts.channels ? opts.channels.split(',').map((s) => s.trim()) : undefined;
    const items = loadReservoir(opts.dir).listUnread(channelIds);
    if (items.length === 0) {
      console.log('No unread items.');
      return;
    }
    for (const item of items) {
      console.log(`[${item.id}] ${item.title} (channel: ${item.channelId})`);
    }
  });

// ─── mark ────────────────────────────────────────────────────────────────────

const markCmd = program.command('mark').description('Mark content as read or unread');

markCmd
  .command('read <id>')
  .description('Mark a content item as read')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((id: string, opts: { dir: string }) => {
    loadReservoir(opts.dir).markRead(id);
    console.log(`Marked ${id} as read`);
  });

markCmd
  .command('unread <id>')
  .description('Mark a content item as unread')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((id: string, opts: { dir: string }) => {
    loadReservoir(opts.dir).markUnread(id);
    console.log(`Marked ${id} as unread`);
  });

markCmd
  .command('read-after <id>')
  .description('Mark all content loaded after the given ID as read')
  .option('--channel <channelId>', 'restrict to a specific channel')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((id: string, opts: { channel?: string; dir: string }) => {
    loadReservoir(opts.dir).markReadAfter(id, opts.channel);
    console.log(`Marked all items after ${id} as read`);
  });

markCmd
  .command('unread-after <id>')
  .description('Mark all content loaded after the given ID as unread')
  .option('--channel <channelId>', 'restrict to a specific channel')
  .option('--dir <path>', 'reservoir directory', process.cwd())
  .action((id: string, opts: { channel?: string; dir: string }) => {
    loadReservoir(opts.dir).markUnreadAfter(id, opts.channel);
    console.log(`Marked all items after ${id} as unread`);
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
