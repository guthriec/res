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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "res-fetcher-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

describe("runScheduledFetchStep", () => {
  it("runs a registered custom fetcher end-to-end and persists output", async () => {
    const reservoir = new Reservoir(tmpDir).initialize();
    const fetcherBaseName = `custom-fetcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const executablePath = path.join(
      tmpDir,
      process.platform === "win32" ? `${fetcherBaseName}.cmd` : `${fetcherBaseName}.sh`,
    );

    if (process.platform === "win32") {
      fs.writeFileSync(
        executablePath,
        [
          "@echo off",
          "mkdir outs 2>nul",
          "(echo # Custom Scheduled Item)> outs\\from-custom.md",
          "mkdir outs\\from-custom 2>nul",
          "(echo attachment)> outs\\from-custom\\note.txt",
        ].join("\r\n"),
        "utf-8",
      );
    } else {
      fs.writeFileSync(
        executablePath,
        [
          "#!/bin/sh",
          "cat <<'EOF' > outs/from-custom.md",
          "# Custom Scheduled Item",
          "EOF",
          "mkdir -p outs/from-custom",
          "cat <<'EOF' > outs/from-custom/note.txt",
          "attachment",
          "EOF",
        ].join("\n"),
        "utf-8",
      );
      fs.chmodSync(executablePath, 0o755);
    }

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
