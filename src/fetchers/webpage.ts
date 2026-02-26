import TurndownService from 'turndown';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { FetchedContent } from '../types';
import { getFetchArgValue } from '../fetch-args';

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
const virtualConsole = new VirtualConsole();

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
  const html = await response.text();
  return convertWebPageHtmlToMarkdown(html);
}

export async function fetchWebPage(fetchArgs: Record<string, string> | undefined, _channelId: string): Promise<FetchedContent[]> {
  const url = getFetchArgValue(fetchArgs, 'url');
  if (!url) {
    throw new Error('web_page fetcher requires --fetch-arg url=<page-url>');
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();
  const markdown = convertWebPageHtmlToMarkdown(html, url);
  return [
    {
      title: extractTitle(html) ?? url,
      url,
      content: markdown,
    },
  ];
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : undefined;
}

