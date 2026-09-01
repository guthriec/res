import { FetchedContent } from "../types";

export type FetchParams = Record<string, string> | undefined;

export interface ChannelBlockedState {
  /** ISO timestamp of when full-content fetching was last found blocked */
  blockedAt: string;
}

export interface FetcherOptions {
  /** Callback to resolve existing content by URL (for deduplication) */
  resolveExistingContent?: (url: string) => { content: string } | undefined;
  /**
   * Read the persisted per-channel "full content blocked" state.
   * Undefined means the channel is not currently flagged as blocked.
   */
  getChannelBlockedState?: () => ChannelBlockedState | undefined;
  /**
   * Persist (or clear, when given undefined) the per-channel
   * "full content blocked" state so the decision survives restarts.
   */
  setChannelBlockedState?: (state: ChannelBlockedState | undefined) => Promise<void> | void;
}

export interface Fetcher {
  fetch(
    fetchParams: FetchParams,
    channelId: string,
    options?: FetcherOptions,
  ): Promise<FetchedContent[]>;
}
