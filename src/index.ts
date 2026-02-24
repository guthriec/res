export { Reservoir } from './reservoir';
export {
  RetentionStrategy,
  FetchMethod,
  type ReservoirConfig,
  type ChannelConfig,
  type Channel,
  type ContentMetadata,
  type ContentItem,
} from './types';
export { fetchRSS } from './fetchers/rss';
export { fetchWebPage } from './fetchers/webpage';
export { fetchCustom } from './fetchers/custom';
export {
  getBackgroundFetcherStatus,
  startBackgroundFetcher,
  stopBackgroundFetcher,
  runBackgroundFetcherLoop,
  runScheduledFetchTick,
  createBackgroundFetcherState,
  isProcessRunning,
} from './background-fetcher';
