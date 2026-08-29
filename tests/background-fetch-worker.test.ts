import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  type BackgroundFetchWorkerState,
  getBackgroundFetchWorkerStatus,
  readBackgroundFetchWorkerStatusFile,
  runBackgroundFetchWorkerStep,
  runScheduledFetchStep,
  startBackgroundFetchWorker,
  stopBackgroundFetchWorker,
} from "../src/background-fetch-worker";
import { ReservoirImpl as Reservoir } from "../src/reservoir";
import { Channel, DEFAULT_REFRESH_INTERVAL_SECONDS, FetchMethod } from "../src/types";
import {
  countRunsFromMarker,
  createFailingCustomFetcherExecutable,
  createFixtureCustomFetcherExecutable,
  createMarkerCustomFetcherExecutable,
  waitForWorkerStartAndFetchOpportunity,
} from "./helpers/custom-fetcher-test-utils";

let tmpDir: string;
let previousXdgConfigHome: string | undefined;
const WORKER_TEST_TICK_INTERVAL_MS = 20;
const WORKER_TEST_OPTIONS = {
  tickIntervalMs: WORKER_TEST_TICK_INTERVAL_MS,
  logLevel: "silent" as const,
  logger: () => undefined,
  errorLogger: () => undefined,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "res-fetcher-test-"));
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
  vi.restoreAllMocks();
});

function mkChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: overrides.id ?? "ch-1",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    name: overrides.name ?? "Channel",
    fetchMethod: overrides.fetchMethod ?? FetchMethod.RSS,
    fetchParams: overrides.fetchParams ?? { url: "https://example.com/feed" },
    rateLimitInterval: overrides.rateLimitInterval,
    refreshInterval: overrides.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS,
    duplicateStrategy: overrides.duplicateStrategy ?? "keep-both",
    retainedLocks: overrides.retainedLocks ?? [],
  };
}

function startWorkerForTest(): Promise<void> {
  return startBackgroundFetchWorker(tmpDir, WORKER_TEST_OPTIONS);
}

async function waitForWorkerOpportunity(): Promise<void> {
  await waitForWorkerStartAndFetchOpportunity(tmpDir, {
    tickIntervalMs: WORKER_TEST_TICK_INTERVAL_MS,
  });
}

async function stopWorkerAndAwait(startPromise: Promise<void>): Promise<void> {
  const result = stopBackgroundFetchWorker(tmpDir);
  expect(result.stopped).toBe(true);
  await startPromise;
}

