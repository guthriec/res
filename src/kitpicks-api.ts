import type { Channel } from "./types";

export interface KitpicksSourceChannelInput {
  name: string;
  url: string;
  refreshIntervalSeconds: number;
}

export interface KitpicksLockedContent {
  id: string;
  channelId: string;
  sourceName?: string;
  sourceUrl?: string;
  fetchedAt: string;
  locks: string[];
  title?: string;
  relativeFilePath?: string;
  absoluteFilePath?: string;
  fileUrl?: string;
  markdownContent?: string;
}

export interface KitpicksResApi {
  upsertSourceChannel: (
    source: KitpicksSourceChannelInput,
    lockName: string,
  ) => Promise<{ success: boolean; channel?: Channel; error?: string }>;
  ensureBackgroundFetcher: () => Promise<{ success: boolean; error?: string }>;
  listLockedContent: (
    lockName: string,
  ) => Promise<{ success: boolean; items?: KitpicksLockedContent[]; error?: string }>;
  releaseContentLock: (
    contentId: string,
    lockName: string,
  ) => Promise<{ success: boolean; error?: string }>;
  getSourceLastFetchedAt: () => Promise<{
    success: boolean;
    bySourceUrl?: Record<string, string>;
    error?: string;
  }>;
  fetchNowOnce: () => Promise<{ success: boolean; error?: string }>;
}

export class FakeKitpicksResApi implements KitpicksResApi {
  private upsertSourceChannelResponse: { success: boolean; channel?: Channel; error?: string } = {
    success: true,
  };
  private ensureBackgroundFetcherResponse: { success: boolean; error?: string } = { success: true };
  private listLockedContentResponse: {
    success: boolean;
    items?: KitpicksLockedContent[];
    error?: string;
  } = {
    success: true,
    items: [],
  };
  private releaseContentLockResponse: { success: boolean; error?: string } = { success: true };
  private sourceLastFetchedAtResponse: {
    success: boolean;
    bySourceUrl?: Record<string, string>;
    error?: string;
  } = { success: true, bySourceUrl: {} };
  private fetchNowOnceResponse: { success: boolean; error?: string } = { success: true };

  setUpsertSourceChannelResponse(response: {
    success: boolean;
    channel?: Channel;
    error?: string;
  }): void {
    this.upsertSourceChannelResponse = response;
  }

  setEnsureBackgroundFetcherResponse(response: { success: boolean; error?: string }): void {
    this.ensureBackgroundFetcherResponse = response;
  }

  setListLockedContentResponse(response: {
    success: boolean;
    items?: KitpicksLockedContent[];
    error?: string;
  }): void {
    this.listLockedContentResponse = response;
  }

  setReleaseContentLockResponse(response: { success: boolean; error?: string }): void {
    this.releaseContentLockResponse = response;
  }

  setSourceLastFetchedAtResponse(response: {
    success: boolean;
    bySourceUrl?: Record<string, string>;
    error?: string;
  }): void {
    this.sourceLastFetchedAtResponse = response;
  }

  setFetchNowOnceResponse(response: { success: boolean; error?: string }): void {
    this.fetchNowOnceResponse = response;
  }

  reset(): void {
    this.upsertSourceChannelResponse = { success: true };
    this.ensureBackgroundFetcherResponse = { success: true };
    this.listLockedContentResponse = { success: true, items: [] };
    this.releaseContentLockResponse = { success: true };
    this.sourceLastFetchedAtResponse = { success: true, bySourceUrl: {} };
    this.fetchNowOnceResponse = { success: true };
  }

  async upsertSourceChannel(
    _source: KitpicksSourceChannelInput,
    _lockName: string,
  ): Promise<{ success: boolean; channel?: Channel; error?: string }> {
    return this.upsertSourceChannelResponse;
  }

  async ensureBackgroundFetcher(): Promise<{ success: boolean; error?: string }> {
    return this.ensureBackgroundFetcherResponse;
  }

  async listLockedContent(
    _lockName: string,
  ): Promise<{ success: boolean; items?: KitpicksLockedContent[]; error?: string }> {
    return this.listLockedContentResponse;
  }

  async releaseContentLock(
    _contentId: string,
    _lockName: string,
  ): Promise<{ success: boolean; error?: string }> {
    return this.releaseContentLockResponse;
  }

  async getSourceLastFetchedAt(): Promise<{
    success: boolean;
    bySourceUrl?: Record<string, string>;
    error?: string;
  }> {
    return this.sourceLastFetchedAtResponse;
  }

  async fetchNowOnce(): Promise<{ success: boolean; error?: string }> {
    return this.fetchNowOnceResponse;
  }
}
