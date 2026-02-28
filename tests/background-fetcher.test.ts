import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createBackgroundFetcherState,
  getBackgroundFetcherStatusPath,
  getBackgroundFetcherStatus,
  readBackgroundFetcherStatusFile,
  runScheduledFetchTick,
  startBackgroundFetcher,
  stopBackgroundFetcher,
} from '../src/background-fetcher';
import { Reservoir } from '../src/reservoir';
import { Channel, DEFAULT_REFRESH_INTERVAL_SECONDS, FetchMethod } from '../src/types';

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
    fetchParams: overrides.fetchParams ?? { url: 'https://example.com/feed' },
    rateLimitInterval: overrides.rateLimitInterval,
    refreshInterval: overrides.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS,
    retainedLocks: overrides.retainedLocks ?? [],
  };
}

describe('runScheduledFetchTick', () => {
  it('runs a registered custom fetcher end-to-end and persists output', async () => {
    const reservoir = Reservoir.initialize(tmpDir);
    const fetcherBaseName = `custom-fetcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const executablePath = path.join(
      tmpDir,
      process.platform === 'win32' ? `${fetcherBaseName}.cmd` : `${fetcherBaseName}.sh`,
    );

    if (process.platform === 'win32') {
      fs.writeFileSync(
        executablePath,
        [
          '@echo off',
          'mkdir outs 2>nul',
          '(echo # Custom Scheduled Item)> outs\\from-custom.md',
          'mkdir outs\\from-custom 2>nul',
          '(echo attachment)> outs\\from-custom\\note.txt',
        ].join('\r\n'),
        'utf-8',
      );
    } else {
      fs.writeFileSync(
        executablePath,
        [
          '#!/bin/sh',
          'cat <<\'EOF\' > outs/from-custom.md',
          '# Custom Scheduled Item',
          'EOF',
          'mkdir -p outs/from-custom',
          'cat <<\'EOF\' > outs/from-custom/note.txt',
          'attachment',
          'EOF',
        ].join('\n'),
        'utf-8',
      );
      fs.chmodSync(executablePath, 0o755);
    }

    const registered = reservoir.addFetcher(executablePath);
    const channel = reservoir.channelController.addChannel({
      name: 'Custom Scheduled',
      fetchMethod: registered.name,
      refreshInterval: 1,
    });

    const state = createBackgroundFetcherState();
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    await runScheduledFetchTick(reservoir, state, t0);

    const items = reservoir.contentController.listContent({ channelIds: [channel.id], retained: false });
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain('# Custom Scheduled Item');

    const markdownPath = path.join(tmpDir, channel.id, 'from-custom.md');
    const supplementaryPath = path.join(tmpDir, channel.id, 'from-custom', 'note.txt');
    expect(fs.existsSync(markdownPath)).toBe(true);
    expect(fs.existsSync(supplementaryPath)).toBe(true);
    expect(fs.readFileSync(supplementaryPath, 'utf-8')).toContain('attachment');
    expect(state.lastFetchAtByChannel[channel.id]).toBeDefined();
  });

  it('fetches channels that have refresh intervals configured', async () => {
    const fetchChannel = vi.fn().mockResolvedValue([]);
    const reservoir = {
      listChannels: () => [mkChannel({ id: 'scheduled', refreshInterval: 1 })],
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
      listChannels: () => [mkChannel({ id: 'scheduled', refreshInterval: 1 })],
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
      listChannels: () => [mkChannel({ id: 'scheduled', refreshInterval: 1 })],
      fetchChannel,
    };

    const state = createBackgroundFetcherState();
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();

    await runScheduledFetchTick(reservoir, state, t0);
    expect(state.lastErrorByChannel.scheduled).toBe('boom');

    await runScheduledFetchTick(reservoir, state, t0 + 1000);
    expect(state.lastErrorByChannel.scheduled).toBeUndefined();
  });

  it('does not retry within rate-limit interval after a failed scheduled refresh', async () => {
    const fetchChannel = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);

    const reservoir = {
      listChannels: () => [mkChannel({ id: 'scheduled', refreshInterval: 1, rateLimitInterval: 10 })],
      fetchChannel,
    };

    const state = createBackgroundFetcherState();
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();

    await runScheduledFetchTick(reservoir, state, t0);
    expect(state.lastErrorByChannel.scheduled).toBe('boom');

    await runScheduledFetchTick(reservoir, state, t0 + 9000);
    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(state.lastErrorByChannel.scheduled).toBe('boom');

    await runScheduledFetchTick(reservoir, state, t0 + 10000);
    expect(fetchChannel).toHaveBeenCalledTimes(2);
    expect(state.lastErrorByChannel.scheduled).toBeUndefined();
  });

  it('does not retry until refresh interval when refresh interval exceeds rate limit', async () => {
    const fetchChannel = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);

    const reservoir = {
      listChannels: () => [mkChannel({ id: 'scheduled', refreshInterval: 10, rateLimitInterval: 3 })],
      fetchChannel,
    };

    const state = createBackgroundFetcherState();
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();

    await runScheduledFetchTick(reservoir, state, t0);
    expect(state.lastErrorByChannel.scheduled).toBe('boom');

    await runScheduledFetchTick(reservoir, state, t0 + 3000);
    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(state.lastErrorByChannel.scheduled).toBe('boom');

    await runScheduledFetchTick(reservoir, state, t0 + 9999);
    expect(fetchChannel).toHaveBeenCalledTimes(1);

    await runScheduledFetchTick(reservoir, state, t0 + 10000);
    expect(fetchChannel).toHaveBeenCalledTimes(2);
    expect(state.lastErrorByChannel.scheduled).toBeUndefined();
  });

  it('retries immediately after restart when previous scheduled refresh failed', async () => {
    const fetchChannel = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);

    const reservoir = {
      listChannels: () => [mkChannel({ id: 'scheduled', refreshInterval: 1, rateLimitInterval: 1 })],
      fetchChannel,
    };

    const firstRunState = createBackgroundFetcherState();
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();

    await runScheduledFetchTick(reservoir, firstRunState, t0);
    expect(firstRunState.lastErrorByChannel.scheduled).toBe('boom');

    const restartedState = createBackgroundFetcherState({
      startedAt: firstRunState.startedAt,
      lastFetchAtByChannel: firstRunState.lastFetchAtByChannel,
      lastErrorByChannel: firstRunState.lastErrorByChannel,
    });

    await runScheduledFetchTick(reservoir, restartedState, t0 + 1000);

    expect(fetchChannel).toHaveBeenCalledTimes(2);
    expect(restartedState.lastErrorByChannel.scheduled).toBeUndefined();
  });

  it('rehydrates failed status on restart and retries immediately on next scheduled tick', async () => {
    const fetchChannel = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);

    const reservoir = {
      listChannels: () => [mkChannel({ id: 'scheduled', refreshInterval: 1, rateLimitInterval: 1 })],
      fetchChannel,
    };

    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    const firstRunState = createBackgroundFetcherState();

    await runScheduledFetchTick(reservoir, firstRunState, t0);
    expect(firstRunState.lastErrorByChannel.scheduled).toBe('boom');

    fs.writeFileSync(
      getBackgroundFetcherStatusPath(tmpDir),
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: firstRunState.startedAt,
          lastHeartbeatAt: new Date(t0).toISOString(),
          lastFetchAtByChannel: firstRunState.lastFetchAtByChannel,
          lastErrorByChannel: firstRunState.lastErrorByChannel,
        },
        null,
        2,
      ),
      'utf-8',
    );

    const existing = readBackgroundFetcherStatusFile(tmpDir);
    const restartedState = createBackgroundFetcherState({
      startedAt: existing?.startedAt,
      lastFetchAtByChannel: existing?.lastFetchAtByChannel,
      lastErrorByChannel: existing?.lastErrorByChannel,
    });

    await runScheduledFetchTick(reservoir, restartedState, t0 + 1000);

    expect(fetchChannel).toHaveBeenCalledTimes(2);
    expect(restartedState.lastErrorByChannel.scheduled).toBeUndefined();
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
