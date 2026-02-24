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
    expect(items[0].content).toContain('## Feed Content');
    expect(items[0].content).toContain('# Article One full text');
    expect(items[0].content).not.toContain('Snippet one');
    expect(items[0].content).toContain('## Fetched Page Content');
    expect(items[0].content).toContain('Fetched body');
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
    expect(items[1].content).toContain('## Fetched Page Content');
  });

  it('returns both feed and fetched content sections even on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    const { fetchRSS } = await import('../src/fetchers/rss');
    const items = await fetchRSS('https://example.com/feed', 'chan-1');
    expect(items[0].content).toContain('## Feed Content');
    expect(items[0].content).toContain('## Fetched Page Content');
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
  let scriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-custom-test-'));
    scriptPath = path.join(tmpDir, 'myscript.js');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('executes the script and returns content items', async () => {
    fs.writeFileSync(
      scriptPath,
      `module.exports = async function(channelId) {
        return [{ title: 'Custom Item', content: '# Custom', url: 'https://custom.com' }];
      };`,
    );

    const { fetchCustom } = await import('../src/fetchers/custom');
    const items = await fetchCustom(scriptPath, 'chan-3');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Custom Item');
    expect(items[0].content).toBe('# Custom');
    expect(items[0].url).toBe('https://custom.com');
  });

  it('throws when script does not export a function', async () => {
    fs.writeFileSync(scriptPath, `module.exports = { notAFunction: true };`);

    const { fetchCustom } = await import('../src/fetchers/custom');
    await expect(fetchCustom(scriptPath, 'chan-3')).rejects.toThrow('must export a function');
  });
});
