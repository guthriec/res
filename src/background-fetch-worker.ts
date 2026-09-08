import * as fs from "fs";
import * as path from "path";
import { writeJSONAtomicSync } from "./atomic-writes";
import { ChangeDetector } from "./change-detector";
import { createDirectoryWatcher } from "./file-watcher";
import {
  channelPollIntervalMs,
  computeNextFetchDeadlineMs,
  createCancellableSleep,
  type CancellableSleep,
} from "./background-fetch-scheduler";
import { Channel } from "./types";
import { ReservoirImpl } from "./reservoir";
import { Logger, type LogLevel } from "./logger";

const FETCHER_PID_FILE = ".res-fetcher.pid";
const FETCHER_STATUS_FILE = ".res-fetcher-status.json";
const MIN_HEARTBEAT_INTERVAL_MS = 50;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
/** Slow periodic scan used when the filesystem cannot be recursively watched. */
const FALLBACK_SCAN_INTERVAL_MS = 60_000;

/**
 * Persisted status payload stored on disk.
 *
 * This includes the process id so another CLI invocation can inspect/stop
 * the currently running background fetch loop.
 */
export interface BackgroundFetchWorkerStatus {
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  lastFetchAtByChannel: Record<string, string>;
  lastErrorByChannel: Record<string, string>;
}

/**
 * User-facing process status shape returned by getBackgroundFetchWorkerStatus().
 *
 * Fields are optional because when the fetcher is not running we only return
 * { running: false }.
 */
