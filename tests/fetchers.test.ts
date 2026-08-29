import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// ─── RSS fetcher ──────────────────────────────────────────────────────────────

vi.mock("rss-parser", () => {
  const parserOptions: unknown[] = [];
  const mockParser = vi.fn().mockImplementation((options?: unknown) => {
    parserOptions.push(options);
    return {
      parseURL: vi.fn().mockImplementation((feedUrl: string) => {
        const items =
          feedUrl.includes("/atom-newer")
            ? [
                {
                  title: "Atom One",
                  link: "https://example.com/a/1",
                  contentSnippet: "Snippet A1",
                  updated: "2024-02-01T00:00:00Z",
                  pubDate: "2023-12-01T00:00:00Z",
                },
                {
                  title: "Atom Two",
                  link: "https://example.com/a/2",
                  contentSnippet: "Snippet A2",
                  updated: "2024-02-02T00:00:00Z",
                  pubDate: "2023-12-02T00:00:00Z",
                },
              ]
            : feedUrl.includes("/atom")
              ? [
                  {
                    title: "Atom One",
                    link: "https://example.com/a/1",
                    contentSnippet: "Snippet A1",
                    updated: "2024-01-01T00:00:00Z",
                    pubDate: "2023-12-01T00:00:00Z",
                  },
                  {
                    title: "Atom Two",
                    link: "https://example.com/a/2",
                    contentSnippet: "Snippet A2",
                    updated: "2024-01-02T00:00:00Z",
                    pubDate: "2023-12-02T00:00:00Z",
                  },
                ]
              : [
                  {
                    title: "Article One",
                    link: "https://example.com/1",
                    content: "# Article One content",
                    "content:encoded": "# Article One full text",
                    contentSnippet: "Snippet one",
                  },
                  {
                    title: "Article Two",
                    link: "https://example.com/2",
                    contentSnippet: "Snippet two",
                  },
                ];
        return Promise.resolve({ items });
      }),
    };
  });
  return { default: mockParser, __parserOptions: parserOptions };
});

