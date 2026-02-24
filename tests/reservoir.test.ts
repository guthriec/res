import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reservoir } from '../src/reservoir';
import { FetchMethod, RetentionStrategy, ContentMetadata } from '../src/types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReservoir(opts: { maxSizeMB?: number } = {}): Reservoir {
  return Reservoir.initialize(tmpDir, opts);
}

function channelDirForId(channelId: string): string {
  const channelsDir = path.join(tmpDir, 'channels');
  const entries = fs.readdirSync(channelsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    const dirPath = path.join(channelsDir, entry.name);
    const configPath = path.join(dirPath, 'channel.json');
    if (!fs.existsSync(configPath)) continue;
    const channel = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { id: string };
    if (channel.id === channelId) {
      return dirPath;
    }
  }
  throw new Error(`Channel not found in test helper: ${channelId}`);
}

function addTestItem(
  reservoir: Reservoir,
  channelId: string,
  overrides: Partial<ContentMetadata & { content: string }> = {},
): ContentMetadata {
  const id = overrides.id ?? `item-${Date.now()}-${Math.random()}`;
  const item: ContentMetadata = {
    id,
    channelId,
    title: overrides.title ?? 'Test Item',
    fetchedAt: overrides.fetchedAt ?? new Date().toISOString(),
    read: overrides.read ?? false,
    url: overrides.url,
  };
  // Write content file
  const contentDir = path.join(channelDirForId(channelId), 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, `${id}.md`), overrides.content ?? `# ${item.title}`);
  // Update metadata
  const metaPath = path.join(channelDirForId(channelId), 'metadata.json');
  const meta = fs.existsSync(metaPath)
    ? (JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { items: ContentMetadata[] })
    : { items: [] };
  meta.items.push(item);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return item;
}

// ─── initialize ──────────────────────────────────────────────────────────────

describe('Reservoir.initialize', () => {
  it('creates the reservoir config file', () => {
    Reservoir.initialize(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.res-config.json'))).toBe(true);
  });

  it('creates channels and scripts directories', () => {
    Reservoir.initialize(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'channels'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'scripts'))).toBe(true);
  });

  it('stores maxSizeMB in config', () => {
    Reservoir.initialize(tmpDir, { maxSizeMB: 10 });
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, '.res-config.json'), 'utf-8'));
    expect(config.maxSizeMB).toBe(10);
  });

  it('creates directory if it does not exist', () => {
    const newDir = path.join(tmpDir, 'new-reservoir');
    Reservoir.initialize(newDir);
    expect(fs.existsSync(newDir)).toBe(true);
  });

  it('exposes directory and config getters', () => {
    const res = Reservoir.initialize(tmpDir, { maxSizeMB: 5 });
    expect(res.directory).toBe(tmpDir);
    expect(res.reservoirConfig).toEqual({ maxSizeMB: 5 });
  });
});

// ─── load ────────────────────────────────────────────────────────────────────

describe('Reservoir.load', () => {
  it('loads an existing reservoir', () => {
    Reservoir.initialize(tmpDir, { maxSizeMB: 3 });
    const loaded = Reservoir.load(tmpDir);
    expect(loaded.reservoirConfig).toEqual({ maxSizeMB: 3 });
  });

  it('throws for non-existent reservoir', () => {
    expect(() => Reservoir.load(path.join(tmpDir, 'nonexistent'))).toThrow("Run 'res init' first");
  });
});

// ─── addChannel ──────────────────────────────────────────────────────────────

describe('addChannel', () => {
  it('returns a channel with id and createdAt', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      name: 'Test',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
      retentionStrategy: RetentionStrategy.RetainAll,
    });
    expect(ch.id).toBeDefined();
    expect(ch.createdAt).toBeDefined();
    expect(ch.name).toBe('Test');
  });

  it('creates channel directory with content subdir', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      name: 'Test',
      fetchMethod: FetchMethod.WebPage,
      url: 'https://example.com',
      retentionStrategy: RetentionStrategy.RetainAll,
    });
    const channelDir = channelDirForId(ch.id);
    expect(fs.existsSync(path.join(channelDir, 'content'))).toBe(true);
    expect(fs.existsSync(path.join(channelDir, 'channel.json'))).toBe(true);
    expect(fs.existsSync(path.join(channelDir, 'metadata.json'))).toBe(true);
  });

  it('names channel directory from channel name', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      name: 'My New Feed',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
      retentionStrategy: RetentionStrategy.RetainAll,
    });
    const channelDir = channelDirForId(ch.id);
    expect(path.basename(channelDir)).toBe('my-new-feed');
  });
});

