/**
 * Интеграционные тесты для API модулей
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLClient } from '../GraphQLClient';
import { TwitchAPI } from '../TwitchAPI';
import { StatisticsStorage } from '../StatisticsStorage';

// Мокаем только внешние зависимости (fetch, fs)
global.fetch = vi.fn();

// Мокаем logger
vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  },
}));

describe('Интеграционные тесты', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TWITCH_CLIENT_VERSION = 'test-build-id-for-vitest';
    process.env.TWITCH_INTEGRITY_SOURCE = 'api';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GraphQLClient + TwitchAPI', () => {
    it('должен работать вместе для получения информации о стримере', async () => {
      const mockStreamInfo = {
        data: {
          user: {
            stream: {
              id: '123456',
              title: 'Test Stream',
              game: { name: 'Test Game' },
              tags: [{ name: 'tag1' }],
              viewersCount: 100,
            },
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockStreamInfo,
      });

      const graphqlClient = new GraphQLClient('test_token', 'test_user_agent');
      const streamInfo = await graphqlClient.getStreamInfo('testuser');

      expect(streamInfo).toBeDefined();
      expect(streamInfo?.broadcastId).toBe('123456');
    });
  });

  describe('StatisticsStorage + StreamWatcher', () => {
    it('должен сохранять сессии просмотра', () => {
      const storage = new StatisticsStorage({
        storagePath: './test-statistics',
      });

      const sessionId = storage.createSession('testuser', 1000, 'Test Game', 'Test Title');
      expect(sessionId).toBeDefined();

      const sessions = storage.getSessions();
      expect(sessions.length).toBeGreaterThan(0);

      storage.endSession(sessionId, 1500, 'completed');
      const completedSession = sessions.find(s => s.id === sessionId);
      expect(completedSession?.status).toBe('completed');
    });
  });

  describe('Полный цикл работы', () => {
    it('должен обработать полный цикл: создание сессии -> обновление -> завершение', () => {
      const storage = new StatisticsStorage({
        storagePath: './test-statistics',
      });

      // Создаем сессию
      const sessionId = storage.createSession('testuser', 1000, 'Test Game', 'Test Title');
      expect(sessionId).toBeDefined();

      // Обновляем сессию
      storage.updateSession(sessionId, 1200);
      let sessions = storage.getSessions();
      let session = sessions.find(s => s.id === sessionId);
      expect(session?.pointsEarned).toBe(200);

      // Завершаем сессию
      storage.endSession(sessionId, 1500, 'completed');
      sessions = storage.getSessions();
      session = sessions.find(s => s.id === sessionId);
      expect(session?.status).toBe('completed');
      expect(session?.pointsEarned).toBe(500);
    });
  });
});