async function waitForHookCalls(calls: () => number): Promise<void> {
  for (let i = 0; i < 100 && calls() === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("runScheduledFetchStep", () => {
  it("runs a registered custom fetcher end-to-end and persists output", async () => {
    const reservoir = new Reservoir(tmpDir).initialize();
    const executablePath = createFixtureCustomFetcherExecutable(tmpDir);

    const registered = reservoir.addFetcher(executablePath);
    const channel = await reservoir.channelController.addChannel({
      name: "Custom Scheduled",
      fetchMethod: registered.name,
      refreshInterval: 1,
    });

    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const state: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };
    await runScheduledFetchStep(reservoir, state, t0);

    const items = reservoir.contentController.listContent({
      channelIds: [channel.id],
      retained: false,
    });
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain("# Custom Scheduled Item");

    const markdownPath = path.join(tmpDir, channel.id, "from-custom.md");
    const supplementaryPath = path.join(tmpDir, channel.id, "from-custom", "note.txt");
    expect(fs.existsSync(markdownPath)).toBe(true);
    expect(fs.existsSync(supplementaryPath)).toBe(true);
    expect(fs.readFileSync(supplementaryPath, "utf-8")).toContain("attachment");
    expect(state.lastFetchAtByChannel[channel.id]).toBeDefined();
  });

  it("fetches channels that have refresh intervals configured", async () => {
    const fetchChannel = vi.fn().mockResolvedValue([]);
    const reservoir = {
      listChannels: () => [mkChannel({ id: "scheduled", refreshInterval: 1 })],
      fetchChannel,
    };

    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const state: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };
    await runScheduledFetchStep(reservoir, state, t0);

    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(fetchChannel).toHaveBeenCalledWith("scheduled");
    expect(state.lastFetchAtByChannel.scheduled).toBeDefined();
  });

  it("reports the affected content IDs to onFetchSuccess", async () => {
    const fetchChannel = vi.fn().mockResolvedValue([
      { id: "content-1", channelId: "scheduled", content: "one", fetchedAt: "", locks: [] },
      { id: "content-2", channelId: "scheduled", content: "two", fetchedAt: "", locks: [] },
    ]);
    const onFetchSuccess = vi.fn();
    const reservoir = {
      listChannels: () => [mkChannel({ id: "scheduled", refreshInterval: 1 })],
      fetchChannel,
    };

    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const state: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };

    await runScheduledFetchStep(reservoir, state, t0, { onFetchSuccess });

    expect(onFetchSuccess).toHaveBeenCalledTimes(1);
    expect(onFetchSuccess).toHaveBeenCalledWith("scheduled", ["content-1", "content-2"]);
  });

  it("fetches channels using default refresh interval when omitted", async () => {
    const fetchChannel = vi.fn().mockResolvedValue([]);
    const reservoir = {
      listChannels: () => [mkChannel({ id: "unscheduled" })],
      fetchChannel,
    };

    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const state: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };

    await runScheduledFetchStep(reservoir, state, t0);
    await runScheduledFetchStep(reservoir, state, t0 + 1000);

    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(fetchChannel).toHaveBeenCalledWith("unscheduled");
  });

  it("respects polling interval between attempts", async () => {
    const fetchChannel = vi.fn().mockResolvedValue([]);
    const reservoir = {
      listChannels: () => [mkChannel({ id: "scheduled", refreshInterval: 1 })],
      fetchChannel,
    };

    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const state: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };
    await runScheduledFetchStep(reservoir, state, t0);
    await runScheduledFetchStep(reservoir, state, t0 + 500);
    await runScheduledFetchStep(reservoir, state, t0 + 1000);

    expect(fetchChannel).toHaveBeenCalledTimes(2);
  });

  it("records errors and clears them after a succeeding run", async () => {
    const fetchChannel = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([]);

    const reservoir = {
      listChannels: () => [mkChannel({ id: "scheduled", refreshInterval: 1 })],
      fetchChannel,
    };

    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const state: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };

    await runScheduledFetchStep(reservoir, state, t0);
    expect(state.lastErrorByChannel.scheduled).toBe("boom");

    await runScheduledFetchStep(reservoir, state, t0 + 1000);
    expect(state.lastErrorByChannel.scheduled).toBeUndefined();
  });

  it("does not retry within rate-limit interval after a failed scheduled refresh", async () => {
    const fetchChannel = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([]);

    const reservoir = {
      listChannels: () => [
        mkChannel({ id: "scheduled", refreshInterval: 1, rateLimitInterval: 10 }),
      ],
      fetchChannel,
    };

    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const state: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };

    await runScheduledFetchStep(reservoir, state, t0);
    expect(state.lastErrorByChannel.scheduled).toBe("boom");

    await runScheduledFetchStep(reservoir, state, t0 + 9000);
    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(state.lastErrorByChannel.scheduled).toBe("boom");

    await runScheduledFetchStep(reservoir, state, t0 + 10000);
    expect(fetchChannel).toHaveBeenCalledTimes(2);
    expect(state.lastErrorByChannel.scheduled).toBeUndefined();
  });

  it("does not retry until refresh interval when refresh interval exceeds rate limit", async () => {
    const fetchChannel = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([]);

    const reservoir = {
      listChannels: () => [
        mkChannel({ id: "scheduled", refreshInterval: 10, rateLimitInterval: 3 }),
      ],
      fetchChannel,
    };

    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const state: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };

    await runScheduledFetchStep(reservoir, state, t0);
    expect(state.lastErrorByChannel.scheduled).toBe("boom");

    await runScheduledFetchStep(reservoir, state, t0 + 3000);
    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(state.lastErrorByChannel.scheduled).toBe("boom");

    await runScheduledFetchStep(reservoir, state, t0 + 9999);
    expect(fetchChannel).toHaveBeenCalledTimes(1);

    await runScheduledFetchStep(reservoir, state, t0 + 10000);
    expect(fetchChannel).toHaveBeenCalledTimes(2);
    expect(state.lastErrorByChannel.scheduled).toBeUndefined();
  });

  it("retries immediately after restart when previous scheduled refresh failed", async () => {
    const fetchChannel = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([]);

    const reservoir = {
      listChannels: () => [
        mkChannel({ id: "scheduled", refreshInterval: 1, rateLimitInterval: 1 }),
      ],
      fetchChannel,
    };

    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const firstRunState: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };

    await runScheduledFetchStep(reservoir, firstRunState, t0);
    expect(firstRunState.lastErrorByChannel.scheduled).toBe("boom");

    const restartedState: BackgroundFetchWorkerState = {
      startedAt: firstRunState.startedAt,
      lastFetchAtByChannel: firstRunState.lastFetchAtByChannel,
      lastAttemptAtByChannel: { ...firstRunState.lastFetchAtByChannel },
      lastErrorByChannel: firstRunState.lastErrorByChannel,
    };

    await runScheduledFetchStep(reservoir, restartedState, t0 + 1000);

    expect(fetchChannel).toHaveBeenCalledTimes(2);
    expect(restartedState.lastErrorByChannel.scheduled).toBeUndefined();
  });

  it("rehydrates failed status on restart and retries immediately on next scheduled tick", async () => {
    const fetchChannel = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([]);

    const reservoir = {
      listChannels: () => [
        mkChannel({ id: "scheduled", refreshInterval: 1, rateLimitInterval: 1 }),
      ],
      fetchChannel,
    };

    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const firstRunState: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };

    await runBackgroundFetchWorkerStep(tmpDir, reservoir, firstRunState, t0);
    expect(firstRunState.lastErrorByChannel.scheduled).toBe("boom");

    const existing = readBackgroundFetchWorkerStatusFile(tmpDir);
    const restartedState: BackgroundFetchWorkerState = {
      startedAt: existing?.startedAt ?? new Date(t0).toISOString(),
      lastFetchAtByChannel: existing?.lastFetchAtByChannel ?? {},
      lastAttemptAtByChannel: existing?.lastFetchAtByChannel
        ? { ...existing.lastFetchAtByChannel }
        : {},
      lastErrorByChannel: existing?.lastErrorByChannel ?? {},
    };

    await runScheduledFetchStep(reservoir, restartedState, t0 + 1000);

    expect(fetchChannel).toHaveBeenCalledTimes(2);
    expect(restartedState.lastErrorByChannel.scheduled).toBeUndefined();
  });

  it("does not fetch immediately after restart when channel is not stale", async () => {
    const fetchChannel = vi.fn().mockResolvedValue([]);

    const reservoir = {
      listChannels: () => [mkChannel({ id: "scheduled", refreshInterval: 10 })],
      fetchChannel,
    };

    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const firstRunState: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };

    await runScheduledFetchStep(reservoir, firstRunState, t0);
    expect(fetchChannel).toHaveBeenCalledTimes(1);

    const restartedState: BackgroundFetchWorkerState = {
      startedAt: firstRunState.startedAt,
      lastFetchAtByChannel: firstRunState.lastFetchAtByChannel,
      lastAttemptAtByChannel: { ...firstRunState.lastFetchAtByChannel },
      lastErrorByChannel: firstRunState.lastErrorByChannel,
    };

    await runScheduledFetchStep(reservoir, restartedState, t0 + 1000);
    expect(fetchChannel).toHaveBeenCalledTimes(1);

    await runScheduledFetchStep(reservoir, restartedState, t0 + 10000);
    expect(fetchChannel).toHaveBeenCalledTimes(2);
  });

  it("does not repeat fetches after restart when status file has recent fetch time", async () => {
    // GIVEN
    const realReservoir = new Reservoir(tmpDir).initialize();
    const channel = await realReservoir.channelController.addChannel({
      name: "Test Channel",
      fetchMethod: FetchMethod.RSS,
      refreshInterval: 10,
    });

    const fetchSpy = vi.spyOn(realReservoir, "fetchChannel").mockResolvedValue([]);
    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();

    // WHEN - first cycle
    const state1: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };
    await runBackgroundFetchWorkerStep(tmpDir, realReservoir, state1, t0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Short interval later - should NOT fetch
    const state2: BackgroundFetchWorkerState = {
      startedAt: state1.startedAt,
      lastFetchAtByChannel: state1.lastFetchAtByChannel,
      lastAttemptAtByChannel: { ...state1.lastFetchAtByChannel },
      lastErrorByChannel: state1.lastErrorByChannel,
    };
    await runScheduledFetchStep(realReservoir, state2, t0 + 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // THEN - after interval expires, should fetch again
    await runScheduledFetchStep(realReservoir, state2, t0 + 10000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("notifies the caller-supplied hook after each successful fetch", async () => {
    const onFetchSuccess = vi.fn();
    const reservoir = {
      listChannels: () => [mkChannel({ id: "notified", refreshInterval: 1 })],
      fetchChannel: vi.fn().mockResolvedValue([{ id: "x" }]),
    };

    const state: BackgroundFetchWorkerState = {
      startedAt: new Date().toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };

    await runBackgroundFetchWorkerStep(tmpDir, reservoir, state, Date.now(), { onFetchSuccess });

    expect(onFetchSuccess).toHaveBeenCalledTimes(1);
    expect(onFetchSuccess).toHaveBeenCalledWith("notified", ["x"]);
  });

  it("second start cycle avoids duplicate fetch within refresh interval", async () => {
    // GIVEN
    const realReservoir = new Reservoir(tmpDir).initialize();
    await realReservoir.channelController.addChannel({
      name: "Test Channel",
      fetchMethod: FetchMethod.RSS,
      refreshInterval: 10,
    });

    const fetchSpy = vi.spyOn(realReservoir, "fetchChannel").mockResolvedValue([]);
    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();

    // WHEN - first start cycle
    const state1: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };
    await runBackgroundFetchWorkerStep(tmpDir, realReservoir, state1, t0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Simulate restart shortly after: load persisted state
    const persisted = readBackgroundFetchWorkerStatusFile(tmpDir);
    expect(persisted?.lastFetchAtByChannel).toBeDefined();

    const state2: BackgroundFetchWorkerState = {
      startedAt: persisted?.startedAt ?? new Date(t0).toISOString(),
      lastFetchAtByChannel: persisted?.lastFetchAtByChannel ?? {},
      lastAttemptAtByChannel: persisted?.lastFetchAtByChannel
        ? { ...persisted.lastFetchAtByChannel }
        : {},
      lastErrorByChannel: persisted?.lastErrorByChannel ?? {},
    };

    // THEN - second cycle shortly after should NOT fetch again
    await runBackgroundFetchWorkerStep(tmpDir, realReservoir, state2, t0 + 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // But after interval expires, should fetch
    await runBackgroundFetchWorkerStep(tmpDir, realReservoir, state2, t0 + 10000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("startBackgroundFetchWorker / stopBackgroundFetchWorker / getBackgroundFetchWorkerStatus", () => {
  it("does not perform a duplicate fetch across stop/start within refresh interval", async () => {
    // GIVEN
    const reservoir = new Reservoir(tmpDir).initialize();
    const runMarkerPath = path.join(tmpDir, "fetch-run-marker.txt");
    const executablePath = createMarkerCustomFetcherExecutable(tmpDir, runMarkerPath);

    const registered = reservoir.addFetcher(executablePath);
    await reservoir.channelController.addChannel({
      name: "Start Stop Channel",
      fetchMethod: registered.name,
      refreshInterval: 500,
    });

    // WHEN - first start/stop cycle
    const firstStart = startWorkerForTest();
    await waitForWorkerOpportunity();
    await stopWorkerAndAwait(firstStart);

    const afterFirstCycleRuns = countRunsFromMarker(runMarkerPath);
    expect(afterFirstCycleRuns).toBe(1);

    // WHEN - second start/stop cycle shortly after restart
    const secondStart = startWorkerForTest();
    await waitForWorkerOpportunity();
    await stopWorkerAndAwait(secondStart);

    // THEN
    const afterSecondCycleRuns = countRunsFromMarker(runMarkerPath);
    expect(afterSecondCycleRuns).toBe(1);
  });

  it("performs a second fetch after restart when refresh interval has elapsed", async () => {
    let firstStart: Promise<void> | undefined;
    let secondStart: Promise<void> | undefined;
    let nowMs = new Date("2026-01-01T00:00:00.000Z").getTime();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    try {
      // GIVEN
      const reservoir = new Reservoir(tmpDir).initialize();
      const runMarkerPath = path.join(tmpDir, "fetch-run-marker.txt");
      const executablePath = createMarkerCustomFetcherExecutable(tmpDir, runMarkerPath);

      const registered = reservoir.addFetcher(executablePath);
      await reservoir.channelController.addChannel({
        name: "Start Stop Channel",
        fetchMethod: registered.name,
        refreshInterval: 500,
      });

      // WHEN - first start/stop cycle
      firstStart = startWorkerForTest();
      await waitForWorkerOpportunity();
      await stopWorkerAndAwait(firstStart);

      expect(countRunsFromMarker(runMarkerPath)).toBe(1);

      // Move mocked wall clock beyond refresh interval so next start should fetch again.
      nowMs += 1000000;

      // WHEN - second start/stop cycle
      secondStart = startWorkerForTest();
      await waitForWorkerOpportunity();
      await stopWorkerAndAwait(secondStart);

      // THEN
      expect(countRunsFromMarker(runMarkerPath)).toBe(2);
    } finally {
      const stopResult = stopBackgroundFetchWorker(tmpDir);
      if (stopResult.stopped) {
        await firstStart?.catch(() => undefined);
        await secondStart?.catch(() => undefined);
      }
      nowSpy.mockRestore();
    }
  });

  it("does not perform a duplicate fetch when shutdown happens without explicit stop", async () => {
    let firstStart: Promise<void> | undefined;
    let secondStart: Promise<void> | undefined;

    try {
      // GIVEN
      const reservoir = new Reservoir(tmpDir).initialize();
      const runMarkerPath = path.join(tmpDir, "fetch-run-marker.txt");
      const executablePath = createMarkerCustomFetcherExecutable(tmpDir, runMarkerPath);

      const registered = reservoir.addFetcher(executablePath);
      await reservoir.channelController.addChannel({
        name: "Start Stop Channel",
        fetchMethod: registered.name,
        refreshInterval: 500,
      });

      // WHEN - start and terminate via SIGINT, without stop API.
      firstStart = startWorkerForTest();
      await waitForWorkerOpportunity();
      process.emit("SIGINT");
      await firstStart;

      expect(countRunsFromMarker(runMarkerPath)).toBe(1);

      // Restart shortly after; no duplicate should happen within interval.
      secondStart = startWorkerForTest();
      await waitForWorkerOpportunity();
      await stopWorkerAndAwait(secondStart);

      // THEN
      expect(countRunsFromMarker(runMarkerPath)).toBe(1);
    } finally {
      const stopResult = stopBackgroundFetchWorker(tmpDir);
      if (stopResult.stopped) {
        await firstStart?.catch(() => undefined);
        await secondStart?.catch(() => undefined);
      }
    }
  });

  it("start writes pid file and can be stopped through the public API", async () => {
    new Reservoir(tmpDir).initialize();

    const startPromise = startBackgroundFetchWorker(tmpDir, {
      tickIntervalMs: 10,
      logLevel: "silent",
      logger: () => undefined,
      errorLogger: () => undefined,
    });

    const pidFile = path.join(tmpDir, ".res-fetcher.pid");
    const statusFile = path.join(tmpDir, ".res-fetcher-status.json");
    for (let i = 0; i < 20 && !fs.existsSync(pidFile); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (let i = 0; i < 20 && !fs.existsSync(statusFile); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(fs.existsSync(pidFile)).toBe(true);
    expect(fs.existsSync(statusFile)).toBe(true);
    expect(fs.readFileSync(pidFile, "utf-8").trim()).toBe(String(process.pid));

    const result = stopBackgroundFetchWorker(tmpDir);
    expect(result.stopped).toBe(true);

    await startPromise;
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("invokes onFetchSuccess hook for each channel fetch", async () => {
    const reservoir = new Reservoir(tmpDir).initialize();
    const executablePath = createFixtureCustomFetcherExecutable(tmpDir);
    const registered = reservoir.addFetcher(executablePath);
    const channel = await reservoir.channelController.addChannel({
      name: "Hook Success Channel",
      fetchMethod: registered.name,
      refreshInterval: 1,
    });

    const onFetchSuccess = vi.fn();
    const startPromise = startBackgroundFetchWorker(tmpDir, {
      tickIntervalMs: WORKER_TEST_TICK_INTERVAL_MS,
      logLevel: "silent",
      logger: () => undefined,
      errorLogger: () => undefined,
      onFetchSuccess,
    });

    try {
      await waitForWorkerOpportunity();
      await waitForHookCalls(() => onFetchSuccess.mock.calls.length);
      expect(onFetchSuccess).toHaveBeenCalledWith(channel.id, [expect.any(String)]);
    } finally {
      const result = stopBackgroundFetchWorker(tmpDir);
      if (result.stopped) {
        await startPromise;
      }
    }
  });

  it("invokes onFetchError hook when a channel fetch fails", async () => {
    const reservoir = new Reservoir(tmpDir).initialize();
    const executablePath = createFailingCustomFetcherExecutable(tmpDir);
    const registered = reservoir.addFetcher(executablePath);
    const channel = await reservoir.channelController.addChannel({
      name: "Hook Error Channel",
      fetchMethod: registered.name,
      refreshInterval: 1,
    });

    const onFetchError = vi.fn();
    const startPromise = startBackgroundFetchWorker(tmpDir, {
      tickIntervalMs: WORKER_TEST_TICK_INTERVAL_MS,
      logLevel: "silent",
      logger: () => undefined,
      errorLogger: () => undefined,
      onFetchError,
    });

    try {
      await waitForWorkerOpportunity();
      await waitForHookCalls(() => onFetchError.mock.calls.length);
      expect(onFetchError).toHaveBeenCalledWith(channel.id, expect.any(String));
    } finally {
      const result = stopBackgroundFetchWorker(tmpDir);
      if (result.stopped) {
        await startPromise;
      }
    }
  });

  it("start throws when an existing fetcher pid is running", async () => {
    fs.writeFileSync(path.join(tmpDir, ".res-fetcher.pid"), `${process.pid}\n`, "utf-8");

    await expect(startBackgroundFetchWorker(tmpDir)).rejects.toThrow("already running");
  });

  it("status returns running=true when pid exists and process is alive", () => {
    fs.writeFileSync(path.join(tmpDir, ".res-fetcher.pid"), `${process.pid}\n`, "utf-8");
    fs.writeFileSync(
      path.join(tmpDir, ".res-fetcher-status.json"),
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          lastHeartbeatAt: "2026-01-01T00:00:01.000Z",
          lastFetchAtByChannel: { a: "2026-01-01T00:00:00.500Z" },
          lastErrorByChannel: {},
        },
        null,
        2,
      ),
      "utf-8",
    );

    const status = getBackgroundFetchWorkerStatus(tmpDir);

    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.lastFetchAtByChannel?.a).toBe("2026-01-01T00:00:00.500Z");
  });

  it("stop clears pid file when a running pid is present", () => {
    fs.writeFileSync(path.join(tmpDir, ".res-fetcher.pid"), `${process.pid}\n`, "utf-8");

    const result = stopBackgroundFetchWorker(tmpDir);

    expect(result.stopped).toBe(true);
    expect(result.pid).toBe(process.pid);
    expect(fs.existsSync(path.join(tmpDir, ".res-fetcher.pid"))).toBe(false);
  });

  it("stop returns not running when no pid file exists", () => {
    const result = stopBackgroundFetchWorker(tmpDir);
    expect(result.stopped).toBe(false);
    expect(result.message).toContain("not running");
  });
});

describe("corrupt/truncated status file resilience", () => {
  const statusPath = (): string => path.join(tmpDir, ".res-fetcher-status.json");

  it("readBackgroundFetchWorkerStatusFile returns null for an empty status file", () => {
    fs.writeFileSync(statusPath(), "", "utf-8");

    expect(() => readBackgroundFetchWorkerStatusFile(tmpDir)).not.toThrow();
    expect(readBackgroundFetchWorkerStatusFile(tmpDir)).toBeNull();
  });

  it("readBackgroundFetchWorkerStatusFile returns null for malformed JSON", () => {
    fs.writeFileSync(statusPath(), '{ "this is not valid json', "utf-8");

    expect(() => readBackgroundFetchWorkerStatusFile(tmpDir)).not.toThrow();
    expect(readBackgroundFetchWorkerStatusFile(tmpDir)).toBeNull();
  });

  it("readBackgroundFetchWorkerStatusFile still parses valid JSON", () => {
    const valid = {
      pid: 1234,
      startedAt: "2026-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2026-01-01T00:00:01.000Z",
      lastFetchAtByChannel: { a: "2026-01-01T00:00:00.500Z" },
      lastErrorByChannel: {},
    };
    fs.writeFileSync(statusPath(), JSON.stringify(valid, null, 2), "utf-8");

    expect(readBackgroundFetchWorkerStatusFile(tmpDir)).toEqual(valid);
  });

  it("startBackgroundFetchWorker starts successfully with a corrupt status file present", async () => {
    new Reservoir(tmpDir).initialize();
    fs.writeFileSync(statusPath(), '{ "this is not valid json', "utf-8");

    const startPromise = startWorkerForTest();
    try {
      await waitForWorkerOpportunity();
      expect(fs.existsSync(path.join(tmpDir, ".res-fetcher.pid"))).toBe(true);
    } finally {
      const result = stopBackgroundFetchWorker(tmpDir);
      if (result.stopped) {
        await startPromise;
      }
    }
  });

  it("persists a valid status file after runBackgroundFetchWorkerStep", async () => {
    const reservoir = new Reservoir(tmpDir).initialize();
    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const state: BackgroundFetchWorkerState = {
      startedAt: new Date(t0).toISOString(),
      lastFetchAtByChannel: {},
      lastAttemptAtByChannel: {},
      lastErrorByChannel: {},
    };

    await runBackgroundFetchWorkerStep(tmpDir, reservoir, state, t0);

    const persisted = readBackgroundFetchWorkerStatusFile(tmpDir);
    expect(persisted).not.toBeNull();
    expect(persisted?.pid).toBe(process.pid);
    expect(persisted?.startedAt).toBe(state.startedAt);
  });
});
