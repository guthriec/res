import * as fs from 'fs';
import * as path from 'path';
import { Channel, DEFAULT_REFRESH_INTERVAL_SECONDS } from './types';
import { Reservoir } from './reservoir';

const FETCHER_PID_FILE = '.res-fetcher.pid';
const FETCHER_STATUS_FILE = '.res-fetcher-status.json';

/**
 * Persisted status payload stored on disk.
 *
 * This includes the process id so another CLI invocation can inspect/stop
 * the currently running background fetch loop.
 */
export interface BackgroundFetcherStatus {
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  lastFetchAtByChannel: Record<string, string>;
  lastErrorByChannel: Record<string, string>;
}

/**
 * User-facing process status shape returned by getBackgroundFetcherStatus().
 *
 * Fields are optional because when the fetcher is not running we only return
 * { running: false }.
 */
export interface BackgroundFetcherProcessStatus {
  running: boolean;
  pid?: number;
  startedAt?: string;
  lastHeartbeatAt?: string;
  lastFetchAtByChannel?: Record<string, string>;
  lastErrorByChannel?: Record<string, string>;
}

/**
 * Internal runtime scheduler state for the currently running loop.
 *
 * This is private implementation detail and includes scheduling-only metadata
 * (e.g. lastAttemptAtByChannel) that is not part of public status output.
 */
interface WorkerState {
  startedAt: string;
  lastFetchAtByChannel: Record<string, string>;
  lastAttemptAtByChannel: Record<string, string>;
  lastErrorByChannel: Record<string, string>;
}

export interface BackgroundFetcherState extends WorkerState {}

export interface SchedulerReservoir {
  listChannels(): Channel[];
  fetchChannel(channelId: string): Promise<unknown>;
  syncContentTracking?(): Promise<void>;
}

export interface BackgroundFetcherRuntimeOptions {
  tickIntervalMs?: number;
  logger?: (message: string) => void;
  errorLogger?: (message: string) => void;
}

export interface StartBackgroundFetcherOptions extends BackgroundFetcherRuntimeOptions {
  runner?: (reservoirDir: string, options?: BackgroundFetcherRuntimeOptions) => Promise<void>;
}

export function getBackgroundFetcherPidPath(reservoirDir: string): string {
  return path.join(path.resolve(reservoirDir), FETCHER_PID_FILE);
}

