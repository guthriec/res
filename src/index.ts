export { Reservoir } from './reservoir';
export {
  FetchMethod,
  GLOBAL_LOCK_NAME,
  DEFAULT_DUPLICATE_STRATEGY,
  type DuplicateStrategy,
  type ReservoirConfig,
  type ChannelConfig,
  type Channel,
  type ContentMetadata,
  type ContentItem,
  type FetchedContent,
} from './types';
export { ContentIdAllocator } from './content-id-allocator';
export { fetchRSS } from './fetchers/rss';
export { fetchWebPage } from './fetchers/webpage';
export { fetchCustom } from './fetchers/custom';
export type { Fetcher, FetchParams } from './fetchers/types';
export {
  getBackgroundFetcherStatus,
  startBackgroundFetcher,
  stopBackgroundFetcher,
  runBackgroundFetcherLoop,
  runScheduledFetchTick,
  createBackgroundFetcherState,
  isProcessRunning,
} from './background-fetcher';
