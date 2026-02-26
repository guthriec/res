import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reservoir } from '../src/reservoir';
import { FetchMethod, GLOBAL_LOCK_NAME, ContentMetadata } from '../src/types';

let tmpDir: string;
let previousXdgConfigHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-test-'));
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
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
    locks: overrides.locks ?? [],
    url: overrides.url,
  };

  const slug = (item.title || 'content')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'content';

  const frontmatter = [
    '---',
    `id: ${JSON.stringify(item.id)}`,
    `channelId: ${JSON.stringify(item.channelId)}`,
    `title: ${JSON.stringify(item.title)}`,
    `fetchedAt: ${JSON.stringify(item.fetchedAt)}`,
    ...(item.url ? [`url: ${JSON.stringify(item.url)}`] : []),
    '---',
    overrides.content ?? `# ${item.title}`,
  ].join('\n');

  // Write content file
  const contentDir = path.join(channelDirForId(channelId), 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  let contentPath = path.join(contentDir, `${slug}.md`);
  let suffix = 2;
  while (fs.existsSync(contentPath)) {
    contentPath = path.join(contentDir, `${slug}-${suffix}.md`);
    suffix += 1;
  }
  fs.writeFileSync(contentPath, frontmatter);

  // Update metadata
  const metaPath = path.join(channelDirForId(channelId), 'metadata.json');
  const meta = fs.existsSync(metaPath)
    ? (JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { items: Array<{ id: string; locks: string[] }> })
    : { items: [] };
  meta.items.push({ id: item.id, locks: item.locks });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return item;
}

function contentPathForId(channelId: string, contentId: string): string | null {
  const contentDir = path.join(channelDirForId(channelId), 'content');
  if (!fs.existsSync(contentDir)) return null;
  const entries = fs.readdirSync(contentDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.md'));
  for (const entry of entries) {
    const filePath = path.join(contentDir, entry.name);
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.includes(`id: ${JSON.stringify(contentId)}`)) {
      return filePath;
    }
  }
  return null;
}

// ─── initialize ──────────────────────────────────────────────────────────────

describe('Reservoir.initialize', () => {
  it('creates the reservoir config file', () => {
    Reservoir.initialize(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.res-config.json'))).toBe(true);
  });

  it('creates channels directory', () => {
    Reservoir.initialize(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'channels'))).toBe(true);
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
    });
    expect(ch.id).toBeDefined();
    expect(ch.createdAt).toBeDefined();
    expect(ch.name).toBe('Test');
    expect(ch.retainedLocks).toEqual([]);
  });

  it('creates channel directory with content subdir', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      name: 'Test',
      fetchMethod: FetchMethod.WebPage,
      url: 'https://example.com',
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
    });
    const channelDir = channelDirForId(ch.id);
    expect(path.basename(channelDir)).toBe('my-new-feed');
    expect(ch.id).toBe('my-new-feed');
  });

  it('adds numeric suffix to both channel directory and id when slug collides', () => {
    const res = makeReservoir();
    const first = res.addChannel({
      name: 'Same Name',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/one',
    });
    const second = res.addChannel({
      name: 'Same Name',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/two',
    });

    expect(first.id).toBe('same-name');
    expect(second.id).toBe('same-name-2');
    expect(path.basename(channelDirForId(second.id))).toBe('same-name-2');
  });
});

// ─── viewChannel ─────────────────────────────────────────────────────────────

describe('viewChannel', () => {
  it('returns channel config', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'View', fetchMethod: FetchMethod.RSS, url: 'u' });
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
    res.addChannel({ name: 'A', fetchMethod: FetchMethod.RSS, url: 'u1' });
    res.addChannel({ name: 'B', fetchMethod: FetchMethod.WebPage, url: 'u2' });
    expect(res.listChannels()).toHaveLength(2);
  });
});

// ─── fetchChannel ────────────────────────────────────────────────────────────

