import type { ChannelConfig, Channel, ContentItem, ReservoirConfig } from "./types";

export interface ChannelController {
  addChannel(config: ChannelConfig): Promise<Channel>;
  editChannel(channelId: string, updates: Partial<ChannelConfig>): Promise<Channel>;
  deleteChannel(channelId: string): Promise<void>;
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
  retainContent(contentId: string, lockName?: string): Promise<void>;
  releaseContent(contentId: string, lockName?: string): Promise<void>;
  retainContentRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
  }): Promise<number>;
  releaseContentRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
  }): Promise<number>;
  retainChannel(channelId: string, lockName?: string): Promise<Channel>;
  releaseChannel(channelId: string, lockName?: string): Promise<Channel>;
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
  initialize(options?: { maxSizeMB?: number }): Reservoir;
  load(): Reservoir;
  setMaxSizeMB(maxSizeMB: number): Promise<ReservoirConfig>;
  addFetcher(executablePath: string): { name: string; destinationPath: string };
  fetchChannel(channelId: string): Promise<ContentItem[]>;
}
