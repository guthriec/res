import { FetchedContent } from '../types';

export type FetchArgs = Record<string, string> | undefined;

export interface Fetcher {
  fetch(fetchArgs: FetchArgs, channelId: string): Promise<FetchedContent[]>;
}
