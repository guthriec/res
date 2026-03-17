import Parser from "rss-parser";
import { FetchedContent } from "../types";
import { fetchWebPageMarkdown } from "./webpage";
import { getFetchParamValue } from "../fetch-params";
import { Fetcher, FetcherOptions } from "./types";

const parser = new Parser();

function slugifyFileStem(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "content";
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
    itemUrl: string | undefined,
    pubDate: string | undefined,
  ): boolean => {
    if (!itemUrl) return false;
    const existing = resolveExistingContent?.(itemUrl);
    if (!existing) return true; // Item doesn't exist, fetch it

    // Parse lastFetchedAt from frontmatter
    const match = existing.content.match(/lastFetchedAt:\s*([^\n]+)/);
    if (!match) return true; // No lastFetchedAt, fetch it

    const lastFetchedAt = new Date(match[1]);
    if (!pubDate) return false; // No pubDate, skip fetch

    const pubDateObj = new Date(pubDate);
    return pubDateObj > lastFetchedAt; // Only fetch if pubDate is newer
  };

  const toFetchedMarkdown = async (
    link: string | undefined,
    pubDate: string | undefined,
  ): Promise<{ content: string; wasAttempted: boolean }> => {
    if (!link) return { content: "", wasAttempted: false };

    if (!shouldFetchPageContent(link, pubDate)) {
      return { content: "", wasAttempted: false };
    }

    try {
      const fetched = await fetchWebPageMarkdown(link);
      return { content: fetched, wasAttempted: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Failed to fetch markdown content for ${link}: ${reason}`);
      return { content: "", wasAttempted: true }; // Mark as attempted even on failure
    }
  };

  const items = await Promise.all(
    (feed.items ?? []).map(async (item) => {
      const title = (item.title ?? item.link ?? "Untitled").trim() || "Untitled";
      const fullFeedContent = (item["content:encoded"] ?? "").trim();
      const snippet = (item.contentSnippet ?? item.content ?? "").trim();
      const now = new Date().toISOString();

      // Only attempt web fetch if feed doesn't have full content
      const { content: fetchedContent, wasAttempted } =
        fullFeedContent.length === 0
          ? await toFetchedMarkdown(item.link, item.pubDate)
          : { content: "", wasAttempted: false };

      const fullContent = fullFeedContent.length > 0 ? fullFeedContent : fetchedContent;

      // Update lastFetchedAt only if we attempted a fetch (regardless of success)
      const lastFetchedAt = wasAttempted ? now : undefined;

      const frontmatterLines = [
        "---",
        `url: ${item.link ?? ""}`,
        item.pubDate ? `pubDate: ${item.pubDate}` : undefined,
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
