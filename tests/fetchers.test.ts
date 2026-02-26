import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ─── RSS fetcher ──────────────────────────────────────────────────────────────

vi.mock('rss-parser', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      parseURL: vi.fn().mockResolvedValue({
      items: [
        {
          title: 'Article One',
          link: 'https://example.com/1',
          content: '# Article One content',
          'content:encoded': '# Article One full text',
          contentSnippet: 'Snippet one',
        },
        {
          title: 'Article Two',
          link: 'https://example.com/2',
          contentSnippet: 'Snippet two',
        },
      ],
      }),
    })),
  };
});

describe('fetchRSS', () => {
  const mockFetch = vi.fn();

  beforeAll(() => {
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => vi.clearAllMocks());

  it('returns content items from feed', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '<html><body><h1>Fetched body</h1></body></html>',
    });

    const { fetchRSS } = await import('../src/fetchers/rss');
    const items = await fetchRSS('https://example.com/feed', 'chan-1');
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Article One');
    expect(items[0].url).toBe('https://example.com/1');
    expect(items[0].content).toContain('## Snippet');
    expect(items[0].content).toContain('Snippet one');
    expect(items[0].content).toContain('# Article One full text');
    expect(items[0].content).toContain('## Full Content');
    expect(items[0].content).not.toContain('Fetched body');

    expect(items[1].content).toContain('Fetched body');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to contentSnippet when content is missing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '<html><body><p>Fetched body</p></body></html>',
    });

    const { fetchRSS } = await import('../src/fetchers/rss');
    const items = await fetchRSS('https://example.com/feed', 'chan-1');
    expect(items[1].content).toContain('Snippet two');
    expect(items[1].content).toContain('## Full Content');
  });

  it('returns both feed and fetched content sections even on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    const { fetchRSS } = await import('../src/fetchers/rss');
    const items = await fetchRSS('https://example.com/feed', 'chan-1');
    expect(items[0].content).toContain('## Snippet');
    expect(items[0].content).toContain('## Full Content');
    expect(items[1].content).toContain('## Snippet');
    expect(items[1].content).toContain('## Full Content');
  });
});

// ─── WebPage fetcher ──────────────────────────────────────────────────────────

describe('fetchWebPage', () => {
  const mockFetch = vi.fn();

  beforeAll(() => {
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  it('returns a single content item with markdown', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => [
        '<html><head><title>Hello World</title></head><body>',
        '<nav>Navigation noise</nav>',
        '<main><article><h1>Hello</h1><p>Main content only</p></article></main>',
        '<footer>Footer noise</footer>',
        '</body></html>',
      ].join(''),
    });

    const { fetchWebPage } = await import('../src/fetchers/webpage');
    const items = await fetchWebPage('https://example.com', 'chan-2');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Hello World');
    expect(items[0].url).toBe('https://example.com');
    expect(items[0].content).toContain('Main content only');
    expect(items[0].content).not.toContain('Footer noise');
  });

  it('falls back to URL as title when <title> is missing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '<html><body><p>No title here</p></body></html>',
    });

    const { fetchWebPage } = await import('../src/fetchers/webpage');
    const items = await fetchWebPage('https://example.com/notitle', 'chan-2');
    expect(items[0].title).toBe('https://example.com/notitle');
  });

  it('throws on non-OK response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '',
    });

    const { fetchWebPage } = await import('../src/fetchers/webpage');
    await expect(fetchWebPage('https://example.com/missing', 'chan-2')).rejects.toThrow('404');
  });
});

// ─── Custom fetcher ───────────────────────────────────────────────────────────

describe('fetchCustom', () => {
  let tmpDir: string;
  let executablePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-custom-test-'));
    executablePath = path.join(tmpDir, process.platform === 'win32' ? 'myfetcher.cmd' : 'myfetcher.sh');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('executes the fetcher and returns items from outs markdown files', async () => {
    if (process.platform === 'win32') {
      fs.writeFileSync(
        executablePath,
        [
          '@echo off',
          'mkdir outs 2>nul',
          '(echo # Custom Item)> outs\\custom-item.md',
        ].join('\r\n'),
      );
    } else {
      fs.writeFileSync(
        executablePath,
        [
          '#!/bin/sh',
          'cat <<\'EOF\' > outs/custom-item.md',
          '# Custom Item',
          'EOF',
        ].join('\n'),
      );
      fs.chmodSync(executablePath, 0o755);
    }

    const { fetchCustom } = await import('../src/fetchers/custom');
    const items = await fetchCustom(executablePath, 'chan-3');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('custom-item');
    expect(items[0].content).toContain('# Custom Item');
    expect(items[0].sourceFileName).toBe('custom-item.md');
  });

  it('collects supplementary files from outs/<markdown-name> directories', async () => {
    if (process.platform === 'win32') {
      fs.writeFileSync(
        executablePath,
        [
          '@echo off',
          'mkdir outs 2>nul',
          '(echo # Item)> outs\\item.md',
          'mkdir outs\\item 2>nul',
          '(echo binary)> outs\\item\\image.txt',
        ].join('\r\n'),
      );
    } else {
      fs.writeFileSync(
        executablePath,
        [
          '#!/bin/sh',
          'cat <<\'EOF\' > outs/item.md',
          '# Item',
          'EOF',
          'mkdir -p outs/item',
          'cat <<\'EOF\' > outs/item/image.txt',
          'binary',
          'EOF',
        ].join('\n'),
      );
      fs.chmodSync(executablePath, 0o755);
    }

    const { fetchCustom } = await import('../src/fetchers/custom');
    const items = await fetchCustom(executablePath, 'chan-3');
    expect(items).toHaveLength(1);
    expect(items[0].supplementaryFiles).toBeDefined();
    expect(items[0].supplementaryFiles).toHaveLength(1);
    expect(items[0].supplementaryFiles![0].relativePath).toBe('image.txt');
    expect(items[0].supplementaryFiles![0].content.toString('utf-8')).toContain('binary');
  });

  it('throws when fetcher executable does not exist', async () => {
    const missingPath = path.join(tmpDir, 'missing-fetcher');

    const { fetchCustom } = await import('../src/fetchers/custom');
    await expect(fetchCustom(missingPath, 'chan-3')).rejects.toThrow('Custom fetcher not found');
  });
});
