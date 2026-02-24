import TurndownService from 'turndown';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { FetchedContent } from '../types';

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

export function convertWebPageHtmlToMarkdown(html: string, sourceUrl?: string): string {
  return td.turndown(extractMainContentHtml(html, sourceUrl) ?? html);
}

export function extractMainContentHtml(html: string, sourceUrl?: string): string | null {
  try {
    const dom = new JSDOM(html, sourceUrl ? { url: sourceUrl } : undefined);
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

export async function fetchWebPage(url: string, _channelId: string): Promise<FetchedContent[]> {
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

