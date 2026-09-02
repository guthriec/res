import Parser from "rss-parser";
import { FetchedContent } from "../types";
import { BlockedPageError, fetchWebPageMarkdown } from "./webpage";
import { getFetchParamValue } from "../fetch-params";
import { slugify } from "../slugify";
import { Fetcher, FetcherOptions } from "./types";

const parser = new Parser<Record<string, any>, Record<string, any>>({
  customFields: {
    // Capture Atom <updated> separately: rss-parser only surfaces it as pubDate
    // when <published> is absent, so edited entries would otherwise never re-fetch.
    item: [["updated", "updated"]],
  },
});

/**
 * How long a channel stays in full-content backoff before article pages are
 * re-attempted, so the blocked flag can clear when the paywall lifts.
 */
const FULL_CONTENT_RETRY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const FULL_CONTENT_MARKER = "## Full Content";

function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function shouldFetchPageContent(
  existing: { content: string } | undefined,
  lastModified: string | undefined,
): boolean {
  if (!existing) return true; // Item doesn't exist, fetch it

  // Parse lastModified from frontmatter
  const match = existing.content.match(/lastModified:\s*([^\n]+)/);
  if (!match) return lastModified !== undefined; // No baseline yet; fetch to establish one

  if (!lastModified) return false; // No source date, conservative skip
  const stored = new Date(match[1].trim());
  return new Date(lastModified).getTime() > stored.getTime(); // Only fetch if source says it changed
}

function parseHttpValidators(
  existing: { content: string } | undefined,
): { etag?: string; httpLastModified?: string } {
  if (!existing) return {};
  const etag = existing.content.match(/^etag:\s*(.+)$/m)?.[1]?.trim();
  const httpLastModified = existing.content.match(/^httpLastModified:\s*(.+)$/m)?.[1]?.trim();
  return { etag, httpLastModified };
}

function parseLastFetchedAt(existing: { content: string } | undefined): string | undefined {
  if (!existing) return undefined;
  return existing.content.match(/^lastFetchedAt:\s*(.+)$/m)?.[1]?.trim();
}

function extractFetchedFullContent(existing: { content: string } | undefined): string {
  if (!existing) return "";
  const idx = existing.content.indexOf(FULL_CONTENT_MARKER);
  if (idx === -1) return "";
  return existing.content.slice(idx + FULL_CONTENT_MARKER.length).trimStart();
}

interface FetchedMarkdownResult {
  content: string;
  wasAttempted: boolean;
  /** True when the article was skipped because the channel is in blocked backoff */
  blockedSkipped?: boolean;
  etag?: string;
  httpLastModified?: string;
  lastFetchedAt?: string;
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
  const getChannelBlockedState = options?.getChannelBlockedState;
  const setChannelBlockedState = options?.setChannelBlockedState;

  // Per-channel "full content blocked" state. While the flag is set the fetcher
  // backs off article downloads entirely; it re-attempts at most occasionally
  // (FULL_CONTENT_RETRY_INTERVAL_MS) so the flag can clear when a paywall lifts.
  const blockedStateAtStart = getChannelBlockedState?.();
  const now = new Date().toISOString();
  const inBackoff =
    blockedStateAtStart !== undefined &&
    Date.now() - new Date(blockedStateAtStart.blockedAt).getTime() <
      FULL_CONTENT_RETRY_INTERVAL_MS;

  // Collects the first blocked URL seen this cycle so it can be surfaced as a
  // distinct "paywalled"/"blocked" fetch outcome after items are assembled.
  let blockedUrl: string | undefined;
  // True when at least one article was successfully extracted this cycle.
  let extractedOk = false;

  const toFetchedMarkdown = async (
    link: string | undefined,
    lastModified: string | undefined,
  ): Promise<FetchedMarkdownResult> => {
    if (!link) return { content: "", wasAttempted: false };

    const existing = resolveExistingContent?.(link);
    const validators = parseHttpValidators(existing);

    // Channel is flagged blocked and within the retry window: skip the download
    // entirely and reuse any previously cached full content. Producing an empty
    // Full Content section (or re-requesting the anti-bot page) is avoided.
    if (inBackoff) {
      return {
        content: extractFetchedFullContent(existing),
        wasAttempted: false,
        blockedSkipped: true,
        etag: validators.etag,
        httpLastModified: validators.httpLastModified,
        lastFetchedAt: parseLastFetchedAt(existing),
      };
    }

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
      extractedOk = true;
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
      if (error instanceof BlockedPageError) {
        // Bot-verification/paywall: remember it so the channel can back off, but
        // keep assembling the rest of the feed before surfacing the outcome.
        blockedUrl ??= error.url || link;
        return {
          content: "",
          wasAttempted: true,
          etag: validators.etag,
          httpLastModified: validators.httpLastModified,
        };
      }
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
        blockedSkipped = false,
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

      const bodyParts = [
        frontmatterLines.join("\n"),
        "",
        `# ${title}`,
        "",
        "## Snippet",
        "",
        snippet,
      ];
      // While a channel is in blocked backoff and no full content is available
      // (from the feed or a prior successful fetch), omit the empty Full Content
      // section rather than writing garbage.
      const omitFullContent =
        blockedSkipped && fullFeedContent.length === 0 && fetchedContent.length === 0;
      if (!omitFullContent) {
        bodyParts.push("", "## Full Content", "", fullContent);
      }
      const combined = bodyParts.join("\n");

      return {
        sourceFileName: `${slugify(item.title ?? item.link ?? "content")}.md`,
        content: combined,
      };
    }),
  );

  if (blockedUrl) {
    // Persist the flag so subsequent cycles back off, then surface a distinct
    // "paywalled"/"blocked" fetch outcome (via onFetchError) for consumers.
    await setChannelBlockedState?.({ blockedAt: now });
    throw new BlockedPageError(blockedUrl);
  }
  if (extractedOk && blockedStateAtStart !== undefined) {
    // A retry extracted content successfully: clear the flag so normal fetching
    // resumes for this channel.
    await setChannelBlockedState?.(undefined);
  }

  return items;
}

export const rssFetcher: Fetcher = {
  fetch: fetchRSS,
};