export interface BackgroundFetchWorkerProcessStatus {
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

export interface BackgroundFetchWorkerState extends WorkerState {}

export interface SchedulerReservoir {
  channelController?: {
    listChannels(): Channel[];
  };
  listChannels?(): Channel[];
  fetchChannel(channelId: string): Promise<unknown>;
  syncContentTracking?(): Promise<void>;
}

export interface BackgroundFetchWorkerRuntimeOptions {
  /**
   * How often, in milliseconds, to persist a heartbeat status file while the
   * worker is idle with no fetch due. Defaults to 30_000. Heartbeat writes only
   * update the status file — they never scan the reservoir or run fetches.
   */
  heartbeatIntervalMs?: number;
  logger?: (message: string) => void;
  errorLogger?: (message: string) => void;
  logLevel?: LogLevel;
  onFetchSuccess?: (channelId: string, affectedIds: string[]) => void;
  onFetchError?: (channelId: string, message: string) => void;
}

/**
 * Startup options for booting the background fetch worker process.
 *
 * By default, startBackgroundFetchWorker() executes runBackgroundFetchWorkerLoop(),
 * which is the real long-lived production loop.
 */
export interface StartBackgroundFetchWorkerOptions extends BackgroundFetchWorkerRuntimeOptions {}

export function getBackgroundFetchWorkerPidPath(reservoirDir: string): string {
  return path.join(path.resolve(reservoirDir), FETCHER_PID_FILE);
}

export function getBackgroundFetchWorkerStatusPath(reservoirDir: string): string {
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
  fs.writeFileSync(getBackgroundFetchWorkerPidPath(reservoirDir), `${pid}\n`, "utf-8");
}

export function readPidFile(reservoirDir: string): number | null {
  // PID file enables cross-process control: start writes it, status/stop read it.
  const pidPath = getBackgroundFetchWorkerPidPath(reservoirDir);
  if (!fs.existsSync(pidPath)) return null;
  const parsed = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function clearPidFile(reservoirDir: string): void {
  const pidPath = getBackgroundFetchWorkerPidPath(reservoirDir);
  if (fs.existsSync(pidPath)) {
    fs.rmSync(pidPath, { force: true });
  }
}

export function readBackgroundFetchWorkerStatusFile(
  reservoirDir: string,
): BackgroundFetchWorkerStatus | null {
  const statusPath = getBackgroundFetchWorkerStatusPath(reservoirDir);
  if (!fs.existsSync(statusPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf-8")) as BackgroundFetchWorkerStatus;
  } catch {
    // A killed process can leave an empty/truncated status file behind. Treat it
    // as "no status" so startup survives instead of crashing on invalid JSON.
    return null;
  }
}

function writeBackgroundFetchWorkerStatusFile(
  reservoirDir: string,
  status: BackgroundFetchWorkerStatus,
): void {
  writeJSONAtomicSync(getBackgroundFetchWorkerStatusPath(reservoirDir), status);
}

export function getBackgroundFetchWorkerStatus(
  reservoirDir: string,
): BackgroundFetchWorkerProcessStatus {
  const pid = readPidFile(reservoirDir);
  if (!pid || !isProcessRunning(pid)) {
    return { running: false };
  }

  const status = readBackgroundFetchWorkerStatusFile(reservoirDir);
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

function ensureStartable(reservoirDir: string): {
  canStart: boolean;
  message?: string;
  pid?: number;
} {
  const absDir = path.resolve(reservoirDir);
  const currentStatus = getBackgroundFetchWorkerStatus(absDir);
  if (currentStatus.running && currentStatus.pid) {
    return {
      canStart: false,
      pid: currentStatus.pid,
      message: `Background fetcher already running (pid ${currentStatus.pid})`,
    };
  }
  return { canStart: true };
}

export function stopBackgroundFetchWorker(reservoirDir: string): {
  stopped: boolean;
  message: string;
  pid?: number;
} {
  const absDir = path.resolve(reservoirDir);
  const pid = readPidFile(absDir);
  if (!pid) {
    return { stopped: false, message: "Background fetcher is not running" };
  }

  if (!isProcessRunning(pid)) {
    clearPidFile(absDir);
    return { stopped: false, message: "Background fetcher is not running" };
  }

  if (pid === process.pid) {
    const status = readBackgroundFetchWorkerStatusFile(absDir);
    if (status?.pid === process.pid) {
      process.emit("SIGTERM");
    }
  } else {
    process.kill(pid, "SIGTERM");
  }
  clearPidFile(absDir);
  return { stopped: true, pid, message: `Stopped background fetcher (pid ${pid})` };
}

function getAffectedContentIds(result: unknown): string[] {
  if (!Array.isArray(result)) return [];
  return result
    .map((item) => (item as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string");
}

export async function startBackgroundFetchWorker(
  reservoirDir: string,
  options: StartBackgroundFetchWorkerOptions = {},
): Promise<void> {
  const absDir = path.resolve(reservoirDir);
  const startable = ensureStartable(absDir);
  if (!startable.canStart) {
    throw new Error(startable.message ?? "Background fetcher already running");
  }

  writePidFile(absDir, process.pid);
  await runBackgroundFetchWorkerLoop(absDir, options);
}

export async function runScheduledFetchStep(
  reservoir: SchedulerReservoir,
  state: BackgroundFetchWorkerState,
  nowMs: number = Date.now(),
  hooks: {
    onFetchSuccess?: (channelId: string, affectedIds: string[]) => void;
    onFetchError?: (channelId: string, message: string) => void;
  } = {},
): Promise<void> {
  if (typeof reservoir.syncContentTracking === "function") {
    await reservoir.syncContentTracking();
  }

  const channels = reservoir.channelController
    ? reservoir.channelController.listChannels()
    : (reservoir.listChannels?.() ?? []);

  for (const channel of channels) {
    const pollIntervalMs = channelPollIntervalMs(channel);
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
      state.lastFetchAtByChannel[channel.id] = new Date(nowMs).toISOString();
      delete state.lastErrorByChannel[channel.id];
      hooks.onFetchSuccess?.(channel.id, getAffectedContentIds(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.lastErrorByChannel[channel.id] = message;
      hooks.onFetchError?.(channel.id, message);
    }
  }
}

export function createBackgroundFetchWorkerState(existing?: {
  startedAt?: string;
  lastFetchAtByChannel?: Record<string, string>;
  lastErrorByChannel?: Record<string, string>;
}): BackgroundFetchWorkerState {
  const lastFetchAtByChannel = existing?.lastFetchAtByChannel ?? {};
  return {
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    lastFetchAtByChannel,
    lastAttemptAtByChannel: { ...lastFetchAtByChannel },
    lastErrorByChannel: existing?.lastErrorByChannel ?? {},
  };
}

/**
 * Executes one full worker step.
 *
 * A step means:
 * 1) run one scheduled fetch step across channels, and
 * 2) persist current worker status/heartbeat to disk.
 *
 * Change detection is intentionally *not* part of a step: it is handled once at
 * startup and then reactively by the reservoir file watcher (see
 * `setupWorkerLoop`), so a step stays cheap and finite.
 *
 * This is intentionally finite and side-effectful so it can be reused both by
 * the long-lived loop and by tests that need deterministic single-step behavior.
 */
export async function runBackgroundFetchWorkerStep(
  reservoirDir: string,
  reservoir: SchedulerReservoir,
  state: BackgroundFetchWorkerState,
  nowMs: number = Date.now(),
  hooks: {
    onFetchSuccess?: (channelId: string, affectedIds: string[]) => void;
    onFetchError?: (channelId: string, message: string) => void;
  } = {},
): Promise<void> {
  await runScheduledFetchStep(reservoir, state, nowMs, hooks);
  writeBackgroundFetchWorkerStatusFile(path.resolve(reservoirDir), {
    pid: process.pid,
    startedAt: state.startedAt,
    lastHeartbeatAt: new Date(nowMs).toISOString(),
    lastFetchAtByChannel: state.lastFetchAtByChannel,
    lastErrorByChannel: state.lastErrorByChannel,
  });
}

type WorkerEmit = (eventLevel: Exclude<LogLevel, "silent">, message: string) => void;

function createWorkerEmitter(options: BackgroundFetchWorkerRuntimeOptions): {
  activeLogLevel: LogLevel;
  emit: WorkerEmit;
} {
  const activeLogLevel = Logger.normalizeLogLevel(options.logLevel ?? process.env.RES_LOG_LEVEL);
  const logger = new Logger(activeLogLevel, {
    out: options.logger ?? ((message: string): void => console.log(message)),
    err: options.errorLogger ?? ((message: string): void => console.error(message)),
  });
  const emit: WorkerEmit = (eventLevel, message) => {
    if (eventLevel === "error") {
      logger.error(message);
      return;
    }
    if (eventLevel === "debug") {
      logger.debug(message);
      return;
    }
    logger.info(message);
  };

  return { activeLogLevel, emit };
}

async function loadReservoirAndState(absDir: string): Promise<{
  reservoir: ReservoirImpl;
  state: BackgroundFetchWorkerState;
}> {
  const reservoir = new ReservoirImpl(absDir).load();
  await reservoir.syncContentTracking();

  const existing = readBackgroundFetchWorkerStatusFile(absDir);
  const state = createBackgroundFetchWorkerState({
    startedAt: existing?.startedAt,
    lastFetchAtByChannel: existing?.lastFetchAtByChannel,
    lastErrorByChannel: existing?.lastErrorByChannel,
  });

  return { reservoir, state };
}

function persistWorkerStatus(absDir: string, state: BackgroundFetchWorkerState): void {
  writeBackgroundFetchWorkerStatusFile(absDir, {
    pid: process.pid,
    startedAt: state.startedAt,
    lastHeartbeatAt: new Date().toISOString(),
    lastFetchAtByChannel: state.lastFetchAtByChannel,
    lastErrorByChannel: state.lastErrorByChannel,
  });
}

/**
 * Watches the channels directory and requests a debounced sync when it changes.
 *
 * "Watching for resync" means listening for channel config file changes so the
 * in-memory channel/content tracking is reloaded before the next scheduled tick.
 * The provided `wake` callback also interrupts the idle loop so newly added or
 * updated channels are picked up without waiting for the next fetch deadline.
 *
 * Returns a cleanup function that stops the file watcher and cancels any pending
 * debounced sync callback.
 */
function watchChannelsForResync(
  absDir: string,
  reservoir: ReservoirImpl,
  emit: WorkerEmit,
  wake: () => void,
): () => void {
  const channelsDir = path.join(absDir, ".res", "channels");

  return createDirectoryWatcher(channelsDir, () => {
    wake();
    reservoir.syncContentTracking().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      emit("error", `[sync] failed: ${message}`);
    });
  });
}

function registerShutdownHandlers(shutdown: () => void): () => void {
  const onSigterm = (): void => {
    shutdown();
  };
  const onSigint = (): void => {
    shutdown();
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  return (): void => {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  };
}

/**
 * Repeats worker steps until shutdown is requested, waking only for real work.
 *
 * The loop runs a step immediately on entry, then idles: it sleeps until the
 * earliest of the next channel fetch deadline and the next heartbeat, and only
 * wakes early for channel-config changes or a stop request (via `sleeper`).
 * On a fetch deadline it runs a full step; on a heartbeat it only persists the
 * status file. The channel set is re-read after every wake so channels added
 * while idle are picked up.
 *
 * This helper owns only the repeated execution behavior (loop + interruptible
 * sleep). It does not own process wiring (signals/watchers/startup), which is
 * handled by runBackgroundFetchWorkerLoop().
 */
async function loopAndFetchWhileNotStopped(
  absDir: string,
  heartbeatIntervalMs: number,
  sleeper: CancellableSleep,
  reservoir: ReservoirImpl,
  state: BackgroundFetchWorkerState,
  emit: WorkerEmit,
  isStopping: () => boolean,
  hooks: {
    onFetchSuccess?: (channelId: string, affectedIds: string[]) => void;
    onFetchError?: (channelId: string, message: string) => void;
  } = {},
): Promise<void> {
  let isFetchDue = true;
  let lastStatusWriteAt = Date.now();

  while (!isStopping()) {
    if (isFetchDue) {
      await runBackgroundFetchWorkerStep(absDir, reservoir, state, Date.now(), {
        onFetchSuccess: (channelId, affectedIds) => {
          hooks.onFetchSuccess?.(channelId, affectedIds);
          emit("info", `[${channelId}] fetched (${affectedIds.length} item(s))`);
        },
        onFetchError: (channelId, message) => {
          hooks.onFetchError?.(channelId, message);
          emit("error", `[${channelId}] fetch failed: ${message}`);
        },
      });
      lastStatusWriteAt = Date.now();
    } else {
      persistWorkerStatus(absDir, state);
      lastStatusWriteAt = Date.now();
    }
    if (isStopping()) {
      break;
    }

    const nextFetchDeadlineMs = computeNextFetchDeadlineMs(
      state.lastAttemptAtByChannel,
      reservoir.channelController.listChannels(),
      Date.now(),
    );
    const nextHeartbeatDeadlineMs = lastStatusWriteAt + heartbeatIntervalMs;
    await sleeper.sleepUntil(Math.min(nextFetchDeadlineMs, nextHeartbeatDeadlineMs));
    if (isStopping()) {
      break;
    }

    const nowMs = Date.now();
    const refreshedChannels = reservoir.channelController.listChannels();
    isFetchDue =
      computeNextFetchDeadlineMs(state.lastAttemptAtByChannel, refreshedChannels, nowMs) <= nowMs;
  }
}

function normalizeHeartbeatIntervalMs(value: number | undefined): number {
  const configured = value ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  return Math.max(MIN_HEARTBEAT_INTERVAL_MS, configured);
}

interface WorkerLoop {
  absDir: string;
  heartbeatIntervalMs: number;
  sleeper: CancellableSleep;
  reservoir: ReservoirImpl;
  state: BackgroundFetchWorkerState;
  emit: WorkerEmit;
  hooks: {
    onFetchSuccess?: (channelId: string, affectedIds: string[]) => void;
    onFetchError?: (channelId: string, message: string) => void;
  };
  isStopping: () => boolean;
  requestStop: () => void;
  teardown: () => void;
}

/**
 * Builds runtime dependencies and lifecycle hooks for the worker loop.
 *
 * This method owns startup setup (logger/state/watchers/signals) while the
 * fetch loop itself is handled by loopAndFetchWhileNotStopped().
 *
 * Change detection is booted here rather than per step: a single ChangeDetector
 * scans once at startup and then watches the reservoir tree reactively. When
 * recursive fs.watch is unavailable (e.g. network/FUSE mounts), it falls back to
 * a slow periodic scan so versioning still converges.
 */
async function setupWorkerLoop(
  reservoirDir: string,
  options: BackgroundFetchWorkerRuntimeOptions,
): Promise<WorkerLoop> {
  const absDir = path.resolve(reservoirDir);
  const heartbeatIntervalMs = normalizeHeartbeatIntervalMs(options.heartbeatIntervalMs);
  const { activeLogLevel, emit } = createWorkerEmitter(options);
  process.env.RES_LOG_LEVEL = activeLogLevel;
  const hooks = {
    onFetchSuccess: options.onFetchSuccess,
    onFetchError: options.onFetchError,
  };

  const { reservoir, state } = await loadReservoirAndState(absDir);

  const detector = new ChangeDetector(absDir);
  await detector.scanAll();
  let fallbackScanTimer: ReturnType<typeof setInterval> | undefined;
  const stopContentWatcher = detector.startWatching((watching) => {
    if (!watching) {
      fallbackScanTimer = setInterval(() => {
        detector.scanAll().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          emit("error", `[change-detector] scan failed: ${message}`);
        });
      }, FALLBACK_SCAN_INTERVAL_MS);
    }
  });

  const sleeper = createCancellableSleep();
  const stopWatchingResync = watchChannelsForResync(absDir, reservoir, emit, () => sleeper.wake());

  let stopping = false;
  const requestStop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    stopWatchingResync();
    sleeper.wake();
    clearPidFile(absDir);
    persistWorkerStatus(absDir, state);
  };

  const unregisterShutdownHandlers = registerShutdownHandlers(requestStop);
  const teardown = (): void => {
    unregisterShutdownHandlers();
    stopWatchingResync();
    stopContentWatcher();
    if (fallbackScanTimer !== undefined) {
      clearInterval(fallbackScanTimer);
    }
    sleeper.dispose();
  };

  persistWorkerStatus(absDir, state);
  emit("info", `Background fetcher started (pid ${process.pid})`);

  return {
    absDir,
    heartbeatIntervalMs,
    sleeper,
    reservoir,
    state,
    emit,
    hooks,
    isStopping: () => stopping,
    requestStop,
    teardown,
  };
}

/**
 * Orchestrates the full background worker runtime.
 *
 * Responsibilities in this method:
 * - perform top-level setup via setupWorkerLoop()
 * - delegate repeated step execution to loopAndFetchWhileNotStopped()
 * - ensure teardown always runs
 *
 * Conceptually:
 * - runBackgroundFetchWorkerLoop(): runtime orchestration boundary
 * - setupWorkerLoop(): startup wiring and dependencies
 * - loopAndFetchWhileNotStopped(): repeat-until-stop control flow
 * - runBackgroundFetchWorkerStep(): one deterministic unit of work
 */
export async function runBackgroundFetchWorkerLoop(
  reservoirDir: string,
  options: BackgroundFetchWorkerRuntimeOptions = {},
): Promise<void> {
  const loop = await setupWorkerLoop(reservoirDir, options);

  try {
    await loopAndFetchWhileNotStopped(
      loop.absDir,
      loop.heartbeatIntervalMs,
      loop.sleeper,
      loop.reservoir,
      loop.state,
      loop.emit,
      loop.isStopping,
      loop.hooks,
    );
  } finally {
    loop.requestStop();
    loop.teardown();
  }
}
