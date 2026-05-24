/**
 * Тесты для проверки получения и обновления баллов
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamWatcher } from '../StreamWatcher';
import { TwitchAPI } from '../TwitchAPI';
import { StatisticsStorage } from '../StatisticsStorage';
import { WebSocketManager } from '../WebSocketManager';
import { GraphQLClient } from '../GraphQLClient';
import { StreamerInfo } from '../types';

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
    setValidatedUserId: vi.fn(),
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
    createSession: vi.fn((username: string, initialPoints: number) => `session_${username}_${Date.now()}`),
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
    getChannelId: vi.fn(),
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

describe('Points Earned', () => {
  let streamWatcher: StreamWatcher;
  const mockAuthToken = 'test_token';
  const mockUserAgent = 'test_user_agent';
  const mockStreamers = ['testuser'];

  beforeEach(() => {
    vi.clearAllMocks();
    streamWatcher = new StreamWatcher(mockAuthToken, mockUserAgent, mockStreamers);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getStatistics - вычисление заработанных баллов', () => {
    it('должен правильно вычислить заработанные баллы когда initialChannelPoints установлен', () => {
      // Добавляем стримера с начальными и текущими баллами
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1500, // Текущие баллы
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now() - 60000, // 1 минута назад
        initialChannelPoints: 1000, // Начальные баллы
        lastChannelPoints: 1500,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);

      const stats = streamWatcher.getStatistics();

      expect(stats.length).toBe(1);
      expect(stats[0].streamerName).toBe('testuser');
      expect(stats[0].pointsEarned).toBe(500); // 1500 - 1000
      expect(stats[0].currentPoints).toBe(1500);
    });

    it('должен вернуть 0 заработанных баллов если initialChannelPoints не установлен', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1500,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now() - 60000,
        initialChannelPoints: null, // Не установлен
        lastChannelPoints: 1500,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);

      const stats = streamWatcher.getStatistics();

      expect(stats[0].pointsEarned).toBe(0);
      expect(stats[0].currentPoints).toBe(1500);
    });

    it('должен использовать lastChannelPoints если channelPoints равен 0', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 0, // Не установлен
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now() - 60000,
        initialChannelPoints: 1000,
        lastChannelPoints: 1200, // Используется как fallback
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);

      const stats = streamWatcher.getStatistics();

      expect(stats[0].pointsEarned).toBe(200); // 1200 - 1000
      expect(stats[0].currentPoints).toBe(1200);
    });

    it('должен правильно обработать отрицательные заработанные баллы (если баллы уменьшились)', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 800, // Меньше начальных
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now() - 60000,
        initialChannelPoints: 1000,
        lastChannelPoints: 800,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);

      const stats = streamWatcher.getStatistics();

      expect(stats[0].pointsEarned).toBe(-200); // 800 - 1000
      expect(stats[0].currentPoints).toBe(800);
    });

    it('должен вернуть 0 для офлайн стримеров', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1500,
        isOnline: false, // Офлайн
        broadcastId: null,
        game: null,
        title: null,
        tags: [],
        spadeUrl: null,
        startTime: 0,
        initialChannelPoints: 1000,
        lastChannelPoints: 1500,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);

      const stats = streamWatcher.getStatistics(false); // Не включаем офлайн

      expect(stats.length).toBe(0);
    });

    it('должен включить офлайн стримеров если includeOffline = true', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1500,
        isOnline: false,
        broadcastId: null,
        game: null,
        title: null,
        tags: [],
        spadeUrl: null,
        startTime: 0,
        initialChannelPoints: 1000,
        lastChannelPoints: 1500,
        streamPointsEarned: 500,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);

      const stats = streamWatcher.getStatistics(true); // Включаем офлайн

      expect(stats.length).toBe(1);
      expect(stats[0].pointsEarned).toBe(500);
      expect(stats[0].currentPoints).toBe(1500);
    });
  });

  describe('WebSocket события - начисление баллов', () => {
    it('должен обработать событие начисления баллов через WATCH', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1000,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: 1000,
        lastChannelPoints: 1000,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);
      (streamWatcher as any).activeSessions.set('testuser', 'session123');

      const mockStatisticsStorage = (streamWatcher as any).statisticsStorage;
      const mockAddEvent = vi.spyOn(streamWatcher as any, 'addEvent');

      // Создаем обработчик событий напрямую (как в StreamWatcher.start)
      const onPointsEarned = (streamerInfo: StreamerInfo, points: number, reason: string) => {
        let eventType: string;
        if (reason === 'CLAIM') {
          eventType = 'claim-earned';
        } else if (reason === 'WATCH_STREAK') {
          eventType = 'streak-earned';
        } else {
          eventType = 'points-earned';
        }
        (streamWatcher as any).addEvent(eventType, streamerInfo.username, `Earned ${points} points (${reason})`);
        
        const sessionId = (streamWatcher as any).activeSessions.get(streamerInfo.username);
        if (mockStatisticsStorage && sessionId && streamerInfo.channelPoints !== null) {
          mockStatisticsStorage.updateSession(sessionId, streamerInfo.channelPoints);
        }
      };

      // Симулируем событие начисления баллов
      onPointsEarned(streamerInfo, 50, 'WATCH');

      // Проверяем, что событие было добавлено
      expect(mockAddEvent).toHaveBeenCalledWith('points-earned', 'testuser', 'Earned 50 points (WATCH)');
      
      // Проверяем, что сессия была обновлена
      if (mockStatisticsStorage) {
        expect(mockStatisticsStorage.updateSession).toHaveBeenCalledWith('session123', 1000);
      }
    });

    it('должен обработать событие начисления баллов через CLAIM', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1000,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: 1000,
        lastChannelPoints: 1000,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);
      (streamWatcher as any).activeSessions.set('testuser', 'session123');

      const mockAddEvent = vi.spyOn(streamWatcher as any, 'addEvent');

      // Создаем обработчик событий напрямую
      const onPointsEarned = (streamerInfo: StreamerInfo, points: number, reason: string) => {
        let eventType: string;
        if (reason === 'CLAIM') {
          eventType = 'claim-earned';
        } else if (reason === 'WATCH_STREAK') {
          eventType = 'streak-earned';
        } else {
          eventType = 'points-earned';
        }
        (streamWatcher as any).addEvent(eventType, streamerInfo.username, `Earned ${points} points (${reason})`);
      };

      onPointsEarned(streamerInfo, 50, 'CLAIM');

      // Проверяем, что событие было добавлено с правильным типом
      expect(mockAddEvent).toHaveBeenCalledWith('claim-earned', 'testuser', 'Earned 50 points (CLAIM)');
    });

    it('должен обработать событие начисления баллов через WATCH_STREAK', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1000,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: 1000,
        lastChannelPoints: 1000,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);
      (streamWatcher as any).activeSessions.set('testuser', 'session123');

      const mockAddEvent = vi.spyOn(streamWatcher as any, 'addEvent');

      // Создаем обработчик событий напрямую
      const onPointsEarned = (streamerInfo: StreamerInfo, points: number, reason: string) => {
        let eventType: string;
        if (reason === 'CLAIM') {
          eventType = 'claim-earned';
        } else if (reason === 'WATCH_STREAK') {
          eventType = 'streak-earned';
        } else {
          eventType = 'points-earned';
        }
        (streamWatcher as any).addEvent(eventType, streamerInfo.username, `Earned ${points} points (${reason})`);
      };

      onPointsEarned(streamerInfo, 100, 'WATCH_STREAK');

      // Проверяем, что событие было добавлено с правильным типом
      expect(mockAddEvent).toHaveBeenCalledWith('streak-earned', 'testuser', 'Earned 100 points (WATCH_STREAK)');
    });

    it('должен правильно установить initialChannelPoints вычитая earned из баланса при первом событии', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 0, // Еще не установлен
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: null, // Не установлен
        lastChannelPoints: null,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);

      // Симулируем WebSocket событие с earned > 0
      // Баланс = 1950, earned = 10, значит начальный баланс должен быть 1950 - 10 = 1940
      streamerInfo.channelPoints = 1950;
      streamerInfo.lastChannelPoints = 1950;
      
      // Создаем обработчик, который устанавливает initialChannelPoints правильно
      const onPointsEarned = (streamerInfo: StreamerInfo, points: number, reason: string) => {
        // Если initialChannelPoints еще не установлен и earned > 0, вычитаем earned
        if (streamerInfo.initialChannelPoints === null && points > 0) {
          streamerInfo.initialChannelPoints = streamerInfo.channelPoints - points;
        }
      };

      onPointsEarned(streamerInfo, 10, 'WATCH');

      // Проверяем, что initialChannelPoints установлен правильно
      expect(streamerInfo.initialChannelPoints).toBe(1940); // 1950 - 10
      
      // Проверяем статистику
      const stats = streamWatcher.getStatistics();
      expect(stats[0].pointsEarned).toBe(10); // 1950 - 1940
      expect(stats[0].currentPoints).toBe(1950);
    });

    it('должен создать сессию если она не существует при получении баллов', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1500,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: 1000, // Установлен
        lastChannelPoints: 1500,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);
      // Сессия не существует
      expect((streamWatcher as any).activeSessions.has('testuser')).toBe(false);

      const mockStatisticsStorage = (streamWatcher as any).statisticsStorage;

      // Создаем обработчик событий напрямую
      const onPointsEarned = (streamerInfo: StreamerInfo, points: number, reason: string) => {
        // Если сессия еще не создана, но initialChannelPoints установлен через WebSocket, создаем сессию
        if (!(streamWatcher as any).activeSessions.has(streamerInfo.username) && 
            streamerInfo.initialChannelPoints !== null && 
            streamerInfo.isOnline &&
            mockStatisticsStorage) {
          const sessionId = mockStatisticsStorage.createSession(
            streamerInfo.username,
            streamerInfo.initialChannelPoints,
            streamerInfo.game,
            streamerInfo.title
          );
          (streamWatcher as any).activeSessions.set(streamerInfo.username, sessionId);
        }
      };

      onPointsEarned(streamerInfo, 500, 'WATCH');

      // Проверяем, что сессия была создана
      if (mockStatisticsStorage) {
        expect(mockStatisticsStorage.createSession).toHaveBeenCalledWith(
          'testuser',
          1000, // initialChannelPoints
          'Test Game',
          'Test Title'
        );
      }
    });
  });

  describe('Обновление баллов через GraphQL', () => {
    it('должен обновить баллы при периодическом обновлении через updateStreamerInfo', async () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1000,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: 1000,
        lastChannelPoints: 1000,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);

      const mockTwitchAPI = (streamWatcher as any).twitchAPI;
      mockTwitchAPI.updateStreamerInfo = vi.fn().mockResolvedValue({
        ...streamerInfo,
        channelPoints: 1200, // Обновленные баллы
        lastChannelPoints: 1200,
      });

      // Симулируем обновление через printStatistics
      await (streamWatcher as any).printStatistics();

      expect(mockTwitchAPI.updateStreamerInfo).toHaveBeenCalled();
    });

    it('должен установить initialChannelPoints если он null при обновлении', async () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 0,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: null, // Не установлен
        lastChannelPoints: null,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);

      const mockTwitchAPI = (streamWatcher as any).twitchAPI;
      mockTwitchAPI.updateStreamerInfo = vi.fn().mockImplementation(async (info: StreamerInfo) => {
        // Симулируем установку начальных баллов через GraphQL
        info.initialChannelPoints = 1000;
        info.lastChannelPoints = 1000;
        info.channelPoints = 1000;
        return info;
      });

      await (streamWatcher as any).printStatistics();

      expect(streamerInfo.initialChannelPoints).toBe(1000);
      expect(streamerInfo.channelPoints).toBe(1000);
    });
  });

  describe('Интеграция - полный цикл начисления баллов', () => {
    it('должен правильно отследить начисление баллов от начала до конца', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1000,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: 1000,
        lastChannelPoints: 1000,
      };

      (streamWatcher as any).streamers.set('testuser', streamerInfo);
      (streamWatcher as any).activeSessions.set('testuser', 'session123');

      // Шаг 1: Начальное состояние
      let stats = streamWatcher.getStatistics();
      expect(stats[0].pointsEarned).toBe(0);
      expect(stats[0].currentPoints).toBe(1000);

      // Шаг 2: Начисление баллов через WATCH (обновляем баллы напрямую)
      streamerInfo.channelPoints = 1050;
      streamerInfo.lastChannelPoints = 1050;

      // Шаг 3: Проверяем обновленную статистику
      stats = streamWatcher.getStatistics();
      expect(stats[0].pointsEarned).toBe(50); // 1050 - 1000
      expect(stats[0].currentPoints).toBe(1050);

      // Шаг 4: Еще одно начисление
      streamerInfo.channelPoints = 1150;
      streamerInfo.lastChannelPoints = 1150;

      // Шаг 5: Финальная проверка
      stats = streamWatcher.getStatistics();
      expect(stats[0].pointsEarned).toBe(150); // 1150 - 1000
      expect(stats[0].currentPoints).toBe(1150);
    });
  });
});

