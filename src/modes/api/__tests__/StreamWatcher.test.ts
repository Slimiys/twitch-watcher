/**
 * Тесты для StreamWatcher
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamWatcher } from '../StreamWatcher';
import { TwitchAPI } from '../TwitchAPI';
import { StatisticsStorage } from '../StatisticsStorage';

// Мокаем зависимости
vi.mock('../TwitchAPI', () => ({
  TwitchAPI: vi.fn().mockImplementation(() => ({
    initializeStreamer: vi.fn(),
    updateStreamerInfo: vi.fn(),
    sendMinuteWatched: vi.fn(),
    validateToken: vi.fn(),
    validateTokenWithInfo: vi.fn(),
    getUserId: vi.fn(),
    getSpadeUrl: vi.fn(),
  })),
}));

vi.mock('../WebSocketManager', () => ({
  WebSocketManager: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    getConnectionState: vi.fn(() => 'OPEN'),
  })),
}));

vi.mock('../StatisticsStorage', () => ({
  StatisticsStorage: vi.fn().mockImplementation(() => ({
    createSession: vi.fn(() => 'session-id'),
    endSession: vi.fn(),
    updateSession: vi.fn(),
    getSessions: vi.fn(() => []),
    getAggregatedStatistics: vi.fn(() => ({
      totalSessions: 0,
      totalPointsEarned: 0,
      averagePointsPerSession: 0,
      totalWatchTime: 0,
    })),
  })),
}));

vi.mock('../GraphQLClient', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({
    getStreamInfo: vi.fn(),
    getChannelPoints: vi.fn(),
    claimBonus: vi.fn(),
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
  loadRetryConfig: vi.fn(() => ({
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 1000,
    multiplier: 2,
    jitter: true,
  })),
}));

describe('StreamWatcher', () => {
  let streamWatcher: StreamWatcher;
  const mockAuthToken = 'test_token';
  const mockUserAgent = 'test_user_agent';
  const mockStreamers = ['testuser1', 'testuser2'];

  beforeEach(() => {
    vi.clearAllMocks();
    streamWatcher = new StreamWatcher(mockAuthToken, mockUserAgent, mockStreamers);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getStatistics', () => {
    it('должен вернуть статистику для онлайн стримеров', () => {
      const stats = streamWatcher.getStatistics();

      expect(Array.isArray(stats)).toBe(true);
    });

    it('должен вернуть статистику включая офлайн стримеров', () => {
      const stats = streamWatcher.getStatistics(true);

      expect(Array.isArray(stats)).toBe(true);
    });
  });

  describe('start', () => {
    it('должен запустить просмотр стримов', async () => {
      // Мокаем методы TwitchAPI
      const mockTwitchAPI = (streamWatcher as any).twitchAPI;
      mockTwitchAPI.initializeStreamer = vi.fn().mockResolvedValue({
        username: 'testuser',
        channelId: '123',
        channelPoints: 1000,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: 'https://spade.twitch.tv/test',
        startTime: Date.now(),
        initialChannelPoints: 1000,
        lastChannelPoints: 1000,
        streamPointsEarned: 0,
      });
      mockTwitchAPI.validateToken = vi.fn().mockResolvedValue(true);
      mockTwitchAPI.validateTokenWithInfo = vi.fn().mockResolvedValue({
        isValid: true,
        userId: 'user123',
        expiresAt: Date.now() + 3600000,
      });
      mockTwitchAPI.getUserId = vi.fn().mockResolvedValue('user123');

      // Мокаем WebSocketManager
      const mockWebSocketManager = (streamWatcher as any).wsManager;
      if (mockWebSocketManager) {
        mockWebSocketManager.connect = vi.fn();
      }

      await streamWatcher.start();

      // Проверяем, что метод был вызван
      expect(mockTwitchAPI.initializeStreamer).toHaveBeenCalled();
    });
  });
});