describe("fetchRSS", () => {
  const mockFetch = vi.fn();

  beforeAll(() => {
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => vi.clearAllMocks());

  it("returns content items from feed", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html; charset=utf-8" },
      text: async () => "<html><body><h1>Fetched body</h1></body></html>",
    });

    const { fetchRSS } = await import("../src/fetchers/rss");
    const items = await fetchRSS({ url: "https://example.com/feed" }, "chan-1");
    expect(items).toHaveLength(2);
    expect(items[0].sourceFileName).toBe("article-one.md");
    expect(items[0].content).toContain("url: https://example.com/1");
    expect(items[0].content).not.toContain("lastFetchedAt:"); // Item 1 has feed content, not fetched
    expect(items[0].content).toContain("\n# Article One\n");
    expect(items[0].content).toContain("## Snippet");
    expect(items[0].content).toContain("Snippet one");
    expect(items[0].content).toContain("# Article One full text");
    expect(items[0].content).toContain("## Full Content");
    expect(items[0].content).not.toContain("Fetched body");

    expect(items[1].content).toContain("Fetched body");
    expect(items[1].content).toContain("lastFetchedAt:"); // Item 2 was fetched
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to contentSnippet when content is missing", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html; charset=utf-8" },
      text: async () => "<html><body><p>Fetched body</p></body></html>",
    });

    const { fetchRSS } = await import("../src/fetchers/rss");
    const items = await fetchRSS({ url: "https://example.com/feed" }, "chan-1");
    expect(items[1].content).toContain("Snippet two");
    expect(items[1].content).toContain("## Full Content");
  });

  it("returns both feed and fetched content sections even on fetch failure", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));

    const { fetchRSS } = await import("../src/fetchers/rss");
    const items = await fetchRSS({ url: "https://example.com/feed" }, "chan-1");
    expect(items[0].content).toContain("## Snippet");
    expect(items[0].content).toContain("## Full Content");
    expect(items[1].content).toContain("## Snippet");
    expect(items[1].content).toContain("## Full Content");
  });

  it("logs an error and leaves fetched markdown empty for unsupported content types", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/pdf" },
      text: async () => "pdf bytes",
    });

    const { fetchRSS } = await import("../src/fetchers/rss");
    const items = await fetchRSS({ url: "https://example.com/feed" }, "chan-1");

    expect(items[1].content).toContain("## Full Content");
    expect(items[1].content).not.toContain("pdf bytes");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Unsupported content type for https://example.com/2: application/pdf",
      ),
    );

    consoleErrorSpy.mockRestore();
  });

  describe("fetch deduplication (lastFetchedAt)", () => {
    it("includes lastFetchedAt in frontmatter for items that are fetched", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => "<html><body><h1>Fetched</h1></body></html>",
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/feed" }, "chan-1", {
        resolveExistingContent: () => undefined, // No existing items
      });

      // Article 1 has feed content, so not fetched
      expect(items[0].content).not.toContain("lastFetchedAt:");
      // Article 2 has no feed content, so is fetched and should record lastFetchedAt
      expect(items[1].content).toContain("lastFetchedAt:");
      // And should have fetched the URL
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/2",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    it("preserves existing item URL and pubDate in frontmatter", async () => {
      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/feed" }, "chan-1");

      // Both items should have URL and pubDate in frontmatter
      expect(items[0].content).toMatch(/url:\s*https:\/\/example\.com\/1/);
      expect(items[1].content).toMatch(/url:\s*https:\/\/example\.com\/2/);
    });

    it("preserves lastFetchedAt when an existing item is not re-fetched", async () => {
      const now = new Date();
      const oldPubDate = new Date(now.getTime() - 3600000).toISOString(); // 1 hr ago
      const recentFetch = new Date(now.getTime() - 300000).toISOString(); // 5 min ago

      const mockFetch = vi.fn();
      global.fetch = mockFetch as unknown as typeof fetch;

      const existingContent = `---
url: https://example.com/2
pubDate: ${oldPubDate}
lastFetchedAt: ${recentFetch}
---

# Cached content`;

      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/feed" }, "chan-1", {
        resolveExistingContent: (url) =>
          url === "https://example.com/2" ? { content: existingContent } : undefined,
      });

      // Not re-fetched...
      expect(mockFetch).not.toHaveBeenCalled();
      // ...but the previously recorded lastFetchedAt is carried forward unchanged
      expect(items[1].content).toContain(`lastFetchedAt: ${recentFetch}`);
    });

    it("re-fetches item when its pubDate is newer than lastFetchedAt", async () => {
      const now = new Date();
      const oldFetch = new Date(now.getTime() - 3600000).toISOString(); // 1 hr ago

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => "<html><body><h1>Updated</h1></body></html>",
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      // Use the same pubDate format that rss-parser provides (it doesn't provide one in mock)
      // So test the scenario: item exists with lastFetchedAt but no pubDate in existing content
      // This means next time we see it in feed, we should fetch (since no pubDate to compare)
      const existingContent = `---
url: https://example.com/2
lastFetchedAt: ${oldFetch}
---

# Old cached version`;

      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/feed" }, "chan-1", {
        resolveExistingContent: (url) =>
          url === "https://example.com/2" ? { content: existingContent } : undefined,
      });

      // Article 2 should be fetched (existing has lastFetchedAt but feed item has no pubDate)
      // When pubDate is undefined, we skip fetch to be conservative
      expect(items[1].content).not.toContain("Updated");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("records lastFetchedAt even if fetch fails", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
      global.fetch = mockFetch as unknown as typeof fetch;

      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/feed" }, "chan-1", {
        resolveExistingContent: () => undefined,
      });

      // Even though fetch failed, lastFetchedAt should be recorded for Article 2
      expect(items[1].content).toContain("lastFetchedAt:");
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe("Atom updated deduplication (lastModified)", () => {
    it("configures the parser to capture Atom <updated> as a custom field", async () => {
      const { __parserOptions } = (await import("rss-parser")) as unknown as {
        __parserOptions: unknown[];
      };
      expect(__parserOptions[0]).toEqual({
        customFields: {
          item: [["updated", "updated"]],
        },
      });
    });

    it("records Atom updated as lastModified and prefers it over pubDate", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => "<html><body><p>Fetched body</p></body></html>",
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/atom" }, "chan-1", {
        resolveExistingContent: () => undefined,
      });

      expect(items[0].content).toContain("lastModified: 2024-01-01T00:00:00.000Z");
      expect(items[0].content).toContain("pubDate: 2023-12-01T00:00:00Z");
    });

    it("skips re-fetch when Atom updated is unchanged", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => "<html><body><p>Fetched body</p></body></html>",
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const existingContent = `---
url: https://example.com/a/1
pubDate: 2023-12-01T00:00:00Z
lastModified: 2024-01-01T00:00:00.000Z
---

# Cached content`;

      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/atom" }, "chan-1", {
        resolveExistingContent: (url) =>
          url === "https://example.com/a/1" ? { content: existingContent } : undefined,
      });

      // Item 1 unchanged -> not re-fetched, no new lastFetchedAt
      expect(items[0].content).not.toContain("lastFetchedAt:");
      expect(mockFetch).not.toHaveBeenCalledWith(
        "https://example.com/a/1",
        expect.anything(),
      );
      // Item 2 has no existing content -> fetched
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/a/2",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    it("re-fetches when Atom updated moves forward", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => "<html><body><p>Updated body</p></body></html>",
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const existingContent = `---
url: https://example.com/a/1
lastModified: 2023-12-31T00:00:00.000Z
---

# Cached content`;

      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/atom" }, "chan-1", {
        resolveExistingContent: (url) =>
          url === "https://example.com/a/1" ? { content: existingContent } : undefined,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/a/1",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
      expect(items[0].content).toContain("Updated body");
      expect(items[0].content).toContain("lastFetchedAt:");
      expect(items[0].content).toContain("lastModified: 2024-01-01T00:00:00.000Z");
    });

    it("compares against updated rather than pubDate for Atom entries", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => "<html><body><p>Edited body</p></body></html>",
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      // Baseline was established from the publish date; the entry has since been
      // edited, so updated moved past pubDate. We must re-fetch.
      const existingContent = `---
url: https://example.com/a/1
pubDate: 2023-12-01T00:00:00Z
lastModified: 2023-12-01T00:00:00.000Z
---

# Cached content`;

      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/atom" }, "chan-1", {
        resolveExistingContent: (url) =>
          url === "https://example.com/a/1" ? { content: existingContent } : undefined,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/a/1",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
      expect(items[0].content).toContain("Edited body");
    });

    it("skips re-fetch when stored lastModified is newer than the feed's", async () => {
      const mockFetch = vi.fn();
      global.fetch = mockFetch as unknown as typeof fetch;

      const existingContent = `---
url: https://example.com/a/1
lastModified: 2025-01-01T00:00:00.000Z
---

# Cached content`;

      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/atom" }, "chan-1", {
        resolveExistingContent: (url) =>
          url === "https://example.com/a/1" ? { content: existingContent } : undefined,
      });

      expect(mockFetch).not.toHaveBeenCalledWith(
        "https://example.com/a/1",
        expect.anything(),
      );
    });

    it("fetches once to establish a baseline when existing content lacks lastModified", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => "<html><body><p>Baseline body</p></body></html>",
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const existingContent = `---
url: https://example.com/a/1
pubDate: 2023-12-01T00:00:00Z
lastFetchedAt: 2023-12-10T00:00:00.000Z
---

# Old cached version`;

      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/atom" }, "chan-1", {
        resolveExistingContent: (url) =>
          url === "https://example.com/a/1" ? { content: existingContent } : undefined,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/a/1",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
      expect(items[0].content).toContain("Baseline body");
      expect(items[0].content).toContain("lastModified: 2024-01-01T00:00:00.000Z");
    });
  });

  describe("HTTP conditional requests (etag / 304)", () => {
    it("sends stored validators as If-None-Match and If-Modified-Since", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "etag"
              ? "FRESH-ETAG"
              : name.toLowerCase() === "last-modified"
                ? "Mon, 01 Jan 2024 00:00:00 GMT"
                : "text/html; charset=utf-8",
        },
        text: async () => "<html><body><p>Fresh body</p></body></html>",
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const existingContent = `---
url: https://example.com/a/1
lastModified: 2023-12-31T00:00:00.000Z
etag: OLD-ETAG
httpLastModified: Sun, 31 Dec 2023 00:00:00 GMT
---

# Cached`;

      const { fetchRSS } = await import("../src/fetchers/rss");
      await fetchRSS({ url: "https://example.com/atom" }, "chan-1", {
        resolveExistingContent: (url) =>
          url === "https://example.com/a/1" ? { content: existingContent } : undefined,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/a/1",
        expect.objectContaining({
          headers: expect.objectContaining({
            "If-None-Match": "OLD-ETAG",
            "If-Modified-Since": "Sun, 31 Dec 2023 00:00:00 GMT",
          }),
        }),
      );
    });

    it("reuses cached full content on 304 and does not read the body", async () => {
      const textSpy = vi.fn();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 304,
        statusText: "Not Modified",
        headers: { get: () => null },
        text: textSpy,
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const existingContent = `---
url: https://example.com/a/1
lastModified: 2023-12-31T00:00:00.000Z
etag: OLD-ETAG
httpLastModified: Sun, 31 Dec 2023 00:00:00 GMT
---

# Cached

## Snippet

old snippet

## Full Content

Cached full body`;

      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/atom" }, "chan-1", {
        resolveExistingContent: (url) =>
          url === "https://example.com/a/1" ? { content: existingContent } : undefined,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/a/1",
        expect.objectContaining({
          headers: expect.objectContaining({ "If-None-Match": "OLD-ETAG" }),
        }),
      );
      // 304 -> body never read
      expect(textSpy).not.toHaveBeenCalled();
      // Cached content reused, validators preserved, feed lastModified advanced
      expect(items[0].content).toContain("Cached full body");
      expect(items[0].content).toContain("etag: OLD-ETAG");
      expect(items[0].content).toContain("httpLastModified: Sun, 31 Dec 2023 00:00:00 GMT");
      expect(items[0].content).toContain("lastModified: 2024-01-01T00:00:00.000Z");
      expect(items[0].content).toContain("lastFetchedAt:");
    });

    it("stores fresh etag and last-modified from a 200 response on first fetch", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "etag"
              ? "FRESH-ETAG"
              : name.toLowerCase() === "last-modified"
                ? "Mon, 01 Jan 2024 00:00:00 GMT"
                : "text/html; charset=utf-8",
        },
        text: async () => "<html><body><p>Fresh body</p></body></html>",
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const { fetchRSS } = await import("../src/fetchers/rss");
      const items = await fetchRSS({ url: "https://example.com/atom" }, "chan-1", {
        resolveExistingContent: () => undefined,
      });

      const init = mockFetch.mock.calls.find((call) => call[0] === "https://example.com/a/1")?.[1];
      // First fetch has no stored validators, so no conditional headers are sent
      expect((init as { headers?: Record<string, string> })?.headers).not.toHaveProperty(
        "If-None-Match",
      );
      expect((init as { headers?: Record<string, string> })?.headers).not.toHaveProperty(
        "If-Modified-Since",
      );
      expect(items[0].content).toContain("etag: FRESH-ETAG");
      expect(items[0].content).toContain("httpLastModified: Mon, 01 Jan 2024 00:00:00 GMT");
    });
  });

  describe("lastFetchedAt stability", () => {
    it("keeps the produced markdown byte-identical when the feed is unchanged", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "etag"
              ? "ETAG-STABLE"
              : name.toLowerCase() === "last-modified"
                ? "Sun, 31 Dec 2023 00:00:00 GMT"
                : "text/html; charset=utf-8",
        },
        text: async () => "<html><body><p>Stable body</p></body></html>",
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const { fetchRSS } = await import("../src/fetchers/rss");

      // First fetch: no existing content -> web pages fetched, lastFetchedAt written.
      const first = await fetchRSS({ url: "https://example.com/atom" }, "chan-1", {
        resolveExistingContent: () => undefined,
      });
      const firstItem = first[0].content;
      expect(firstItem).toContain("lastFetchedAt:");

      // Second fetch: unchanged feed lastModified -> no re-attempt, but the
      // previously persisted lastFetchedAt is carried forward unchanged.
      const second = await fetchRSS({ url: "https://example.com/atom" }, "chan-1", {
        resolveExistingContent: (url) =>
          url === "https://example.com/a/1" ? { content: firstItem } : undefined,
      });
      const secondItem = second[0].content;

      // Only item 2 (which has no existing content) was fetched in the second round.
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[0]).toBe("https://example.com/a/2");
      expect(secondItem).toBe(firstItem);
    });

    it("updates lastFetchedAt when the feed reports a newer date", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "etag"
              ? "ETAG-FRESH"
              : name.toLowerCase() === "last-modified"
                ? "Tue, 01 Feb 2024 00:00:00 GMT"
                : "text/html; charset=utf-8",
        },
        text: async () => "<html><body><p>Fresh body</p></body></html>",
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const { fetchRSS } = await import("../src/fetchers/rss");

      const first = await fetchRSS({ url: "https://example.com/atom" }, "chan-1", {
        resolveExistingContent: () => undefined,
      });
      const firstLastFetchedAt = first[0].content.match(/lastFetchedAt:\s*(.+)/)?.[1];

      const second = await fetchRSS({ url: "https://example.com/atom-newer" }, "chan-1", {
        resolveExistingContent: (url) =>
          url === "https://example.com/a/1" ? { content: first[0].content } : undefined,
      });
      const secondLastFetchedAt = second[0].content.match(/lastFetchedAt:\s*(.+)/)?.[1];

      expect(second[0].content).toContain("lastModified: 2024-02-01T00:00:00.000Z");
      expect(secondLastFetchedAt).toBeTruthy();
      expect(secondLastFetchedAt).not.toBe(firstLastFetchedAt);
    });
  });
});