describe('fetchChannel', () => {
  it('assigns global serial IDs across channels', async () => {
    const res = makeReservoir();

    const fetcherPath = path.join(tmpDir, 'items-fetcher.sh');
    fs.writeFileSync(
      fetcherPath,
      [
        '#!/bin/sh',
        'cat <<\'EOF\' > outs/first.md',
        '# First',
        'EOF',
        'cat <<\'EOF\' > outs/second.md',
        '# Second',
        'EOF',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(fetcherPath, 0o755);
    const registered = res.addFetcher(fetcherPath);

    const ch1 = res.addChannel({
      name: 'Custom 1',
      fetchMethod: registered.name,
    });
    const ch2 = res.addChannel({
      name: 'Custom 2',
      fetchMethod: registered.name,
    });

    const firstBatch = await res.fetchChannel(ch1.id);
    const secondBatch = await res.fetchChannel(ch2.id);

    expect(firstBatch.map((item) => item.id)).toEqual(['1', '2']);
    expect(secondBatch.map((item) => item.id)).toEqual(['3', '4']);
  });

  it('applies channel locks to newly fetched items', async () => {
    const res = makeReservoir();

    const fetcherPath = path.join(tmpDir, 'one-fetcher.sh');
    fs.writeFileSync(
      fetcherPath,
      [
        '#!/bin/sh',
        'cat <<\'EOF\' > outs/locked.md',
        '# Locked',
        'EOF',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(fetcherPath, 0o755);
    const registered = res.addFetcher(fetcherPath);

    const ch = res.addChannel({
      name: 'Locked Channel',
      fetchMethod: registered.name,
      retainedLocks: ['alpha', 'beta'],
    });

    const batch = await res.fetchChannel(ch.id);
    expect(batch).toHaveLength(1);
    expect(batch[0].locks).toEqual(['alpha', 'beta']);
  });
});

// ─── editChannel ─────────────────────────────────────────────────────────────

describe('editChannel', () => {
  it('updates channel fields', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Old', fetchMethod: FetchMethod.RSS, url: 'u' });
    const updated = res.editChannel(ch.id, { name: 'New', url: 'https://new.com' });
    expect(updated.name).toBe('New');
    expect(updated.url).toBe('https://new.com');
    // Original fields preserved
    expect(updated.id).toBe(ch.id);
  });

  it('persists changes to disk', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Old', fetchMethod: FetchMethod.RSS, url: 'u' });
    res.editChannel(ch.id, { name: 'Persisted' });
    const reloaded = Reservoir.load(tmpDir).viewChannel(ch.id);
    expect(reloaded.name).toBe('Persisted');
  });
});

// ─── deleteChannel ───────────────────────────────────────────────────────────

describe('deleteChannel', () => {
  it('removes the channel directory', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Del', fetchMethod: FetchMethod.RSS, url: 'u' });
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

// ─── listRetained ───────────────────────────────────────────────────────────-

describe('listRetained', () => {
  it('returns retained items across all channels', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'U', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, { id: 'item1', locks: [GLOBAL_LOCK_NAME] });
    addTestItem(res, ch.id, { id: 'item2', locks: [] });
    const retained = res.listRetained();
    expect(retained).toHaveLength(1);
    expect(retained[0].id).toBe('item1');
  });

  it('filters by channel IDs', () => {
    const res = makeReservoir();
    const ch1 = res.addChannel({ name: 'C1', fetchMethod: FetchMethod.RSS, url: 'u' });
    const ch2 = res.addChannel({ name: 'C2', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch1.id, { id: 'a1', locks: ['a'] });
    addTestItem(res, ch2.id, { id: 'b1', locks: ['b'] });
    const retained = res.listRetained([ch1.id]);
    expect(retained).toHaveLength(1);
    expect(retained[0].id).toBe('a1');
  });

  it('includes markdown content in returned items', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'C', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, { id: 'c1', locks: [GLOBAL_LOCK_NAME], content: '# Hello' });
    const retained = res.listRetained();
    expect(retained[0].content).toBe('# Hello');
  });

  it('returns metadata fields from markdown frontmatter', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Meta', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, {
      id: 'fm1',
      title: 'Frontmatter Item',
      fetchedAt: '2024-01-01T00:00:00.000Z',
      url: 'https://example.com/fm1',
      locks: [GLOBAL_LOCK_NAME],
      content: '# Frontmatter body',
    });

    const retained = res.listRetained();
    expect(retained).toHaveLength(1);
    expect(retained[0].id).toBe('fm1');
    expect(retained[0].title).toBe('Frontmatter Item');
    expect(retained[0].fetchedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(retained[0].url).toBe('https://example.com/fm1');
  });
});

