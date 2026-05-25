/**
 * Тесты для TwitchAPI
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TwitchAPI } from '../TwitchAPI';
import { StreamerInfo } from '../types';

// Мокаем зависимости
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

vi.mock('../retry', () => ({
  fetchWithRetry: vi.fn(async (url: string, options: any, retryConfig: any, label: string) => {
    const response = await global.fetch(url, options);
    return response;
  }),
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

vi.mock('../utils', () => ({
  extractSpadeUrl: vi.fn(() => 'https://spade.twitch.tv/test'),
  extractSettingsUrl: vi.fn(() => 'https://settings.twitch.tv/test'),
  encodePayload: vi.fn((payload: any) => JSON.stringify(payload)),
}));

describe('TwitchAPI', () => {
  let twitchAPI: TwitchAPI;
  const mockAuthToken = 'test_token';
  const mockUserAgent = 'test_user_agent';

  beforeEach(() => {
    vi.clearAllMocks();
    twitchAPI = new TwitchAPI(mockAuthToken, mockUserAgent);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('updateStreamerInfo', () => {
    it('должен обновить информацию о стримере когда он онлайн', async () => {
      const mockStreamInfo = {
        broadcastId: '123456',
        title: 'Test Stream',
        game: { name: 'Test Game' },
        tags: [{ name: 'tag1' }],
        viewersCount: 100,
      };

      const mockGraphQLClient = (twitchAPI as any).graphqlClient;
      mockGraphQLClient.getStreamInfo = vi.fn().mockResolvedValue(mockStreamInfo);
      mockGraphQLClient.getChannelPoints = vi.fn().mockResolvedValue({ balance: 1000 });

      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 0,
        isOnline: false,
        broadcastId: null,
        game: null,
        title: null,
        tags: [],
        spadeUrl: null,
        startTime: 0,
        initialChannelPoints: null,
        lastChannelPoints: null,
        streamPointsEarned: 0,
      };

      const result = await twitchAPI.updateStreamerInfo(streamerInfo);

      expect(result.isOnline).toBe(true);
      expect(result.broadcastId).toBe('123456');
      expect(result.title).toBe('Test Stream');
    });

    it('должен установить isOnline в false когда стример офлайн', async () => {
      const mockGraphQLClient = (twitchAPI as any).graphqlClient;
      mockGraphQLClient.getStreamInfo = vi.fn().mockResolvedValue(null);
      mockGraphQLClient.getCircuitBreakerState = vi.fn().mockReturnValue('CLOSED');
      mockGraphQLClient.hadRecentNetworkFailure = vi.fn().mockReturnValue(false);

      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 0,
        isOnline: true,
        broadcastId: '123456',
        game: null,
        title: null,
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: null,
        lastChannelPoints: null,
        streamPointsEarned: 0,
      };

      const result = await twitchAPI.updateStreamerInfo(streamerInfo);

      expect(result.isOnline).toBe(false);
      expect(result.startTime).toBe(0);
    });
  });

  describe('sendMinuteWatched', () => {
    it('должен отправить событие minute-watched', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204, // Twitch возвращает 204 при успехе
        text: vi.fn().mockResolvedValue(''),
      });
      global.fetch = mockFetch;

      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1000,
        isOnline: true,
        broadcastId: '123456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: 'https://spade.twitch.tv/test',
        startTime: Date.now(),
        initialChannelPoints: 1000,
        lastChannelPoints: 1000,
        streamPointsEarned: 0,
      };

      // Мокаем createMinuteWatchedPayload
      const mockCreatePayload = vi.fn().mockResolvedValue({
        data: 'encoded_payload',
      });
      (twitchAPI as any).createMinuteWatchedPayload = mockCreatePayload;

      const result = await twitchAPI.sendMinuteWatched(streamerInfo);

      expect(result).toBe(true);
      expect(mockCreatePayload).toHaveBeenCalled();
    });

    it('должен вернуть false при ошибке отправки', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      global.fetch = mockFetch;

      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1000,
        isOnline: true,
        broadcastId: '123456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: 'https://spade.twitch.tv/test',
        startTime: Date.now(),
        initialChannelPoints: 1000,
        lastChannelPoints: 1000,
        streamPointsEarned: 0,
      };

      const result = await twitchAPI.sendMinuteWatched(streamerInfo);

      expect(result).toBe(false);
    });
  });
});