// ─── WebPage fetcher ──────────────────────────────────────────────────────────

describe("fetchWebPage", () => {
  const mockFetch = vi.fn();

  beforeAll(() => {
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  it("returns a single content item with markdown", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html; charset=utf-8" },
      text: async () =>
        [
          "<html><head><title>Hello World</title></head><body>",
          "<nav>Navigation noise</nav>",
          "<main><article><h1>Hello</h1><p>Main content only</p></article></main>",
          "<footer>Footer noise</footer>",
          "</body></html>",
        ].join(""),
    });

    const { fetchWebPage } = await import("../src/fetchers/webpage");
    const items = await fetchWebPage({ url: "https://example.com" }, "chan-2");
    expect(items).toHaveLength(1);
    expect(items[0].sourceFileName).toBe("hello-world.md");
    expect(items[0].content).toContain("Main content only");
    expect(items[0].content).not.toContain("Footer noise");
  });

  it("falls back to URL as title when <title> is missing", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html; charset=utf-8" },
      text: async () => "<html><body><p>No title here</p></body></html>",
    });

    const { fetchWebPage } = await import("../src/fetchers/webpage");
    const items = await fetchWebPage({ url: "https://example.com/notitle" }, "chan-2");
    expect(items[0].sourceFileName).toBe("https-example-com-notitle.md");
  });

  it("throws on non-OK response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "",
    });

    const { fetchWebPage } = await import("../src/fetchers/webpage");
    await expect(fetchWebPage({ url: "https://example.com/missing" }, "chan-2")).rejects.toThrow(
      "404",
    );
  });

  it("throws on unsupported content type", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/pdf" },
      text: async () => "pdf bytes",
    });

    const { fetchWebPage } = await import("../src/fetchers/webpage");
    await expect(fetchWebPage({ url: "https://example.com/file.pdf" }, "chan-2")).rejects.toThrow(
      "Unsupported content type for https://example.com/file.pdf: application/pdf",
    );
  });
});

