import TurndownService from "turndown";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { FetchedContent } from "../types";
import { getFetchParamValue } from "../fetch-params";
import { slugify } from "../slugify";
import { Fetcher } from "./types";

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
const virtualConsole = new VirtualConsole();

virtualConsole.on("jsdomError", (err) => {
  if (err?.message?.includes("Could not parse CSS stylesheet")) {
    return;
  }
  console.error(err);
});

export function convertWebPageHtmlToMarkdown(html: string, sourceUrl?: string): string {
  return td.turndown(extractMainContentHtml(html, sourceUrl) ?? html);
}

export function extractMainContentHtml(html: string, sourceUrl?: string): string | null {
  try {
    const dom = new JSDOM(
      html,
      sourceUrl ? { url: sourceUrl, virtualConsole } : { virtualConsole },
    );
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const content = article?.content?.trim();
    return content && content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export interface WebPageFetchOptions {
  ifNoneMatch?: string;
  ifModifiedSince?: string;
}

export interface WebPageFetchResult {
  content: string;
  /** True when the server replied 304 Not Modified and no body was read. */
  notModified: boolean;
  etag?: string;
  lastModified?: string;
}

/**
 * Thrown when a fetched page is a bot-verification / captcha challenge rather
 * than real article content (e.g. DataDome-protected pages such as WSJ).
 *
 * Callers can distinguish this from a generic network failure by the message
 * ("paywalled"/"blocked") or by checking `instanceof BlockedPageError`.
 */
export class BlockedPageError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`paywalled/blocked content for ${url}: bot-verification detected`);
    this.name = "BlockedPageError";
    this.url = url;
  }
}

/**
 * Classify a fetched response as a bot-verification/captcha page.
 *
 * DataDome answers plain HTTP fetches with a challenge page (WSJ returns 401)
 * carrying an `x-datadome: protected` header and scripts from
 * `ct.captcha-delivery.com`. Some challenges are served with a 200 status, so
 * the body is inspected as well.
 */
export function isBlockedResponse(
  status: number,
  headers: Headers | undefined,
  body: string,
): boolean {
  if (headers?.get("x-datadome") != null) return true;
  if (status === 401) return true;
  const lower = body.toLowerCase();
  return (
    lower.includes("captcha-delivery.com") ||
    lower.includes("please enable js") ||
    lower.includes("disable any ad blocker")
  );
}

async function responseTextOrThrowBlocked(
  url: string,
  response: Response,
): Promise<string> {
  const body = await response.text();
  if (isBlockedResponse(response.status, response.headers, body)) {
    throw new BlockedPageError(url);
  }
  return body;
}

export async function fetchWebPageMarkdown(
  url: string,
  options?: WebPageFetchOptions,
): Promise<WebPageFetchResult> {
  const headers: Record<string, string> = {};
  if (options?.ifNoneMatch) headers["If-None-Match"] = options.ifNoneMatch;
  if (options?.ifModifiedSince) headers["If-Modified-Since"] = options.ifModifiedSince;

  const response = await fetch(url, { headers });
  if (response.status === 304) {
    return {
      content: "",
      notModified: true,
      etag: response.headers.get("etag") ?? options?.ifNoneMatch,
      lastModified: response.headers.get("last-modified") ?? options?.ifModifiedSince,
    };
  }
  const html = await responseTextOrThrowBlocked(url, response);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type");
  const isHtml =
    contentType?.toLowerCase().includes("text/html") ||
    contentType?.toLowerCase().includes("application/xhtml+xml");
  if (!isHtml) {
    throw new Error(`Unsupported content type for ${url}: ${contentType ?? "unknown"}`);
  }
  return {
    content: convertWebPageHtmlToMarkdown(html),
    notModified: false,
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
  };
}

export async function fetchWebPage(
  fetchParams: Record<string, string> | undefined,
  _channelId: string,
  _options?: any,
): Promise<FetchedContent[]> {
  const url = getFetchParamValue(fetchParams, "url");
  if (!url) {
    throw new Error('web_page fetcher requires --fetch-param \"{\\\"url\\\":\\\"<page-url>\\\"}\"');
  }
  const response = await fetch(url);
  const html = await responseTextOrThrowBlocked(url, response);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type");
  const isHtml =
    contentType?.toLowerCase().includes("text/html") ||
    contentType?.toLowerCase().includes("application/xhtml+xml");
  if (!isHtml) {
    throw new Error(`Unsupported content type for ${url}: ${contentType ?? "unknown"}`);
  }
  const markdown = convertWebPageHtmlToMarkdown(html, url);
  const title = extractTitle(html) ?? url;
  return [
    {
      sourceFileName: `${slugify(title)}.md`,
      content: markdown,
    },
  ];
}

export const webPageFetcher: Fetcher = {
  fetch: fetchWebPage,
};

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : undefined;
}
