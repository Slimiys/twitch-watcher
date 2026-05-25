import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StreamWatcher } from '../StreamWatcher';
import { StreamerInfo } from '../types';

vi.mock('../TwitchAPI', () => ({
  TwitchAPI: vi.fn().mockImplementation(() => ({
    setValidatedUserId: vi.fn(),
  })),
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    important: vi.fn(),
  },
}));

vi.mock('../configLoader', () => ({
  loadStatisticsConfig: vi.fn(() => ({ storagePath: './statistics-test-active-watch' })),
  loadRetryConfig: vi.fn(() => ({})),
}));

function onlineWithoutStartTime(name: string): StreamerInfo {
  return {
    username: name,
    channelId: name,
    channelPoints: 100,
    isOnline: true,
    broadcastId: '1',
    game: null,
    title: null,
    tags: [],
    spadeUrl: null,
    startTime: 0,
    initialChannelPoints: 90,
    lastChannelPoints: 100,
    streamPointsEarned: 10,
  };
}

describe('getActiveWatchCount', () => {
  let watcher: StreamWatcher;

  beforeEach(() => {
    watcher = new StreamWatcher('token', 'ua', ['a', 'b', 'c']);
  });

  it('считает онлайн-стримеров даже если startTime был 0', () => {
    (watcher as any).streamers.set('a', onlineWithoutStartTime('a'));
    (watcher as any).streamers.set('b', onlineWithoutStartTime('b'));
    (watcher as any).streamers.set('c', onlineWithoutStartTime('c'));

    expect(watcher.getActiveWatchCount()).toBe(3);
    expect((watcher as any).streamers.get('a').startTime).toBeGreaterThan(0);
  });

  it('getOverallStats считает стримеров и баллы без getStatistics(false)', () => {
    const a = onlineWithoutStartTime('a');
    a.initialChannelPoints = 100;
    a.channelPoints = 115;
    a.lastChannelPoints = 115;
    const b = onlineWithoutStartTime('b');
    b.initialChannelPoints = 200;
    b.channelPoints = 205;
    b.lastChannelPoints = 205;
    (watcher as any).streamers.set('a', a);
    (watcher as any).streamers.set('b', b);
    const offline = onlineWithoutStartTime('c');
    offline.isOnline = false;
    (watcher as any).streamers.set('c', offline);
    (watcher as any).lastGlobalActivityAt = Date.now() - 30_000;

    const overall = watcher.getOverallStats();
    expect(overall.streamersCount).toBe(3);
    expect(overall.activeWatches).toBe(2);
    expect(overall.totalPointsEarned).toBe(20);
    expect(overall.lastActivity).toBeGreaterThan(0);
  });

  it('startChannelWatchTimer выставляет startTime для онлайн без сессии', () => {
    (watcher as any).watchMode = 'per-channel';
    (watcher as any).isRunning = true;
    (watcher as any).streamers.set('alice', onlineWithoutStartTime('alice'));

    (watcher as any).startChannelWatchTimer('alice');

    expect((watcher as any).streamers.get('alice').startTime).toBeGreaterThan(0);
    expect(watcher.getActiveWatchCount()).toBe(1);
  });
});
