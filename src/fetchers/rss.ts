import Parser from 'rss-parser';
import { FetchedContent } from '../types';
import { fetchWebPageMarkdown } from './webpage';
import { getFetchParamValue } from '../fetch-params';
import { Fetcher } from './types';

const parser = new Parser();

function slugifyFileStem(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'content';
}

export async function fetchRSS(fetchParams: Record<string, string> | undefined, _channelId: string): Promise<FetchedContent[]> {
  const url = getFetchParamValue(fetchParams, 'url');
  if (!url) {
    throw new Error('RSS fetcher requires --fetch-param \"{\\\"url\\\":\\\"<feed-url>\\\"}\"');
  }
  const feed = await parser.parseURL(url);

  const toFetchedMarkdown = async (link?: string): Promise<string> => {
    if (!link) return '';
    try {
      return await fetchWebPageMarkdown(link);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Failed to fetch markdown content for ${link}: ${reason}`);
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
        '---',
        `url: ${item.link ?? ''}`,
        '---',
        '',
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
        content: combined,
      };
    }),
  );

  return items;
}

export const rssFetcher: Fetcher = {
  fetch: fetchRSS,
};
