import TurndownService from 'turndown';
import { v4 as uuidv4 } from 'uuid';
import { ContentItem } from '../types';

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

export async function fetchWebPage(url: string, channelId: string): Promise<ContentItem[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();
  const markdown = td.turndown(html);
  const id = uuidv4();
  return [
    {
      id,
      channelId,
      title: extractTitle(html) ?? url,
      fetchedAt: new Date().toISOString(),
      read: false,
      url,
      content: markdown,
    },
  ];
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : undefined;
}
