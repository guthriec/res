import type { ContentVersion } from "./version-store";

// ─── REST endpoints ─────────────────────────────────────────────────────────

export interface PublishRequest {
  filename: string;
  content: string;
  localVersionChain: ContentVersion[];
  /** When true, the file was deleted locally and should be removed on the server. */
  deleted?: boolean;
}

export interface PublishResponse {
  filename: string;
  /** True when the server's content changed as a result of the merge. */
  merged: boolean;
  /** Server's current content after merge. */
  content: string;
  /** Server's current version chain. */
  serverVersionChain: ContentVersion[];
}

export interface SyncContentItem {
  filename: string;
  content: string;
  versionChain: ContentVersion[];
}

export interface SyncContentResponse {
  items: SyncContentItem[];
}

export interface ChannelInfoResponse {
  id: string;
  name: string;
}

// ─── SSE event types ────────────────────────────────────────────────────────

export interface ContentUpdatedEvent {
  channelId: string;
  filename: string;
  content: string;
  versionChain: ContentVersion[];
}

export interface ContentDeletedEvent {
  channelId: string;
  filename: string;
}

export interface HeartbeatEvent {
  timestamp: string;
}

export type SseEvent =
  | { type: "content-updated"; data: ContentUpdatedEvent }
  | { type: "content-deleted"; data: ContentDeletedEvent }
  | { type: "heartbeat"; data: HeartbeatEvent };
