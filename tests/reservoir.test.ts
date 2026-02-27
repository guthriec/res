import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reservoir } from '../src/reservoir';
import { FetchMethod, GLOBAL_LOCK_NAME, DEFAULT_DUPLICATE_STRATEGY } from '../src/types';

interface TestContentMetadata {
  id: string;
  channelId: string;
  title: string;
  fetchedAt: string;
  locks: string[];
  url?: string;
}

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
  overrides: Partial<TestContentMetadata & { content: string }> = {},
): TestContentMetadata {
  const id = overrides.id ?? `item-${Date.now()}-${Math.random()}`;
  const item: TestContentMetadata = {
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

  const body = overrides.content ?? `# ${item.title}`;

  // Write content file
  const contentDir = path.join(channelDirForId(channelId), 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  let contentPath = path.join(contentDir, `${slug}.md`);
  let suffix = 2;
  while (fs.existsSync(contentPath)) {
    contentPath = path.join(contentDir, `${slug}-${suffix}.md`);
    suffix += 1;
  }
  fs.writeFileSync(contentPath, body);

  // Update metadata
  const metaPath = path.join(channelDirForId(channelId), 'metadata.json');
  const meta = fs.existsSync(metaPath)
    ? (JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
      items: Array<{
        id: string;
        locks: string[];
        title?: string;
        fetchedAt?: string;
        url?: string;
        filePath?: string;
      }>;
    })
    : { items: [] };
  meta.items.push({
    id: item.id,
    locks: item.locks,
    fetchedAt: item.fetchedAt,
    url: item.url,
    filePath: path.join('channels', channelId, 'content', path.basename(contentPath)).replace(/\\/g, '/'),
  });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  const mapPath = path.join(tmpDir, '.res-content-id.map.json');
  const currentMap = fs.existsSync(mapPath)
    ? (JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as Record<string, string>)
    : {};
  currentMap[item.id] = path.join('channels', channelId, 'content', path.basename(contentPath)).replace(/\\/g, '/');
  fs.writeFileSync(mapPath, JSON.stringify(currentMap, null, 2));

  return item;
}

function contentPathForId(channelId: string, contentId: string): string | null {
  const mapPath = path.join(tmpDir, '.res-content-id.map.json');
  if (!fs.existsSync(mapPath)) return null;
  const idMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as Record<string, string>;
  const relativePath = idMap[contentId];
  if (!relativePath) return null;
  const resolved = path.join(tmpDir, relativePath);
  if (!resolved.includes(path.join('channels', channelId, 'content'))) {
    return null;
  }
  return fs.existsSync(resolved) ? resolved : null;
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

describe('Reservoir.loadNearest', () => {
  it('loads nearest reservoir from a nested child directory', () => {
    Reservoir.initialize(tmpDir, { maxSizeMB: 7 });
    const nestedDir = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(nestedDir, { recursive: true });

    const loaded = Reservoir.loadNearest(nestedDir);
    expect(loaded.directory).toBe(tmpDir);
    expect(loaded.reservoirConfig).toEqual({ maxSizeMB: 7 });
  });

  it('throws when no initialized reservoir exists in parent chain', () => {
    const startDir = path.join(tmpDir, 'x', 'y');
    fs.mkdirSync(startDir, { recursive: true });
    expect(() => Reservoir.loadNearest(startDir)).toThrow('No reservoir found from');
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
    expect(ch.idField).toBeUndefined();
    expect(ch.duplicateStrategy).toBe(DEFAULT_DUPLICATE_STRATEGY);
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

  it('rejects retainedLocks with comma-separated names in addChannel', () => {
    const res = makeReservoir();
    expect(() => res.addChannel({
      name: 'Bad Locks',
      fetchMethod: FetchMethod.RSS,
      url: 'u',
      retainedLocks: ['bad,name'],
    })).toThrow('commas are not allowed');
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

  it('overwrites duplicates by idField and preserves content ID', async () => {
    const res = makeReservoir();

    const fetcherPath = path.join(tmpDir, 'overwrite-id-fetcher.sh');
    fs.writeFileSync(
      fetcherPath,
      [
        '#!/bin/sh',
        'cat <<\'EOF\' > outs/item.md',
        '---',
        'externalId: "abc-123"',
        '---',
        'first version',
        'EOF',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(fetcherPath, 0o755);
    const registered = res.addFetcher(fetcherPath);

    const ch = res.addChannel({
      name: 'Overwrite by idField',
      fetchMethod: registered.name,
      idField: 'externalId',
      duplicateStrategy: 'overwrite',
    });

    const firstBatch = await res.fetchChannel(ch.id);
    const firstId = firstBatch[0].id;

    fs.writeFileSync(
      registered.destinationPath,
      [
        '#!/bin/sh',
        'cat <<\'EOF\' > outs/item.md',
        '---',
        'externalId: "abc-123"',
        '---',
        'second version',
        'EOF',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(registered.destinationPath, 0o755);

    const secondBatch = await res.fetchChannel(ch.id);
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0].id).toBe(firstId);

    const listed = res.listContent({ channelIds: [ch.id] });
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(firstId);
    expect(listed[0].content).toContain('second version');
  });

  it('falls back to filename dedupe and keep both uses -1 suffix', async () => {
    const res = makeReservoir();

    const fetcherPath = path.join(tmpDir, 'keep-both-fetcher.sh');
    fs.writeFileSync(
      fetcherPath,
      [
        '#!/bin/sh',
        'cat <<\'EOF\' > outs/dup.md',
        'no frontmatter id present',
        'EOF',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(fetcherPath, 0o755);
    const registered = res.addFetcher(fetcherPath);

    const ch = res.addChannel({
      name: 'Keep both duplicates',
      fetchMethod: registered.name,
      idField: 'externalId',
      duplicateStrategy: 'keep both',
    });

    await res.fetchChannel(ch.id);
    await res.fetchChannel(ch.id);

    const contentDir = path.join(channelDirForId(ch.id), 'content');
    const markdownFiles = fs
      .readdirSync(contentDir)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .sort();

    expect(markdownFiles).toEqual(['dup-1.md', 'dup.md']);
    expect(res.listContent({ channelIds: [ch.id] })).toHaveLength(2);
  });
});

// ─── editChannel ─────────────────────────────────────────────────────────────

describe('editChannel', () => {
  it('updates channel fields', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Old', fetchMethod: FetchMethod.RSS, fetchParams: { url: 'u' } });
    const updated = res.editChannel(ch.id, { name: 'New', fetchParams: { url: 'https://new.com' } });
    expect(updated.name).toBe('New');
    expect(updated.fetchParams.url).toBe('https://new.com');
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

  it('rejects retainedLocks with comma-separated names in editChannel', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Old', fetchMethod: FetchMethod.RSS, url: 'u' });
    expect(() => res.editChannel(ch.id, { retainedLocks: ['bad,name'] })).toThrow('commas are not allowed');
  });

  it('updates idField and duplicateStrategy', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Old', fetchMethod: FetchMethod.RSS, url: 'u' });

    const updated = res.editChannel(ch.id, {
      idField: 'externalId',
      duplicateStrategy: 'overwrite',
    });

    expect(updated.idField).toBe('externalId');
    expect(updated.duplicateStrategy).toBe('overwrite');
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

  it('returns URL from markdown frontmatter', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Meta', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, {
      id: 'fm1',
      title: 'Frontmatter Item',
      fetchedAt: '2024-01-01T00:00:00.000Z',
      url: 'https://example.com/fm1',
      locks: [GLOBAL_LOCK_NAME],
      content: [
        '---',
        'url: https://example.com/fm1',
        '---',
        '',
        '# Frontmatter body',
      ].join('\n'),
    });

    const retained = res.listRetained();
    expect(retained).toHaveLength(1);
    expect(retained[0].id).toBe('fm1');
    expect(retained[0].title).toBe('frontmatter item');
    expect(retained[0].fetchedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(retained[0].url).toBe('https://example.com/fm1');
  });
});

describe('listContent', () => {
  it('filters unretained items with retained=false', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Mixed', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, { id: 'u1', locks: [] });
    addTestItem(res, ch.id, { id: 'r1', locks: ['pin'] });

    const unretained = res.listContent({ retained: false });
    expect(unretained).toHaveLength(1);
    expect(unretained[0].id).toBe('u1');
  });

  it('filters retained items by specific lock name', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Locks', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, { id: 'l1', locks: ['alpha'] });
    addTestItem(res, ch.id, { id: 'l2', locks: ['beta'] });
    addTestItem(res, ch.id, { id: 'l3', locks: ['alpha', 'beta'] });

    const alpha = res.listContent({ retained: true, retainedBy: ['alpha'] });
    expect(alpha.map((item) => item.id)).toEqual(['l1', 'l3']);
  });

  it('filters retained items by multiple lock names', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Multi-locks', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, { id: 'm1', locks: ['alpha'] });
    addTestItem(res, ch.id, { id: 'm2', locks: ['beta'] });
    addTestItem(res, ch.id, { id: 'm3', locks: ['gamma'] });

    const filtered = res.listContent({ retained: true, retainedBy: ['alpha', 'beta'] });
    expect(filtered.map((item) => item.id)).toEqual(['m1', 'm2']);
  });

  it('supports pagination with pageSize and pageOffset', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'Paging', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, { id: 'p1', locks: ['pin'] });
    addTestItem(res, ch.id, { id: 'p2', locks: ['pin'] });
    addTestItem(res, ch.id, { id: 'p3', locks: ['pin'] });

    const page = res.listContent({ retained: true, pageOffset: 1, pageSize: 1 });
    expect(page).toHaveLength(1);
    expect(page[0].id).toBe('p2');
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

  it('rejects lock names containing commas', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'M', fetchMethod: FetchMethod.RSS, url: 'u' });
    addTestItem(res, ch.id, { id: 'r4', locks: [] });
    expect(() => res.retainContent('r4', 'bad,name')).toThrow('commas are not allowed');
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

  it('retainChannel rejects lock names containing commas', () => {
    const res = makeReservoir();
    const ch = res.addChannel({ name: 'M', fetchMethod: FetchMethod.RSS, url: 'u' });
    expect(() => res.retainChannel(ch.id, 'bad,name')).toThrow('commas are not allowed');
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
  it('uses title-based content filenames and stores IDs in global id map', () => {
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
    expect(raw).toBe('# Body');

    const idMap = JSON.parse(fs.readFileSync(path.join(tmpDir, '.res-content-id.map.json'), 'utf-8')) as Record<string, string>;
    expect(idMap.fmt1).toBe(path.join('channels', ch.id, 'content', 'my-test-title.md').replace(/\\/g, '/'));

    const metadata = JSON.parse(fs.readFileSync(path.join(channelDirForId(ch.id), 'metadata.json'), 'utf-8')) as {
      items: Array<Record<string, unknown>>;
    };
    expect(metadata.items).toEqual([
      {
        id: 'fmt1',
        locks: [],
        fetchedAt: '2024-01-01T00:00:00.000Z',
        filePath: path.join('channels', ch.id, 'content', 'my-test-title.md').replace(/\\/g, '/'),
      },
    ]);
  });

  it('removes orphaned metadata when tracked files are deleted during sync', async () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      name: 'Orphans',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
    });

    addTestItem(res, ch.id, {
      id: 'orphan1',
      title: 'Orphaned Item',
      fetchedAt: '2024-01-01T00:00:00.000Z',
      locks: ['pin'],
      content: '# Orphan content',
    });

    const filePath = contentPathForId(ch.id, 'orphan1');
    expect(filePath).not.toBeNull();
    fs.unlinkSync(filePath!);

    await res.syncContentTracking();

    const metadata = JSON.parse(fs.readFileSync(path.join(channelDirForId(ch.id), 'metadata.json'), 'utf-8')) as {
      items: Array<Record<string, unknown>>;
    };
    expect(metadata.items).toEqual([]);

    const listed = res.listContent({ channelIds: [ch.id], retained: true });
    expect(listed).toEqual([]);
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
