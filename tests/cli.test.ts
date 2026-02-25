import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reservoir } from '../src/reservoir';
import { FetchMethod, GLOBAL_LOCK_NAME, ContentMetadata } from '../src/types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-cli-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReservoir(): Reservoir {
  return Reservoir.initialize(tmpDir);
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

// ─── channel list ────────────────────────────────────────────────────────────

describe('channel list output format', () => {
  it('includes relative directory path for each channel', () => {
    const res = makeReservoir();
    const ch1 = res.addChannel({
      name: 'Tech News',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/rss',
    });
    const ch2 = res.addChannel({
      name: 'Another Channel',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/rss2',
    });

    const channels = res.listChannels();
    expect(channels).toHaveLength(2);
    
    // Verify the expected format: [id] name (channels/id)
    for (const channel of channels) {
      const expectedPath = `channels/${channel.id}`;
      const fullPath = path.join(tmpDir, expectedPath);
      
      // Verify the directory actually exists at that path
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fs.statSync(fullPath).isDirectory()).toBe(true);
    }
  });

  it('channel directory path matches channel ID', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      name: 'Sample Channel',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
    });

    const channels = res.listChannels();
    const channel = channels.find((c) => c.id === ch.id);
    expect(channel).toBeDefined();
    
    // The path should be channels/<channelId>
    const expectedPath = path.join(tmpDir, 'channels', channel!.id);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });
});

// ─── retained list ─────────────────────────────────────────────────────────-

describe('retained list output format', () => {
  it('includes relative file path for each retained item', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      name: 'Test Channel',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/rss',
    });

    // Add content to the channel
    addTestItem(ch.id, { title: 'Article One', content: '# Content 1', url: 'https://example.com/1', locks: [GLOBAL_LOCK_NAME] });
    addTestItem(ch.id, { title: 'Article Two', content: '# Content 2', url: 'https://example.com/2', locks: [GLOBAL_LOCK_NAME] });

    const retained = res.listRetained();
    expect(retained).toHaveLength(2);

    for (const item of retained) {
      // Verify filePath is included
      expect(item.filePath).toBeDefined();
      expect(typeof item.filePath).toBe('string');
      
      // Verify it's a relative path
      expect(item.filePath).not.toMatch(/^\//); // Should not start with /
      expect(item.filePath).toMatch(/^channels\//); // Should start with channels/
      expect(item.filePath).toMatch(/\.md$/); // Should end with .md
      
      // Verify the file actually exists
      const fullPath = path.join(tmpDir, item.filePath!);
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fs.statSync(fullPath).isFile()).toBe(true);
    }
  });

  it('file path contains correct channel and content directory structure', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      name: 'News Feed',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/feed',
    });

    addTestItem(ch.id, { title: 'Breaking News', content: '# News content', locks: [GLOBAL_LOCK_NAME] });

    const retained = res.listRetained();
    expect(retained).toHaveLength(1);
    
    const item = retained[0];
    expect(item.filePath).toBeDefined();
    
    // Path should follow pattern: channels/<channelId>/content/<filename>.md
    const pathParts = item.filePath!.split(path.sep);
    expect(pathParts[0]).toBe('channels');
    expect(pathParts[1]).toBe(ch.id);
    expect(pathParts[2]).toBe('content');
    expect(pathParts[3]).toMatch(/\.md$/);
  });

  it('file path remains correct after retaining and releasing items', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      name: 'Updates',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/updates',
    });

    addTestItem(ch.id, { title: 'Update 1', content: '# Update', locks: [GLOBAL_LOCK_NAME] });

    const retainedBefore = res.listRetained();
    const itemId = retainedBefore[0].id;
    const originalPath = retainedBefore[0].filePath;

    // Release
    res.releaseContent(itemId, GLOBAL_LOCK_NAME);
    expect(res.listRetained()).toHaveLength(0);

    // Retain again
    res.retainContent(itemId, GLOBAL_LOCK_NAME);
    const retainedAfter = res.listRetained();
    expect(retainedAfter).toHaveLength(1);
    
    // File path should remain the same
    expect(retainedAfter[0].filePath).toBe(originalPath);
  });

  it('filters by channel and maintains correct file paths', () => {
    const res = makeReservoir();
    const ch1 = res.addChannel({
      name: 'Channel One',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/1',
    });
    const ch2 = res.addChannel({
      name: 'Channel Two',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/2',
    });

    addTestItem(ch1.id, { title: 'Item from Ch1', content: '# Ch1', locks: [GLOBAL_LOCK_NAME] });
    addTestItem(ch2.id, { title: 'Item from Ch2', content: '# Ch2', locks: [GLOBAL_LOCK_NAME] });

    const retainedCh1 = res.listRetained([ch1.id]);
    expect(retainedCh1).toHaveLength(1);
    expect(retainedCh1[0].filePath).toContain(ch1.id);
    expect(retainedCh1[0].filePath).not.toContain(ch2.id);

    const retainedCh2 = res.listRetained([ch2.id]);
    expect(retainedCh2).toHaveLength(1);
    expect(retainedCh2[0].filePath).toContain(ch2.id);
    expect(retainedCh2[0].filePath).not.toContain(ch1.id);
  });

  it('handles multiple items in same channel with unique file paths', () => {
    const res = makeReservoir();
    const ch = res.addChannel({
      name: 'Blog',
      fetchMethod: FetchMethod.RSS,
      url: 'https://example.com/blog',
    });

    addTestItem(ch.id, { title: 'Post 1', content: '# Post 1', locks: [GLOBAL_LOCK_NAME] });
    addTestItem(ch.id, { title: 'Post 2', content: '# Post 2', locks: [GLOBAL_LOCK_NAME] });
    addTestItem(ch.id, { title: 'Post 3', content: '# Post 3', locks: [GLOBAL_LOCK_NAME] });

    const retained = res.listRetained();
    expect(retained).toHaveLength(3);

    // All should have file paths
    const paths = retained.map((item) => item.filePath);
    expect(paths.every((p) => p !== undefined)).toBe(true);

    // All paths should be unique
    const uniquePaths = new Set(paths);
    expect(uniquePaths.size).toBe(3);

    // All should be in the same channel directory
    for (const p of paths) {
      expect(p).toContain(`channels/${ch.id}/content/`);
    }
  });
});
