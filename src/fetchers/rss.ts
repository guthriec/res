import Parser from 'rss-parser';
import { v4 as uuidv4 } from 'uuid';
import { ContentItem } from '../types';

const parser = new Parser();

export async function fetchRSS(url: string, channelId: string): Promise<ContentItem[]> {
  const feed = await parser.parseURL(url);
  const now = new Date().toISOString();
  return (feed.items ?? []).map((item) => {
    const id = uuidv4();
    const rawContent = item.content ?? item['content:encoded'] ?? item.contentSnippet ?? '';
    return {
      id,
      channelId,
      title: item.title ?? '(untitled)',
      fetchedAt: now,
      read: false,
      url: item.link,
      content: rawContent,
    };
  });
}
