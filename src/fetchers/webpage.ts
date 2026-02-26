import TurndownService from 'turndown';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { FetchedContent } from '../types';
import { getFetchParamValue } from '../fetch-params';
import { Fetcher } from './types';

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
const virtualConsole = new VirtualConsole();

function slugifyFileStem(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'content';
}

virtualConsole.on('jsdomError', (err) => {
  if (err?.message?.includes('Could not parse CSS stylesheet')) {
    return;
  }
  console.error(err);
});

export function convertWebPageHtmlToMarkdown(html: string, sourceUrl?: string): string {
  return td.turndown(extractMainContentHtml(html, sourceUrl) ?? html);
}

export function extractMainContentHtml(html: string, sourceUrl?: string): string | null {
  try {
    const dom = new JSDOM(html, sourceUrl ? { url: sourceUrl, virtualConsole } : { virtualConsole });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const content = article?.content?.trim();
    return content && content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export async function fetchWebPageMarkdown(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type');
  const isHtml = contentType?.toLowerCase().includes('text/html') || contentType?.toLowerCase().includes('application/xhtml+xml');
  if (!isHtml) {
    throw new Error(`Unsupported content type for ${url}: ${contentType ?? 'unknown'}`);
  }
  const html = await response.text();
  return convertWebPageHtmlToMarkdown(html);
}

export async function fetchWebPage(fetchParams: Record<string, string> | undefined, _channelId: string): Promise<FetchedContent[]> {
  const url = getFetchParamValue(fetchParams, 'url');
  if (!url) {
    throw new Error('web_page fetcher requires --fetch-param \"{\\\"url\\\":\\\"<page-url>\\\"}\"');
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type');
  const isHtml = contentType?.toLowerCase().includes('text/html') || contentType?.toLowerCase().includes('application/xhtml+xml');
  if (!isHtml) {
    throw new Error(`Unsupported content type for ${url}: ${contentType ?? 'unknown'}`);
  }
  const html = await response.text();
  const markdown = convertWebPageHtmlToMarkdown(html, url);
  const title = extractTitle(html) ?? url;
  return [
    {
      sourceFileName: `${slugifyFileStem(title)}.md`,
      url,
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

