import { FetchMethod } from '../types';
import { Fetcher } from './types';
import { rssFetcher } from './rss';
import { webPageFetcher } from './webpage';

const BUILTIN_FETCHERS: Record<FetchMethod, Fetcher> = {
  [FetchMethod.RSS]: rssFetcher,
  [FetchMethod.WebPage]: webPageFetcher,
};

export function getBuiltinFetcher(fetchMethod: string): Fetcher | undefined {
  return BUILTIN_FETCHERS[fetchMethod as FetchMethod];
}
