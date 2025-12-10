/**
 * Тесты для StatisticsStorage
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StatisticsStorage } from '../StatisticsStorage';
import * as fs from 'fs';
import * as path from 'path';

// Мокаем fs
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

describe('StatisticsStorage', () => {
  const testConfig = {
    storagePath: './test-statistics',
    sessionsFile: 'sessions.json',
  };

  let storage: StatisticsStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue('[]');
    storage = new StatisticsStorage(testConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createSession', () => {
    it('должен создать новую сессию', () => {
      const sessionId = storage.createSession('testuser', 1000, 'Test Game', 'Test Title');

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
    });

    it('должен создать сессию с правильными параметрами', () => {
      const sessionId = storage.createSession('testuser', 1000, 'Test Game', 'Test Title');
      const sessions = storage.getSessions();

      const session = sessions.find(s => s.id === sessionId);
      expect(session).toBeDefined();
      expect(session?.streamerName).toBe('testuser');
      expect(session?.initialChannelPoints).toBe(1000);
      expect(session?.game).toBe('Test Game');
      expect(session?.title).toBe('Test Title');
      expect(session?.status).toBe('active');
    });
  });

  describe('endSession', () => {
    it('должен завершить активную сессию', () => {
      const sessionId = storage.createSession('testuser', 1000, 'Test Game', 'Test Title');
      storage.endSession(sessionId, 1500, 'completed');

      const sessions = storage.getSessions();
      const session = sessions.find(s => s.id === sessionId);

      expect(session?.status).toBe('completed');
      expect(session?.finalChannelPoints).toBe(1500);
      expect(session?.pointsEarned).toBe(500);
      expect(session?.endTime).toBeDefined();
    });

    it('должен корректно рассчитать заработанные баллы', () => {
      const sessionId = storage.createSession('testuser', 1000, 'Test Game', 'Test Title');
      storage.endSession(sessionId, 1500, 'completed');

      const sessions = storage.getSessions();
      const session = sessions.find(s => s.id === sessionId);

      expect(session?.pointsEarned).toBe(500);
    });
  });

  describe('updateSession', () => {
    it('должен обновить баллы активной сессии', () => {
      const sessionId = storage.createSession('testuser', 1000, 'Test Game', 'Test Title');
      storage.updateSession(sessionId, 1200);

      const sessions = storage.getSessions();
      const session = sessions.find(s => s.id === sessionId);

      expect(session?.pointsEarned).toBe(200);
    });

    it('не должен обновлять завершенную сессию', () => {
      const sessionId = storage.createSession('testuser', 1000, 'Test Game', 'Test Title');
      storage.endSession(sessionId, 1500, 'completed');
      storage.updateSession(sessionId, 2000);

      const sessions = storage.getSessions();
      const session = sessions.find(s => s.id === sessionId);

      expect(session?.pointsEarned).toBe(500); // Не изменилось
    });
  });

  describe('getSessions', () => {
    it('должен вернуть все сессии', () => {
      storage.createSession('user1', 1000, 'Game1', 'Title1');
      storage.createSession('user2', 2000, 'Game2', 'Title2');

      const sessions = storage.getSessions();

      expect(sessions.length).toBe(2);
    });

    it('должен фильтровать сессии по имени стримера', () => {
      storage.createSession('user1', 1000, 'Game1', 'Title1');
      storage.createSession('user2', 2000, 'Game2', 'Title2');

      const sessions = storage.getSessions('user1');

      expect(sessions.length).toBe(1);
      expect(sessions[0].streamerName).toBe('user1');
    });
  });

  describe('getAggregatedStatistics', () => {
    it('должен вернуть агрегированную статистику', () => {
      const sessionId1 = storage.createSession('user1', 1000, 'Game1', 'Title1');
      storage.endSession(sessionId1, 1500, 'completed');

      const stats = storage.getAggregatedStatistics('day');

      expect(stats).toBeDefined();
      expect(stats.totalSessions).toBeGreaterThan(0);
    });
  });
});