// ─── Custom fetcher ───────────────────────────────────────────────────────────

describe("fetchCustom", () => {
  let tmpDir: string;
  let executablePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "res-custom-test-"));
    executablePath = path.join(
      tmpDir,
      process.platform === "win32" ? "myfetcher.cmd" : "myfetcher.sh",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("executes the fetcher and returns items from outs markdown files", async () => {
    if (process.platform === "win32") {
      fs.writeFileSync(
        executablePath,
        ["@echo off", "mkdir outs 2>nul", "(echo # Custom Item)> outs\\custom-item.md"].join(
          "\r\n",
        ),
      );
    } else {
      fs.writeFileSync(
        executablePath,
        ["#!/bin/sh", "cat <<'EOF' > outs/custom-item.md", "# Custom Item", "EOF"].join("\n"),
      );
      fs.chmodSync(executablePath, 0o755);
    }

    const { fetchCustom } = await import("../src/fetchers/custom");
    const items = await fetchCustom(executablePath, "chan-3", undefined);
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain("# Custom Item");
    expect(items[0].sourceFileName).toBe("custom-item.md");
  });

  it("collects supplementary files from outs/<markdown-name> directories", async () => {
    if (process.platform === "win32") {
      fs.writeFileSync(
        executablePath,
        [
          "@echo off",
          "mkdir outs 2>nul",
          "(echo # Item)> outs\\item.md",
          "mkdir outs\\item 2>nul",
          "(echo binary)> outs\\item\\image.txt",
        ].join("\r\n"),
      );
    } else {
      fs.writeFileSync(
        executablePath,
        [
          "#!/bin/sh",
          "cat <<'EOF' > outs/item.md",
          "# Item",
          "EOF",
          "mkdir -p outs/item",
          "cat <<'EOF' > outs/item/image.txt",
          "binary",
          "EOF",
        ].join("\n"),
      );
      fs.chmodSync(executablePath, 0o755);
    }

    const { fetchCustom } = await import("../src/fetchers/custom");
    const items = await fetchCustom(executablePath, "chan-3", undefined);
    expect(items).toHaveLength(1);
    expect(items[0].supplementaryFiles).toBeDefined();
    expect(items[0].supplementaryFiles).toHaveLength(1);
    expect(items[0].supplementaryFiles![0].relativePath).toBe("image.txt");
    expect(items[0].supplementaryFiles![0].content.toString("utf-8")).toContain("binary");
  });

  it("throws when fetcher executable does not exist", async () => {
    const missingPath = path.join(tmpDir, "missing-fetcher");

    const { fetchCustom } = await import("../src/fetchers/custom");
    await expect(fetchCustom(missingPath, "chan-3", undefined)).rejects.toThrow(
      "Custom fetcher not found",
    );
  });

  it("forwards fetch arguments to the custom fetcher executable", async () => {
    if (process.platform === "win32") {
      fs.writeFileSync(
        executablePath,
        ["@echo off", "mkdir outs 2>nul", "(echo %1)> outs\arg.md"].join("\r\n"),
      );
    } else {
      fs.writeFileSync(
        executablePath,
        ["#!/bin/sh", "cat <<EOF > outs/arg.md", "$1", "EOF"].join("\n"),
      );
      fs.chmodSync(executablePath, 0o755);
    }

    const { fetchCustom } = await import("../src/fetchers/custom");
    const items = await fetchCustom(executablePath, "chan-3", { url: "https://example.com/feed" });
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain("url=https://example.com/feed");
  });
});
