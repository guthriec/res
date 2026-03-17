import { FetchedContent } from "../types";

export type FetchParams = Record<string, string> | undefined;

export interface FetcherOptions {
  /** Callback to resolve existing content by URL (for deduplication) */
  resolveExistingContent?: (url: string) => { content: string } | undefined;
}

export interface Fetcher {
  fetch(
    fetchParams: FetchParams,
    channelId: string,
    options?: FetcherOptions,
  ): Promise<FetchedContent[]>;
}
