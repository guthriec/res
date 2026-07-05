export { ReservoirImpl } from "./reservoir";
export type {
  Reservoir,
  ChannelController,
  ContentController,
  LockController,
  EvictionController,
} from "./interfaces";
export { ReservoirFake } from "./testing/fake-reservoir";
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
} from "./types";
export { ContentIdAllocator } from "./content-id-allocator";
export { fetchRSS } from "./fetchers/rss";
export { fetchWebPage } from "./fetchers/webpage";
export { fetchCustom } from "./fetchers/custom";
export type { Fetcher, FetchParams } from "./fetchers/types";
export {
  getBackgroundFetchWorkerStatus,
  startBackgroundFetchWorker,
  stopBackgroundFetchWorker,
  runBackgroundFetchWorkerLoop,
  runScheduledFetchStep,
  createBackgroundFetchWorkerState,
  isProcessRunning,
} from "./background-fetch-worker";
export { ReservoirError, ErrorCodes } from "./errors";
export type { ErrorCode } from "./errors";
export { createDirectoryWatcher } from "./file-watcher";
export type { DirectoryWatcherOptions } from "./file-watcher";
export { VersionStore } from "./version-store";
export type { ContentVersion, VersionSidecar } from "./version-store";
export { ChangeDetector } from "./change-detector";
export { UnsafeAutoMerge } from "./merge-strategy";
export type { MergeParams, MergeStrategy, Diff3Region } from "./merge-strategy";