// ─── viewChannel ─────────────────────────────────────────────────────────────

describe('viewChannel', () => {
  it('returns channel config', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'View', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    const viewed = res.viewChannel(ch.id);
    expect(viewed.name).toBe('View');
    expect(viewed.id).toBe(ch.id);
  });

  it('throws for unknown channel', () => {
    const res = makeReservoir();
    expect(() => res.viewChannel('unknown-id')).toThrow('Channel not found');
  });
});

// ─── listChannels ─────────────────────────────────────────────────────────────

describe('listChannels', () => {
  it('returns empty array when no channels', () => {
    const res = makeReservoir();
    expect(res.listChannels()).toEqual([]);
  });

  it('returns all added channels', () => {
    const res = makeReservoir();
    res.addChannel({ name: 'A', fetchMethod: FetchMethod.RSS, url: 'u1', retentionStrategy: RetentionStrategy.RetainAll });
    res.addChannel({ name: 'B', fetchMethod: FetchMethod.WebPage, url: 'u2', retentionStrategy: RetentionStrategy.RetainUnread });
    expect(res.listChannels()).toHaveLength(2);
  });
});

// ─── editChannel ─────────────────────────────────────────────────────────────

describe('editChannel', () => {
  it('updates channel fields', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Old', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    const updated = res.editChannel(ch.id, { name: 'New', url: 'https://new.com' });
    expect(updated.name).toBe('New');
    expect(updated.url).toBe('https://new.com');
    // Original fields preserved
    expect(updated.id).toBe(ch.id);
  });

  it('persists changes to disk', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Old', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    res.editChannel(ch.id, { name: 'Persisted' });
    const reloaded = Reservoir.load(tmpDir).viewChannel(ch.id);
    expect(reloaded.name).toBe('Persisted');
  });
});

// ─── deleteChannel ───────────────────────────────────────────────────────────

describe('deleteChannel', () => {
  it('removes the channel directory', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Del', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    const channelDir = channelDirForId(ch.id);
    expect(fs.existsSync(channelDir)).toBe(true);
    res.deleteChannel(ch.id);
    expect(fs.existsSync(channelDir)).toBe(false);
  });

  it('throws when deleting non-existent channel', () => {
    const res = makeReservoir();
    expect(() => res.deleteChannel('no-such-id')).toThrow('Channel not found');
  });
});

// ─── listUnread ──────────────────────────────────────────────────────────────

describe('listUnread', () => {
  it('returns unread items across all channels', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'U', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    addTestItem(res, ch.id, { id: 'item1', read: false });
    addTestItem(res, ch.id, { id: 'item2', read: true });
    const unread = res.listUnread();
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe('item1');
  });

  it('filters by channel IDs', () => {
    const res = makeReservoir();
    const ch1 = res.addChannel({ name: 'C1', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    const ch2 = res.addChannel({ name: 'C2', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    addTestItem(res, ch1.id, { id: 'a1', read: false });
    addTestItem(res, ch2.id, { id: 'b1', read: false });
    const unread = res.listUnread([ch1.id]);
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe('a1');
  });

  it('includes markdown content in returned items', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'C', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    addTestItem(res, ch.id, { id: 'c1', read: false, content: '# Hello' });
    const unread = res.listUnread();
    expect(unread[0].content).toBe('# Hello');
  });
});

// ─── markRead / markUnread ───────────────────────────────────────────────────

describe('markRead / markUnread', () => {
  it('markRead sets read=true', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'M', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    addTestItem(res, ch.id, { id: 'r1', read: false });
    res.markRead('r1');
    const unread = res.listUnread();
    expect(unread.find((i) => i.id === 'r1')).toBeUndefined();
  });

  it('markUnread sets read=false', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'M', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    addTestItem(res, ch.id, { id: 'r2', read: true });
    res.markUnread('r2');
    const unread = res.listUnread();
    expect(unread.find((i) => i.id === 'r2')).toBeDefined();
  });

  it('throws for non-existent content id', () => {
    const res = makeReservoir();
    expect(() => res.markRead('no-such-id')).toThrow('Content not found');
  });
});

