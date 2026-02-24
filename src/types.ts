export enum RetentionStrategy {
  RetainAll = 'retain_all',
  RetainUnread = 'retain_unread',
  RetainNone = 'retain_none',
}

export enum FetchMethod {
  RSS = 'rss',
  WebPage = 'web_page',
  Custom = 'custom',
}

export const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ReservoirConfig {
  maxSizeMB?: number;
}

export interface ChannelConfig {
  name: string;
  fetchMethod: FetchMethod;
  /** URL for RSS or WebPage fetch methods */
  url?: string;
  /** Script filename (in the reservoir's scripts/ dir) for Custom fetch method */
  script?: string;
  /** Rate-limit interval in milliseconds */
  rateLimitInterval?: number;
  /** Background refresh interval in milliseconds (defaults to 24h if omitted) */
  refreshInterval?: number;
  retentionStrategy: RetentionStrategy;
}

export interface Channel extends Omit<ChannelConfig, 'refreshInterval'> {
  id: string;
  createdAt: string;
  refreshInterval: number;
}

export interface ContentMetadata {
  id: string;
  channelId: string;
  title: string;
  fetchedAt: string; // ISO timestamp
  read: boolean;
  url?: string;
}

export interface ContentItem extends ContentMetadata {
  /** Full markdown content */
  content: string;
}
