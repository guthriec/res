import * as path from 'path';
import { ContentItem } from '../types';

/**
 * Runs a custom fetch script and returns content items.
 * The script must export (or resolve to) an array of ContentItem-like objects
 * with at least { title, content, url? }.
 */
export async function fetchCustom(
  scriptPath: string,
  channelId: string,
): Promise<ContentItem[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(path.resolve(scriptPath)) as
    | ((channelId: string) => Promise<Partial<ContentItem>[]>)
    | { default: (channelId: string) => Promise<Partial<ContentItem>[]> };

  const fn = typeof mod === 'function' ? mod : mod.default;
  if (typeof fn !== 'function') {
    throw new Error(`Custom script must export a function: ${scriptPath}`);
  }

  const { v4: uuidv4 } = await import('uuid');
  const now = new Date().toISOString();
  const items = await fn(channelId);
  return items.map((item) => ({
    id: uuidv4(),
    channelId,
    title: item.title ?? '(untitled)',
    fetchedAt: now,
    read: false,
    url: item.url,
    content: item.content ?? '',
  }));
}