// ─── markReadAfter / markUnreadAfter ─────────────────────────────────────────

describe('markReadAfter / markUnreadAfter', () => {
  it('marks items fetched after reference as read', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'A', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    const t0 = new Date(2024, 0, 1).toISOString();
    const t1 = new Date(2024, 0, 2).toISOString();
    const t2 = new Date(2024, 0, 3).toISOString();
    addTestItem(res, ch.id, { id: 'i0', fetchedAt: t0, read: false });
    addTestItem(res, ch.id, { id: 'i1', fetchedAt: t1, read: false });
    addTestItem(res, ch.id, { id: 'i2', fetchedAt: t2, read: false });
    res.markReadAfter('i0');
    const unread = res.listUnread();
    expect(unread.find((i) => i.id === 'i0')).toBeDefined(); // not changed
    expect(unread.find((i) => i.id === 'i1')).toBeUndefined(); // marked read
    expect(unread.find((i) => i.id === 'i2')).toBeUndefined(); // marked read
  });

  it('markUnreadAfter marks items after reference as unread', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'B', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    const t0 = new Date(2024, 0, 1).toISOString();
    const t1 = new Date(2024, 0, 2).toISOString();
    addTestItem(res, ch.id, { id: 'j0', fetchedAt: t0, read: true });
    addTestItem(res, ch.id, { id: 'j1', fetchedAt: t1, read: true });
    res.markUnreadAfter('j0');
    const unread = res.listUnread();
    expect(unread.find((i) => i.id === 'j0')).toBeUndefined(); // unchanged
    expect(unread.find((i) => i.id === 'j1')).toBeDefined(); // now unread
  });

  it('throws when reference id not found', () => {
    const res = makeReservoir();
    expect(() => res.markReadAfter('ghost-id')).toThrow('Content not found');
  });
});

// ─── clean ───────────────────────────────────────────────────────────────────

describe('clean', () => {
  it('does nothing when no maxSizeMB configured', () => {
    const res = makeReservoir(); // no maxSizeMB
    const ch = res.addChannel({ name: 'C', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainNone });
    addTestItem(res, ch.id, { id: 'del1', read: true, content: 'big content'.repeat(100) });
    res.clean();
    // Should still exist
    expect(fs.existsSync(path.join(channelDirForId(ch.id), 'content', 'del1.md'))).toBe(true);
  });

  it('deletes eligible files when over maxSizeMB', () => {
    // Use a very small maxSizeMB to force deletion
    const res = makeReservoir({ maxSizeMB: 0.000001 }); // ~1 byte
    const ch = res.addChannel({ name: 'C', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainNone });
    const t1 = new Date(2024, 0, 1).toISOString();
    const t2 = new Date(2024, 0, 2).toISOString();
    addTestItem(res, ch.id, { id: 'old1', fetchedAt: t1, read: true, content: 'x'.repeat(2000) });
    addTestItem(res, ch.id, { id: 'new1', fetchedAt: t2, read: true, content: 'x'.repeat(2000) });
    res.clean();
    // old1 should be deleted first (oldest), new1 may or may not be deleted
    expect(fs.existsSync(path.join(channelDirForId(ch.id), 'content', 'old1.md'))).toBe(false);
  });

  it('does not delete items with RetainAll strategy', () => {
    const res = makeReservoir({ maxSizeMB: 0.000001 });
    const ch = res.addChannel({ name: 'C', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainAll });
    addTestItem(res, ch.id, { id: 'keep1', read: true, content: 'x'.repeat(5000) });
    res.clean();
    expect(fs.existsSync(path.join(channelDirForId(ch.id), 'content', 'keep1.md'))).toBe(true);
  });

  it('does not delete unread items with RetainUnread strategy', () => {
    const res = makeReservoir({ maxSizeMB: 0.000001 });
    const ch = res.addChannel({ name: 'C', fetchMethod: FetchMethod.RSS, url: 'u', retentionStrategy: RetentionStrategy.RetainUnread });
    addTestItem(res, ch.id, { id: 'unread1', read: false, content: 'x'.repeat(5000) });
    res.clean();
    expect(fs.existsSync(path.join(channelDirForId(ch.id), 'content', 'unread1.md'))).toBe(true);
  });
});
