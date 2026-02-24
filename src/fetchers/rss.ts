import Parser from 'rss-parser';
import { FetchedContent } from '../types';
import { fetchWebPageMarkdown } from './webpage';

const parser = new Parser();

export async function fetchRSS(url: string, _channelId: string): Promise<FetchedContent[]> {
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
        title: item.title ?? '(untitled)',
        url: item.link,
        content: combined,
      };
    }),
  );

  return items.map((item) => {
    return {
      title: item.title,
      url: item.url,
      content: item.content,
    };
  });
}
