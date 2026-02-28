export enum FetchMethod {
  RSS = 'rss',
  WebPage = 'web_page',
}

export const DEFAULT_REFRESH_INTERVAL_SECONDS = 24 * 60 * 60;
export const GLOBAL_LOCK_NAME = '[global]';
export const DEFAULT_DUPLICATE_STRATEGY = 'keep-both' as const;

export type DuplicateStrategy = 'overwrite' | 'keep-both';

export interface ReservoirConfig {
  maxSizeMB?: number;
}

export interface ChannelConfig {
  name: string;
  /** Built-in fetch method or registered custom fetcher executable name */
  fetchMethod: FetchMethod | string;
  /** Fetcher parameters forwarded to the configured fetch method */
  fetchParams?: Record<string, string>;
  /** Rate-limit interval in seconds */
  rateLimitInterval?: number;
  /** Background refresh interval in seconds (defaults to 24h if omitted) */
  refreshInterval?: number;
  /** Optional frontmatter field used to identify duplicates within a channel */
  idField?: string;
  /** Duplicate handling strategy (defaults to keep-both) */
  duplicateStrategy?: DuplicateStrategy;
  /** Lock names to apply automatically to newly fetched content */
  retainedLocks?: string[];
}

export interface Channel extends Omit<ChannelConfig, 'refreshInterval' | 'retainedLocks'> {
  id: string;
  createdAt: string;
  refreshInterval: number;
  duplicateStrategy: DuplicateStrategy;
  retainedLocks: string[];
}

export interface ContentMetadata {
  id: string;
  channelId: string;
  fetchedAt: string; // ISO timestamp
  locks: string[];
}

export interface ContentItem extends ContentMetadata {
  title?: string;
  /** Full markdown content */
  content: string;
  /** Relative file path from reservoir root */
  filePath?: string;
}

export interface FetchedContent {
  content: string;
  sourceFileName?: string;
  supplementaryFiles?: Array<{
    relativePath: string;
    content: Buffer;
  }>;
}
