import { FetchedContent } from '../types';

export type FetchParams = Record<string, string> | undefined;

export interface Fetcher {
  fetch(fetchParams: FetchParams, channelId: string): Promise<FetchedContent[]>;
}
