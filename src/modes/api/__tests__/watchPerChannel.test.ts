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
  loadStatisticsConfig: vi.fn(() => ({ storagePath: './statistics-test-per-channel' })),
  loadRetryConfig: vi.fn(() => ({})),
}));

function onlineStreamer(name: string): StreamerInfo {
  return {
    username: name,
    channelId: name,
    channelPoints: 100,
    isOnline: true,
    broadcastId: '1',
    game: null,
    title: null,
    tags: [],
    spadeUrl: 'https://spade.test',
    startTime: Date.now(),
    initialChannelPoints: 90,
    lastChannelPoints: 100,
    streamPointsEarned: 10,
  };
}

describe('per-channel watch timers', () => {
  let watcher: StreamWatcher;

  beforeEach(() => {
    watcher = new StreamWatcher('token', 'ua', ['a']);
    (watcher as any).watchMode = 'per-channel';
    (watcher as any).isRunning = true;
  });

  it('startChannelWatchTimer регистрирует активный канал', () => {
    (watcher as any).streamers.set('alice', onlineStreamer('alice'));
    (watcher as any).startChannelWatchTimer('alice');
    expect((watcher as any).channelWatchActive.has('alice')).toBe(true);
  });

  it('startChannelWatchTimer идempotent для одного канала', () => {
    (watcher as any).streamers.set('alice', onlineStreamer('alice'));
    (watcher as any).startChannelWatchTimer('alice');
    (watcher as any).startChannelWatchTimer('alice');
    expect((watcher as any).channelWatchActive.size).toBe(1);
  });

  it('stopChannelWatchTimer снимает канал из активных', () => {
    (watcher as any).channelWatchActive.add('alice');
    (watcher as any).stopChannelWatchTimer('alice');
    expect((watcher as any).channelWatchActive.has('alice')).toBe(false);
  });

  it('syncChannelWatchTimers запускает таймеры только для онлайн', () => {
    (watcher as any).streamers.set('alice', onlineStreamer('alice'));
    const offline = onlineStreamer('bob');
    offline.isOnline = false;
    (watcher as any).streamers.set('bob', offline);
    (watcher as any).syncChannelWatchTimers();
    expect((watcher as any).channelWatchActive.has('alice')).toBe(true);
    expect((watcher as any).channelWatchActive.has('bob')).toBe(false);
  });
});
