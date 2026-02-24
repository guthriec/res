import * as path from 'path';
import { FetchedContent } from '../types';

/**
 * Runs a custom fetch script and returns content items.
 * The script must export (or resolve to) an array of content item-like objects
 * with at least { title, content, url? }.
 */
export async function fetchCustom(
  scriptPath: string,
  channelId: string,
): Promise<FetchedContent[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(path.resolve(scriptPath)) as
    | ((channelId: string) => Promise<FetchedContent[]>)
    | { default: (channelId: string) => Promise<FetchedContent[]> };

  const fn = typeof mod === 'function' ? mod : mod.default;
  if (typeof fn !== 'function') {
    throw new Error(`Custom script must export a function: ${scriptPath}`);
  }

  const items = await fn(channelId);
  return items.map((item) => ({
    title: item.title ?? '(untitled)',
    url: item.url,
    content: item.content ?? '',
  }));
}
