import * as fs from "fs";
import * as path from "path";

const SYNC_CONFIG_FILE = ".res/sync.json";

export interface SyncSubscription {
  serverUrl: string;
  serverChannelId: string;
  localChannelId: string;
  /** Optional shared secret sent as Authorization: Bearer <secret> header. */
  secret?: string;
}

export interface SyncConfig {
  subscriptions: SyncSubscription[];
}

/**
 * Read the sync configuration for a reservoir.
 * Returns an empty config if the file does not exist.
 */
export function readSyncConfig(reservoirDir: string): SyncConfig {
  const configPath = path.join(reservoirDir, SYNC_CONFIG_FILE);
  if (!fs.existsSync(configPath)) return { subscriptions: [] };
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as SyncConfig;
  } catch {
    return { subscriptions: [] };
  }
}

/**
 * Write the sync configuration for a reservoir.
 */
export function writeSyncConfig(reservoirDir: string, config: SyncConfig): void {
  const configPath = path.join(reservoirDir, SYNC_CONFIG_FILE);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Add a subscription to the sync configuration.
 */
export function addSubscription(
  reservoirDir: string,
  subscription: SyncSubscription,
): SyncConfig {
  const config = readSyncConfig(reservoirDir);
  config.subscriptions.push(subscription);
  writeSyncConfig(reservoirDir, config);
  return config;
}

/**
 * Remove subscriptions matching the given predicate.
 */
export function removeSubscription(
  reservoirDir: string,
  predicate: (s: SyncSubscription) => boolean,
): SyncConfig {
  const config = readSyncConfig(reservoirDir);
  config.subscriptions = config.subscriptions.filter((s) => !predicate(s));
  writeSyncConfig(reservoirDir, config);
  return config;
}
