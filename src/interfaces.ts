import type { ChannelConfig, Channel, ContentItem, ReservoirConfig } from "./types";

export interface ChannelController {
  addChannel(config: ChannelConfig): Channel;
  editChannel(channelId: string, updates: Partial<ChannelConfig>): Channel;
  deleteChannel(channelId: string): void;
  viewChannel(channelId: string): Channel;
  listChannels(): Channel[];
}

export interface ContentController {
  listContent(options?: {
    channelIds?: string[];
    retained?: boolean;
    retainedBy?: string[];
    pageSize?: number;
    pageOffset?: number;
  }): ContentItem[];
  listRetained(channelIds?: string[]): ContentItem[];
}

export interface LockController {
  retainContent(contentId: string, lockName?: string): void;
  releaseContent(contentId: string, lockName?: string): void;
  retainContentRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
  }): number;
  releaseContentRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
  }): number;
  retainChannel(channelId: string, lockName?: string): Channel;
  releaseChannel(channelId: string, lockName?: string): Channel;
}

export interface EvictionController {
  clean(): void;
}

export interface Reservoir {
  readonly channelController: ChannelController;
  readonly contentController: ContentController;
  readonly lockController: LockController;
  readonly evictionController: EvictionController;
  readonly directory: string;
  readonly reservoirConfig: ReservoirConfig;
  readonly customFetchersDirectory: string;
  setMaxSizeMB(maxSizeMB: number): ReservoirConfig;
  addFetcher(executablePath: string): { name: string; destinationPath: string };
  fetchChannel(channelId: string): Promise<ContentItem[]>;
}
