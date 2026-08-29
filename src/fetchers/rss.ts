import Parser from "rss-parser";
import { FetchedContent } from "../types";
import { fetchWebPageMarkdown } from "./webpage";
import { getFetchParamValue } from "../fetch-params";
import { Fetcher, FetcherOptions } from "./types";

const parser = new Parser<Record<string, any>, Record<string, any>>({
  customFields: {
    // Capture Atom <updated> separately: rss-parser only surfaces it as pubDate
    // when <published> is absent, so edited entries would otherwise never re-fetch.
    item: [["updated", "updated"]],
  },
});

function slugifyFileStem(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "content";
}

function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export async function fetchRSS(
  fetchParams: Record<string, string> | undefined,
  _channelId: string,
  options?: FetcherOptions,
): Promise<FetchedContent[]> {
  const url = getFetchParamValue(fetchParams, "url");
  if (!url) {
    throw new Error('RSS fetcher requires --fetch-param "{\\"url\\":\\"<feed-url>\\"}"');
  }
  const feed = await parser.parseURL(url);
  const resolveExistingContent = options?.resolveExistingContent;

  const shouldFetchPageContent = (
    existing: { content: string } | undefined,
    lastModified: string | undefined,
  ): boolean => {
    if (!existing) return true; // Item doesn't exist, fetch it

    // Parse lastModified from frontmatter
    const match = existing.content.match(/lastModified:\s*([^\n]+)/);
    if (!match) return lastModified !== undefined; // No baseline yet; fetch to establish one

    if (!lastModified) return false; // No source date, conservative skip
    const stored = new Date(match[1].trim());
    return new Date(lastModified).getTime() > stored.getTime(); // Only fetch if source says it changed
  };

  const parseHttpValidators = (
    existing: { content: string } | undefined,
  ): { etag?: string; httpLastModified?: string } => {
    if (!existing) return {};
    const etag = existing.content.match(/^etag:\s*(.+)$/m)?.[1]?.trim();
    const httpLastModified = existing.content.match(/^httpLastModified:\s*(.+)$/m)?.[1]?.trim();
    return { etag, httpLastModified };
  };

  const parseLastFetchedAt = (existing: { content: string } | undefined): string | undefined => {
    if (!existing) return undefined;
    return existing.content.match(/^lastFetchedAt:\s*(.+)$/m)?.[1]?.trim();
  };

  const extractFetchedFullContent = (existing: { content: string } | undefined): string => {
    if (!existing) return "";
    const marker = "## Full Content";
    const idx = existing.content.indexOf(marker);
    if (idx === -1) return "";
    return existing.content.slice(idx + marker.length).trimStart();
  };

  const toFetchedMarkdown = async (
    link: string | undefined,
    lastModified: string | undefined,
  ): Promise<{
    content: string;
    wasAttempted: boolean;
    etag?: string;
    httpLastModified?: string;
    lastFetchedAt?: string;
  }> => {
    if (!link) return { content: "", wasAttempted: false };

    const existing = resolveExistingContent?.(link);
    const validators = parseHttpValidators(existing);
    if (!shouldFetchPageContent(existing, lastModified)) {
      // No attempt this cycle: carry forward the cached content and persisted
      // frontmatter so the produced markdown stays byte-identical across fetches.
      return {
        content: extractFetchedFullContent(existing),
        wasAttempted: false,
        etag: validators.etag,
        httpLastModified: validators.httpLastModified,
        lastFetchedAt: parseLastFetchedAt(existing),
      };
    }

    try {
      const fetched = await fetchWebPageMarkdown(link, {
        ifNoneMatch: validators.etag,
        ifModifiedSince: validators.httpLastModified,
      });
      if (fetched.notModified) {
        // Body unchanged; reuse the cached content instead of re-downloading.
        return {
          content: extractFetchedFullContent(existing),
          wasAttempted: true,
          etag: fetched.etag ?? validators.etag,
          httpLastModified: fetched.lastModified ?? validators.httpLastModified,
        };
      }
      return {
        content: fetched.content,
        wasAttempted: true,
        etag: fetched.etag,
        httpLastModified: fetched.lastModified,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Failed to fetch markdown content for ${link}: ${reason}`);
      // Keep prior validators so a later fetch can still be conditional.
      return {
        content: "",
        wasAttempted: true,
        etag: validators.etag,
        httpLastModified: validators.httpLastModified,
      };
    }
  };

  const items = await Promise.all(
    (feed.items ?? []).map(async (item) => {
      const title = (item.title ?? item.link ?? "Untitled").trim() || "Untitled";
      const fullFeedContent = (item["content:encoded"] ?? "").trim();
      const snippet = (item.contentSnippet ?? item.content ?? "").trim();
      const now = new Date().toISOString();
      // Atom <updated> is the authoritative last-change signal; fall back to
      // pubDate (which rss-parser sets from <published> or <updated>) and isoDate.
      const lastModified =
        toIsoDate(item.updated) ?? toIsoDate(item.pubDate) ?? toIsoDate(item.isoDate);

      // Only attempt web fetch if feed doesn't have full content
      const {
        content: fetchedContent,
        wasAttempted,
        etag,
        httpLastModified,
        lastFetchedAt: existingLastFetchedAt,
      } =
        fullFeedContent.length === 0
          ? await toFetchedMarkdown(item.link, lastModified)
          : { content: "", wasAttempted: false };

      const fullContent = fullFeedContent.length > 0 ? fullFeedContent : fetchedContent;

      // Update lastFetchedAt only when we attempted a fetch; otherwise keep the
      // previously persisted value so the file doesn't oscillate across cycles.
      const lastFetchedAt = wasAttempted ? now : existingLastFetchedAt;

      const frontmatterLines = [
        "---",
        `url: ${item.link ?? ""}`,
        item.pubDate ? `pubDate: ${item.pubDate}` : undefined,
        lastModified ? `lastModified: ${lastModified}` : undefined,
        etag ? `etag: ${etag}` : undefined,
        httpLastModified ? `httpLastModified: ${httpLastModified}` : undefined,
        lastFetchedAt ? `lastFetchedAt: ${lastFetchedAt}` : undefined,
        "---",
      ].filter(Boolean);

      const combined = [
        frontmatterLines.join("\n"),
        "",
        `# ${title}`,
        "",
        "## Snippet",
        "",
        snippet,
        "",
        "## Full Content",
        "",
        fullContent,
      ].join("\n");

      return {
        sourceFileName: `${slugifyFileStem(item.title ?? item.link ?? "content")}.md`,
        content: combined,
      };
    }),
  );

  return items;
}

export const rssFetcher: Fetcher = {
  fetch: fetchRSS,
};
