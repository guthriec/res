import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createBackgroundFetcherState,
  getBackgroundFetcherStatus,
  runScheduledFetchTick,
  startBackgroundFetcher,
  stopBackgroundFetcher,
} from '../src/background-fetcher';
import { Channel, DEFAULT_REFRESH_INTERVAL_MS, FetchMethod } from '../src/types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-fetcher-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mkChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: overrides.id ?? 'ch-1',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    name: overrides.name ?? 'Channel',
    fetchMethod: overrides.fetchMethod ?? FetchMethod.RSS,
    url: overrides.url ?? 'https://example.com/feed',
    script: overrides.script,
    rateLimitInterval: overrides.rateLimitInterval,
    refreshInterval: overrides.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_MS,
    retainedLocks: overrides.retainedLocks ?? [],
  };
}

describe('runScheduledFetchTick', () => {
  it('fetches channels that have refresh intervals configured', async () => {
    const fetchChannel = vi.fn().mockResolvedValue([]);
    const reservoir = {
      listChannels: () => [mkChannel({ id: 'scheduled', refreshInterval: 1000 })],
      fetchChannel,
    };

    const state = createBackgroundFetcherState();
    await runScheduledFetchTick(reservoir, state, new Date('2026-01-01T00:00:00.000Z').getTime());

    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(fetchChannel).toHaveBeenCalledWith('scheduled');
    expect(state.lastFetchAtByChannel.scheduled).toBeDefined();
  });

  it('fetches channels using default refresh interval when omitted', async () => {
    const fetchChannel = vi.fn().mockResolvedValue([]);
    const reservoir = {
      listChannels: () => [mkChannel({ id: 'unscheduled' })],
      fetchChannel,
    };

    const state = createBackgroundFetcherState();
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();

    await runScheduledFetchTick(reservoir, state, t0);
    await runScheduledFetchTick(reservoir, state, t0 + 1000);

    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(fetchChannel).toHaveBeenCalledWith('unscheduled');
  });

  it('respects polling interval between attempts', async () => {
    const fetchChannel = vi.fn().mockResolvedValue([]);
    const reservoir = {
      listChannels: () => [mkChannel({ id: 'scheduled', refreshInterval: 1000 })],
      fetchChannel,
    };

    const state = createBackgroundFetcherState();
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    await runScheduledFetchTick(reservoir, state, t0);
    await runScheduledFetchTick(reservoir, state, t0 + 500);
    await runScheduledFetchTick(reservoir, state, t0 + 1000);

    expect(fetchChannel).toHaveBeenCalledTimes(2);
  });

  it('records errors and clears them after a succeeding run', async () => {
    const fetchChannel = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);

    const reservoir = {
      listChannels: () => [mkChannel({ id: 'scheduled', refreshInterval: 1000 })],
      fetchChannel,
    };

    const state = createBackgroundFetcherState();
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();

    await runScheduledFetchTick(reservoir, state, t0);
    expect(state.lastErrorByChannel.scheduled).toBe('boom');

    await runScheduledFetchTick(reservoir, state, t0 + 1000);
    expect(state.lastErrorByChannel.scheduled).toBeUndefined();
  });
});

describe('startBackgroundFetcher / stopBackgroundFetcher / getBackgroundFetcherStatus', () => {
  it('start writes pid file and runs provided loop in-process', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);

    await startBackgroundFetcher(tmpDir, { runner });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(path.resolve(tmpDir), {});
    const pidFile = path.join(tmpDir, '.res-fetcher.pid');
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(fs.readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
  });

  it('start throws when an existing fetcher pid is running', async () => {
    fs.writeFileSync(path.join(tmpDir, '.res-fetcher.pid'), `${process.pid}\n`, 'utf-8');
    const runner = vi.fn();

    await expect(startBackgroundFetcher(tmpDir, { runner })).rejects.toThrow('already running');
    expect(runner).not.toHaveBeenCalled();
  });

  it('status returns running=true when pid exists and process is alive', () => {
    fs.writeFileSync(path.join(tmpDir, '.res-fetcher.pid'), `${process.pid}\n`, 'utf-8');
    fs.writeFileSync(
      path.join(tmpDir, '.res-fetcher-status.json'),
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: '2026-01-01T00:00:00.000Z',
          lastHeartbeatAt: '2026-01-01T00:00:01.000Z',
          lastFetchAtByChannel: { a: '2026-01-01T00:00:00.500Z' },
          lastErrorByChannel: {},
        },
        null,
        2,
      ),
      'utf-8',
    );

    const status = getBackgroundFetcherStatus(tmpDir);

    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.lastFetchAtByChannel?.a).toBe('2026-01-01T00:00:00.500Z');
  });

  it('stop sends SIGTERM and clears pid file', () => {
    fs.writeFileSync(path.join(tmpDir, '.res-fetcher.pid'), `${process.pid}\n`, 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    const result = stopBackgroundFetcher(tmpDir);

    expect(result.stopped).toBe(true);
    expect(result.pid).toBe(process.pid);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(fs.existsSync(path.join(tmpDir, '.res-fetcher.pid'))).toBe(false);
  });

  it('stop returns not running when no pid file exists', () => {
    const result = stopBackgroundFetcher(tmpDir);
    expect(result.stopped).toBe(false);
    expect(result.message).toContain('not running');
  });
});
