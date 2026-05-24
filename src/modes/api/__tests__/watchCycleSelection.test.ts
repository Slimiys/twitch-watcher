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
  loadStatisticsConfig: vi.fn(() => ({ storagePath: './statistics-test-select' })),
  loadRetryConfig: vi.fn(() => ({})),
}));

function streamer(name: string): StreamerInfo {
  return {
    username: name,
    channelId: name,
    channelPoints: 0,
    isOnline: true,
    broadcastId: '1',
    game: null,
    title: null,
    tags: [],
    spadeUrl: 'https://spade.test',
    startTime: Date.now(),
    initialChannelPoints: null,
    lastChannelPoints: null,
    streamPointsEarned: 0,
  };
}

describe('selectStreamersForWatchCycle', () => {
  let watcher: StreamWatcher;

  beforeEach(() => {
    watcher = new StreamWatcher('token', 'ua', ['a', 'b', 'c']);
  });

  it('returns all online when WATCH_ALL_ONLINE_CHANNELS is enabled', () => {
    (watcher as any).watchAllOnlineChannels = true;
    const all = [streamer('a'), streamer('b'), streamer('c')];
    const selected = (watcher as any).selectStreamersForWatchCycle(all);
    expect(selected.map((s: StreamerInfo) => s.username)).toEqual(['a', 'b', 'c']);
  });

  it('rotating subset when rotation mode is enabled', () => {
    (watcher as any).watchAllOnlineChannels = false;
    (watcher as any).maxSimultaneousChannels = 2;
    const all = [streamer('a'), streamer('b'), streamer('c')];
    const selected = (watcher as any).selectStreamersForWatchCycle(all);
    expect(selected).toHaveLength(2);
  });
});