// ─── retain/release content ─────────────────────────────────────────────────-

describe('retainContent / releaseContent', () => {
  it('retainContent adds a lock', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'M', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, { id: 'r1', locks: [] });
    res.retainContent('r1', 'pin');
    const retained = res.listRetained();
    expect(retained.find((i) => i.id === 'r1')).toBeDefined();
  });

  it('releaseContent removes a lock', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'M', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, { id: 'r2', locks: ['pin'] });
    res.releaseContent('r2', 'pin');
    const retained = res.listRetained();
    expect(retained.find((i) => i.id === 'r2')).toBeUndefined();
  });

  it('default lock name is global', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'M', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, { id: 'r3', locks: [] });
    res.retainContent('r3');
    const retained = res.listRetained();
    const item = retained.find((i) => i.id === 'r3');
    expect(item?.locks).toContain(GLOBAL_LOCK_NAME);
  });

  it('throws for non-existent content id', () => {
    const res = makeReservoir();
    expect(() => res.retainContent('no-such-id')).toThrow('Content not found');
  });
});

// ─── retain/release channel ─────────────────────────────────────────────────-

describe('retainChannel / releaseChannel', () => {
  it('retainChannel adds lock to channel config', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'M', fetchMethod: FetchMethod.RSS, url: 'u' });
    const updated = res.retainChannel(ch.id, 'pin');
    expect(updated.retainedLocks).toContain('pin');
  });

  it('releaseChannel removes lock from channel config', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'M', fetchMethod: FetchMethod.RSS, url: 'u', retainedLocks: ['pin', 'keep'] });
    const updated = res.releaseChannel(ch.id, 'pin');
    expect(updated.retainedLocks).toEqual(['keep']);
  });

  it('retainChannel defaults to global lock', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'M', fetchMethod: FetchMethod.RSS, url: 'u' });
    const updated = res.retainChannel(ch.id);
    expect(updated.retainedLocks).toContain(GLOBAL_LOCK_NAME);
  });
});

// ─── clean ─────────────────────────────────────────────────────────────────--

describe('clean', () => {
  it('does nothing when no maxSizeMB configured', () => {
    const res = makeReservoir(); // no maxSizeMB
    const ch = res.addChannel({ name: 'C', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, { id: 'del1', locks: [], content: 'big content'.repeat(100) });
    res.clean();
    // Should still exist
    expect(contentPathForId(ch.id, 'del1')).not.toBeNull();
  });

  it('deletes eligible files when over maxSizeMB', () => {
    // Use a very small maxSizeMB to force deletion
    const res = makeReservoir({ maxSizeMB: 0.000001 }); // ~1 byte
    const ch = res.addChannel({ name: 'C', fetchMethod: FetchMethod.RSS, url: 'u' });
    const t1 = new Date(2024, 0, 1).toISOString();
    const t2 = new Date(2024, 0, 2).toISOString();
    addTestItem(res, ch.id, { id: 'old1', fetchedAt: t1, locks: [], content: 'x'.repeat(2000) });
    addTestItem(res, ch.id, { id: 'new1', fetchedAt: t2, locks: [], content: 'x'.repeat(2000) });
    res.clean();
    // old1 should be deleted first (oldest), new1 may or may not be deleted
    expect(contentPathForId(ch.id, 'old1')).toBeNull();
  });

  it('does not delete items that have locks', () => {
    const res = makeReservoir({ maxSizeMB: 0.000001 });
    const ch = res.addChannel({ name: 'C', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, { id: 'keep1', locks: ['pin'], content: 'x'.repeat(5000) });
    res.clean();
    expect(contentPathForId(ch.id, 'keep1')).not.toBeNull();
  });
});

describe('content storage format', () => {
  it('uses title-based content filenames and markdown frontmatter', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      name: 'Storage',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
    });

    addTestItem(res, ch.id, {
      id: 'fmt1',
      title: 'My Test Title',
      fetchedAt: '2024-01-01T00:00:00.000Z',
      content: '# Body',
      locks: [],
    });

    const contentDir = path.join(channelDirForId(ch.id), 'content');
    const files = fs.readdirSync(contentDir);
    expect(files).toContain('my-test-title.md');

    const raw = fs.readFileSync(path.join(contentDir, 'my-test-title.md'), 'utf-8');
    expect(raw.startsWith('---\n')).toBe(true);
    expect(raw).toContain(`id: ${JSON.stringify('fmt1')}`);
    expect(raw).toContain(`title: ${JSON.stringify('My Test Title')}`);

    const metadata = JSON.parse(fs.readFileSync(path.join(channelDirForId(ch.id), 'metadata.json'), 'utf-8')) as {
      items: Array<Record<string, unknown>>;
    };
    expect(metadata.items).toEqual([{ id: 'fmt1', locks: [] }]);
  });
});