export function getBackgroundFetcherStatusPath(reservoirDir: string): string {
  return path.join(path.resolve(reservoirDir), FETCHER_STATUS_FILE);
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePidFile(reservoirDir: string, pid: number): void {
  fs.writeFileSync(getBackgroundFetcherPidPath(reservoirDir), `${pid}\n`, 'utf-8');
}

export function readPidFile(reservoirDir: string): number | null {
  // PID file enables cross-process control: start writes it, status/stop read it.
  const pidPath = getBackgroundFetcherPidPath(reservoirDir);
  if (!fs.existsSync(pidPath)) return null;
  const parsed = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function clearPidFile(reservoirDir: string): void {
  const pidPath = getBackgroundFetcherPidPath(reservoirDir);
  if (fs.existsSync(pidPath)) {
    fs.rmSync(pidPath, { force: true });
  }
}

export function readBackgroundFetcherStatusFile(reservoirDir: string): BackgroundFetcherStatus | null {
  const statusPath = getBackgroundFetcherStatusPath(reservoirDir);
  if (!fs.existsSync(statusPath)) return null;
  return JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as BackgroundFetcherStatus;
}

function writeBackgroundFetcherStatusFile(reservoirDir: string, status: BackgroundFetcherStatus): void {
  fs.writeFileSync(getBackgroundFetcherStatusPath(reservoirDir), JSON.stringify(status, null, 2), 'utf-8');
}

export function getBackgroundFetcherStatus(reservoirDir: string): BackgroundFetcherProcessStatus {
  const pid = readPidFile(reservoirDir);
  if (!pid || !isProcessRunning(pid)) {
    return { running: false };
  }

  const status = readBackgroundFetcherStatusFile(reservoirDir);
  if (!status) {
    return { running: true, pid };
  }

  return {
    running: true,
    pid,
    startedAt: status.startedAt,
    lastHeartbeatAt: status.lastHeartbeatAt,
    lastFetchAtByChannel: status.lastFetchAtByChannel,
    lastErrorByChannel: status.lastErrorByChannel,
  };
}

function ensureStartable(reservoirDir: string): { canStart: boolean; message?: string; pid?: number } {
  const absDir = path.resolve(reservoirDir);
  const currentStatus = getBackgroundFetcherStatus(absDir);
  if (currentStatus.running && currentStatus.pid) {
    return {
      canStart: false,
      pid: currentStatus.pid,
      message: `Background fetcher already running (pid ${currentStatus.pid})`,
    };
  }
  return { canStart: true };
}

export function stopBackgroundFetcher(reservoirDir: string): { stopped: boolean; message: string; pid?: number } {
  const absDir = path.resolve(reservoirDir);
  const pid = readPidFile(absDir);
  if (!pid) {
    return { stopped: false, message: 'Background fetcher is not running' };
  }

  if (!isProcessRunning(pid)) {
    clearPidFile(absDir);
    return { stopped: false, message: 'Background fetcher is not running' };
  }

  process.kill(pid, 'SIGTERM');
  clearPidFile(absDir);
  return { stopped: true, pid, message: `Stopped background fetcher (pid ${pid})` };
}

function getItemCount(result: unknown): number | null {
  return Array.isArray(result) ? result.length : null;
}

export async function startBackgroundFetcher(
  reservoirDir: string,
  options: StartBackgroundFetcherOptions = {},
): Promise<void> {
  const absDir = path.resolve(reservoirDir);
  const startable = ensureStartable(absDir);
  if (!startable.canStart) {
    throw new Error(startable.message ?? 'Background fetcher already running');
  }

  writePidFile(absDir, process.pid);
  const { runner, ...runtimeOptions } = options;
  const runLoop = runner ?? runBackgroundFetcherLoop;
  await runLoop(absDir, runtimeOptions);
}

function channelPollInterval(channel: Channel): number {
  const refreshInterval = channel.refreshInterval > 0
    ? channel.refreshInterval
    : DEFAULT_REFRESH_INTERVAL_SECONDS;
  const rateLimit = channel.rateLimitInterval && channel.rateLimitInterval > 0
    ? channel.rateLimitInterval
    : 0;
  return Math.max(refreshInterval, rateLimit);
}

export async function runScheduledFetchTick(
  reservoir: SchedulerReservoir,
  state: BackgroundFetcherState,
  nowMs: number = Date.now(),
  hooks: {
    onFetchSuccess?: (channelId: string, itemCount: number | null) => void;
    onFetchError?: (channelId: string, message: string) => void;
  } = {},
): Promise<void> {
  if (typeof reservoir.syncContentTracking === 'function') {
    await reservoir.syncContentTracking();
  }

  const channels = reservoir.listChannels();

  for (const channel of channels) {
    const pollIntervalMs = channelPollInterval(channel) * 1000;
    const lastAttempt = state.lastAttemptAtByChannel[channel.id];
    if (lastAttempt) {
      const elapsed = nowMs - new Date(lastAttempt).getTime();
      if (elapsed < pollIntervalMs) {
        continue;
      }
    }

    state.lastAttemptAtByChannel[channel.id] = new Date(nowMs).toISOString();
    try {
      const result = await reservoir.fetchChannel(channel.id);
      state.lastFetchAtByChannel[channel.id] = new Date().toISOString();
      delete state.lastErrorByChannel[channel.id];
      hooks.onFetchSuccess?.(channel.id, getItemCount(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.lastErrorByChannel[channel.id] = message;
      hooks.onFetchError?.(channel.id, message);
    }
  }
}

export function createBackgroundFetcherState(existing?: {
  startedAt?: string;
  lastFetchAtByChannel?: Record<string, string>;
  lastErrorByChannel?: Record<string, string>;
}): BackgroundFetcherState {
  return {
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    lastFetchAtByChannel: existing?.lastFetchAtByChannel ?? {},
    lastAttemptAtByChannel: {},
    lastErrorByChannel: existing?.lastErrorByChannel ?? {},
  };
}

export async function runBackgroundFetcherLoop(
  reservoirDir: string,
  options: BackgroundFetcherRuntimeOptions = {},
): Promise<void> {
  const absDir = path.resolve(reservoirDir);
  const tickIntervalMs = options.tickIntervalMs ?? 1000;
  const logger = options.logger ?? ((message: string): void => console.log(message));
  const errorLogger = options.errorLogger ?? ((message: string): void => console.error(message));
  const reservoir = Reservoir.load(absDir);
  await reservoir.syncContentTracking();

  const existing = readBackgroundFetcherStatusFile(absDir);
  const state = createBackgroundFetcherState({
    startedAt: existing?.startedAt,
    lastFetchAtByChannel: existing?.lastFetchAtByChannel,
    lastErrorByChannel: existing?.lastErrorByChannel,
  });

  const persist = (): void => {
    writeBackgroundFetcherStatusFile(absDir, {
      pid: process.pid,
      startedAt: state.startedAt,
      lastHeartbeatAt: new Date().toISOString(),
      lastFetchAtByChannel: state.lastFetchAtByChannel,
      lastErrorByChannel: state.lastErrorByChannel,
    });
  };

  let pendingResync: NodeJS.Timeout | undefined;
  let channelsWatcher: fs.FSWatcher | undefined;
  const scheduleResync = (): void => {
    if (pendingResync) {
      clearTimeout(pendingResync);
    }
    pendingResync = setTimeout(() => {
      void reservoir.syncContentTracking().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        errorLogger(`[sync] failed: ${message}`);
      });
    }, 250);
  };

  const channelsDir = path.join(absDir, 'channels');
  if (fs.existsSync(channelsDir)) {
    try {
      channelsWatcher = fs.watch(channelsDir, { recursive: true }, () => {
        scheduleResync();
      });
    } catch {
      channelsWatcher = undefined;
    }
  }

  const shutdown = (): void => {
    if (pendingResync) {
      clearTimeout(pendingResync);
      pendingResync = undefined;
    }
    if (channelsWatcher) {
      channelsWatcher.close();
      channelsWatcher = undefined;
    }
    clearPidFile(absDir);
    persist();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  persist();
  logger(`Background fetcher started (pid ${process.pid})`);

  while (true) {
    await runScheduledFetchTick(reservoir, state, Date.now(), {
      onFetchSuccess: (channelId, itemCount) => {
        const suffix = itemCount === null ? '' : ` (${itemCount} item(s))`;
        logger(`[${channelId}] fetched${suffix}`);
      },
      onFetchError: (channelId, message) => {
        errorLogger(`[${channelId}] fetch failed: ${message}`);
      },
    });
    persist();
    await new Promise((resolve) => setTimeout(resolve, tickIntervalMs));
  }
}
