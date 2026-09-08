import { DEFAULT_REFRESH_INTERVAL_SECONDS } from "./types";

/**
 * Minimal channel shape needed to compute a poll deadline.
 *
 * Intentionally narrower than the full `Channel` type so the scheduler can be
 * used with mocks and does not depend on unrelated channel fields.
 */
export interface PollableChannel {
  id: string;
  refreshInterval: number;
  rateLimitInterval?: number;
}

/**
 * Effective poll interval (seconds) for a channel, mirroring the fetch-step
 * logic: the larger of the refresh interval (falling back to the default) and
 * the rate-limit interval.
 */
export function channelPollIntervalSeconds(channel: PollableChannel): number {
  const refreshInterval =
    channel.refreshInterval > 0 ? channel.refreshInterval : DEFAULT_REFRESH_INTERVAL_SECONDS;
  const rateLimit =
    channel.rateLimitInterval && channel.rateLimitInterval > 0 ? channel.rateLimitInterval : 0;
  return Math.max(refreshInterval, rateLimit);
}

/**
 * Effective poll interval (ms) for a channel.
 */
export function channelPollIntervalMs(channel: PollableChannel): number {
  return channelPollIntervalSeconds(channel) * 1000;
}

/**
 * The earliest wall-clock time (ms since epoch) at which any channel becomes
 * due for a fetch.
 *
 * Channels with no recorded attempt are considered due immediately. When there
 * are no channels at all, returns Infinity so the loop can sleep on other
 * wake reasons (heartbeat, watcher, stop).
 */
export function computeNextFetchDeadlineMs(
  lastAttemptAtByChannel: Record<string, string>,
  channels: PollableChannel[],
  nowMs: number,
): number {
  let deadlineMs = Infinity;
  for (const channel of channels) {
    const lastAttempt = lastAttemptAtByChannel[channel.id];
    const nextDueMs = lastAttempt
      ? new Date(lastAttempt).getTime() + channelPollIntervalMs(channel)
      : nowMs;
    if (nextDueMs < deadlineMs) {
      deadlineMs = nextDueMs;
    }
  }
  return deadlineMs;
}

/**
 * A sleep that can be interrupted on demand.
 *
 * `sleepUntil(targetMs)` resolves once `targetMs` is reached, or immediately if
 * `wake()` was called first. `wake()` is latched: a wake requested while no
 * sleep is pending interrupts the *next* sleep. `dispose()` clears any pending
 * timer and releases a sleeping promise so the owning loop can exit without
 * waiting for a far-future deadline.
 */
export interface CancellableSleep {
  sleepUntil(targetMs: number): Promise<void>;
  wake(): void;
  dispose(): void;
}

export function createCancellableSleep(): CancellableSleep {
  let wakeRequested = false;
  let resolvePending: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  return {
    sleepUntil(targetMs: number): Promise<void> {
      if (disposed || wakeRequested) {
        wakeRequested = false;
        return Promise.resolve();
      }
      const delayMs = Math.max(0, targetMs - Date.now());
      return new Promise<void>((resolve) => {
        resolvePending = resolve;
        timer = setTimeout(() => {
          timer = undefined;
          resolvePending = undefined;
          resolve();
        }, delayMs);
      });
    },
    wake(): void {
      if (disposed) {
        return;
      }
      if (resolvePending !== undefined) {
        const resolve = resolvePending;
        resolvePending = undefined;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        wakeRequested = false;
        resolve();
        return;
      }
      wakeRequested = true;
    },
    dispose(): void {
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (resolvePending !== undefined) {
        const resolve = resolvePending;
        resolvePending = undefined;
        resolve();
      }
    },
  };
}