// ─── retainContentRange / releaseContentRange ──────────────────────────────

describe('retainContentRange / releaseContentRange', () => {
  it('retains items in a range by ID', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      id: 'ch1',
      name: 'Test Channel 1',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
    });

    // Items with sequential numeric IDs
    addTestItem(res, ch.id, { id: '1', fetchedAt: '2024-01-01T00:00:00.000Z', locks: [] });
    addTestItem(res, ch.id, { id: '2', fetchedAt: '2024-01-02T00:00:00.000Z', locks: [] });
    addTestItem(res, ch.id, { id: '3', fetchedAt: '2024-01-03T00:00:00.000Z', locks: [] });
    addTestItem(res, ch.id, { id: '4', fetchedAt: '2024-01-04T00:00:00.000Z', locks: [] });

    const count = res.retainContentRange({ fromId: '2', toId: '3', lockName: 'test-lock' });
    expect(count).toBe(2);

    const retained = res.listRetained();
    const item2 = retained.find((x) => x.id === '2');
    const item3 = retained.find((x) => x.id === '3');
    expect(item2?.locks).toEqual(['test-lock']);
    expect(item3?.locks).toEqual(['test-lock']);
  });

  it('retains items with open-ended range (fromId only)', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      id: 'ch2',
      name: 'Test Channel 2',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
    });

    addTestItem(res, ch.id, { id: '10', fetchedAt: '2024-01-01T00:00:00.000Z', locks: [] });
    addTestItem(res, ch.id, { id: '11', fetchedAt: '2024-01-02T00:00:00.000Z', locks: [] });
    addTestItem(res, ch.id, { id: '12', fetchedAt: '2024-01-03T00:00:00.000Z', locks: [] });

    const count = res.retainContentRange({ fromId: '11' }); // Uses GLOBAL_LOCK_NAME by default
    expect(count).toBe(2);

    const allItems = res.listRetained();
    // ID 10 has no locks, so won't appear in retained list
    expect(allItems.find((x) => x.id === '10')).toBeUndefined();
    expect(allItems.find((x) => x.id === '11')?.locks).toEqual([GLOBAL_LOCK_NAME]);
    expect(allItems.find((x) => x.id === '12')?.locks).toEqual([GLOBAL_LOCK_NAME]);
  });

  it('retains items with open-ended range (toId only)', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      id: 'ch3',
      name: 'Test Channel 3',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
    });

    addTestItem(res, ch.id, { id: '20', fetchedAt: '2024-01-01T00:00:00.000Z', locks: [] });
    addTestItem(res, ch.id, { id: '21', fetchedAt: '2024-01-02T00:00:00.000Z', locks: [] });
    addTestItem(res, ch.id, { id: '22', fetchedAt: '2024-01-03T00:00:00.000Z', locks: [] });

    const count = res.retainContentRange({ toId: '21', lockName: 'early' });
    expect(count).toBe(2);

    const allItems = res.listRetained();
    expect(allItems.find((x) => x.id === '20')?.locks).toEqual(['early']);
    expect(allItems.find((x) => x.id === '21')?.locks).toEqual(['early']);
    // ID 22 has no locks, so won't appear in retained list
    expect(allItems.find((x) => x.id === '22')).toBeUndefined();
  });

  it('filters by channel', () => {
    const res = makeReservoir();
    const ch1 = res.addChannel({
      id: 'ch1',
      name: 'Test Channel 1',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed1',
    });
    const ch2 = res.addChannel({
      id: 'ch2',
      name: 'Test Channel 2',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed2',
    });

    addTestItem(res, ch1.id, { id: '30', fetchedAt: '2024-01-01T00:00:00.000Z', locks: [] });
    addTestItem(res, ch2.id, { id: '31', fetchedAt: '2024-01-02T00:00:00.000Z', locks: [] });
    addTestItem(res, ch1.id, { id: '32', fetchedAt: '2024-01-03T00:00:00.000Z', locks: [] });

    const count = res.retainContentRange({ fromId: '30', toId: '32', channelId: ch1.id, lockName: 'ch1-lock' });
    expect(count).toBe(2);

    const allItems = res.listRetained();
    expect(allItems.find((x) => x.id === '30')?.locks).toEqual(['ch1-lock']);
    // ID 31 is in ch2, not affected by channel filter, has no locks
    expect(allItems.find((x) => x.id === '31')).toBeUndefined();
    expect(allItems.find((x) => x.id === '32')?.locks).toEqual(['ch1-lock']);
  });

  it('releases items in a range', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      id: 'ch4',
      name: 'Test Channel 4',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
    });

    addTestItem(res, ch.id, { id: '40', fetchedAt: '2024-01-01T00:00:00.000Z', locks: ['keep', 'remove'] });
    addTestItem(res, ch.id, { id: '41', fetchedAt: '2024-01-02T00:00:00.000Z', locks: ['keep', 'remove'] });
    addTestItem(res, ch.id, { id: '42', fetchedAt: '2024-01-03T00:00:00.000Z', locks: ['keep'] });

    const count = res.releaseContentRange({ fromId: '40', toId: '41', lockName: 'remove' });
    expect(count).toBe(2);

    const retained = res.listRetained();
    expect(retained.find((x) => x.id === '40')?.locks).toEqual(['keep']);
    expect(retained.find((x) => x.id === '41')?.locks).toEqual(['keep']);
    expect(retained.find((x) => x.id === '42')?.locks).toEqual(['keep']);
  });

  it('throws if fromId not found', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      id: 'ch5',
      name: 'Test Channel 5',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
    });

    addTestItem(res, ch.id, { id: '50', fetchedAt: '2024-01-01T00:00:00.000Z', locks: [] });

    expect(() => res.retainContentRange({ fromId: '999' })).toThrow('Start ID not found: 999');
  });

  it('throws if toId not found', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      id: 'ch6',
      name: 'Test Channel 6',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
    });

    addTestItem(res, ch.id, { id: '60', fetchedAt: '2024-01-01T00:00:00.000Z', locks: [] });

    expect(() => res.retainContentRange({ toId: '999' })).toThrow('End ID not found: 999');
  });

  it('throws if fromId comes after toId temporally', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      id: 'ch7',
      name: 'Test Channel 7',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
    });

    addTestItem(res, ch.id, { id: '70', fetchedAt: '2024-01-01T00:00:00.000Z', locks: [] });
    addTestItem(res, ch.id, { id: '71', fetchedAt: '2024-01-02T00:00:00.000Z', locks: [] });

    expect(() => res.retainContentRange({ fromId: '71', toId: '70' })).toThrow('Invalid range: fromId');
  });

  it('handles single-item range', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      id: 'ch8',
      name: 'Test Channel 8',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
    });

    addTestItem(res, ch.id, { id: '80', fetchedAt: '2024-01-01T00:00:00.000Z', locks: [] });
    addTestItem(res, ch.id, { id: '81', fetchedAt: '2024-01-02T00:00:00.000Z', locks: [] });

    const count = res.retainContentRange({ fromId: '81', toId: '81', lockName: 'single' });
    expect(count).toBe(1);

    const allItems = res.listRetained();
    // ID 80 has no locks, won't appear in retained list
    expect(allItems.find((x) => x.id === '80')).toBeUndefined();
    expect(allItems.find((x) => x.id === '81')?.locks).toEqual(['single']);
  });
});
