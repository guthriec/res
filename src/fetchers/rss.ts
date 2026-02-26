import Parser from 'rss-parser';
import { FetchedContent } from '../types';
import { fetchWebPageMarkdown } from './webpage';
import { getFetchArgValue } from '../fetch-args';

const parser = new Parser();

function slugifyFileStem(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'content';
}

export async function fetchRSS(fetchArgs: Record<string, string> | undefined, _channelId: string): Promise<FetchedContent[]> {
  const url = getFetchArgValue(fetchArgs, 'url');
  if (!url) {
    throw new Error('RSS fetcher requires --fetch-arg url=<feed-url>');
  }
  const feed = await parser.parseURL(url);

  const toFetchedMarkdown = async (link?: string): Promise<string> => {
    if (!link) return '';
    try {
      return await fetchWebPageMarkdown(link);
    } catch {
      return '';
    }
  };

  const items = await Promise.all(
    (feed.items ?? []).map(async (item) => {
      const fullFeedContent = (item['content:encoded'] ?? '').trim();
      const snippet = (item.contentSnippet ?? item.content ?? '').trim();
      const fetchedContent = fullFeedContent.length === 0 ? await toFetchedMarkdown(item.link) : '';
      const fullContent = fullFeedContent.length > 0 ? fullFeedContent : fetchedContent;
      const combined = [
        '## Snippet',
        '',
        snippet,
        '',
        '## Full Content',
        '',
        fullContent,
      ].join('\n');

      return {
        sourceFileName: `${slugifyFileStem(item.title ?? item.link ?? 'content')}.md`,
        url: item.link,
        content: combined,
      };
    }),
  );

  return items;
}
