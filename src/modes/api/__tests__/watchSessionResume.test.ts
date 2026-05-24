import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  loadStatisticsConfig: vi.fn(() => ({ storagePath: './statistics-test-resume' })),
  loadRetryConfig: vi.fn(() => ({})),
}));

function baseStreamer(overrides: Partial<StreamerInfo> = {}): StreamerInfo {
  return {
    username: 'testuser',
    channelId: 'ch-1',
    channelPoints: 1000,
    isOnline: true,
    broadcastId: 'broadcast-abc',
    game: null,
    title: null,
    tags: [],
    spadeUrl: null,
    startTime: Date.now(),
    initialChannelPoints: 900,
    lastChannelPoints: 1000,
    streamPointsEarned: 100,
    ...overrides,
  };
}

describe('restoreWatchSessionAfterRestart', () => {
  let watcher: StreamWatcher;

  beforeEach(() => {
    watcher = new StreamWatcher('token', 'ua', ['testuser']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('восстанавливает startTime при том же broadcastId', () => {
    const savedStart = Date.now() - 45 * 60 * 1000;
    (watcher as any).pointsState = {
      testuser: {
        channelPoints: 1000,
        initialChannelPoints: 900,
        lastChannelPoints: 1000,
        streamPointsEarned: 100,
        isOnline: true,
        startTime: savedStart,
        broadcastId: 'broadcast-abc',
        updatedAt: Date.now() - 5000,
      },
    };

    const streamer = baseStreamer({ startTime: Date.now() });
    (watcher as any).streamers.set('testuser', streamer);
    (watcher as any).restoreWatchSessionAfterRestart(streamer);

    expect(streamer.startTime).toBe(savedStart);
    const stats = watcher.getStatistics(true);
    const row = stats.find((s) => s.streamerName === 'testuser');
    expect(row?.elapsedTime).toBeGreaterThanOrEqual(45 * 60 * 1000 - 1000);
  });

  it('начинает новую сессию при другом broadcastId', () => {
    const savedStart = Date.now() - 60 * 60 * 1000;
    (watcher as any).pointsState = {
      testuser: {
        channelPoints: 1000,
        initialChannelPoints: 900,
        lastChannelPoints: 1000,
        streamPointsEarned: 100,
        isOnline: true,
        startTime: savedStart,
        broadcastId: 'old-broadcast',
        updatedAt: Date.now() - 5000,
      },
    };

    const before = Date.now();
    const streamer = baseStreamer({ broadcastId: 'new-broadcast', startTime: 0 });
    (watcher as any).restoreWatchSessionAfterRestart(streamer);

    expect(streamer.startTime).toBeGreaterThanOrEqual(before);
    expect(streamer.startTime).toBeLessThanOrEqual(Date.now());
    expect(streamer.startTime).not.toBe(savedStart);
  });

  it('сбрасывает startTime для офлайн стримера', () => {
    const streamer = baseStreamer({ isOnline: false, startTime: Date.now() - 10000 });
    (watcher as any).restoreWatchSessionAfterRestart(streamer);
    expect(streamer.startTime).toBe(0);
  });
});
