/**
 * Модуль для хранения статистики в базе данных SQLite
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';
import dayjs from 'dayjs';

/**
 * Конфигурация базы данных
 */
export interface DatabaseStorageConfig {
  dbPath: string; // Путь к файлу базы данных
  autoBackup: boolean; // Автоматическое резервное копирование
  backupIntervalDays: number; // Интервал резервного копирования в днях
}

/**
 * Параметры по умолчанию
 */
const DEFAULT_CONFIG: DatabaseStorageConfig = {
  dbPath: './statistics/database.db',
  autoBackup: true,
  backupIntervalDays: 7,
};

/**
 * Статистика стримера из базы данных
 */
export interface StreamerStats {
  username: string;
  totalPoints: number;
  totalWatchTimeMs: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Статистика баллов за день
 */
export interface DailyPoints {
  id: number;
  streamerId: number;
  date: string; // YYYY-MM-DD
  pointsEarned: number;
  createdAt: number;
}

/**
 * Модуль для работы с базой данных статистики
 */
export class DatabaseStorage {
  private config: DatabaseStorageConfig;
  private db: Database.Database | null = null;
  private isInitialized = false;

  /**
   * Создает экземпляр модуля работы с базой данных
   * @param config Конфигурация базы данных
   */
  constructor(config: Partial<DatabaseStorageConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initialize();
  }

  /**
   * Инициализирует базу данных (создает файл, таблицы)
   */
  private initialize(): void {
    try {
      // Создаем директорию, если её нет
      const dbDir = path.dirname(this.config.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        logger.verbose(`📁  Created database directory: ${dbDir}`);
      }

      // Открываем или создаем базу данных
      this.db = new Database(this.config.dbPath);
      
      // Включаем WAL режим для лучшей производительности
      this.db.pragma('journal_mode = WAL');
      
      // Создаем таблицы
      this.createTables();
      
      this.isInitialized = true;
      logger.info(`✅  Database storage initialized: ${this.config.dbPath}`);
    } catch (error: any) {
      logger.error(`❌  Failed to initialize database storage: ${error.message || error}`);
      throw error;
    }
  }

  /**
   * Создает таблицы в базе данных
   */
  private createTables(): void {
    if (!this.db) return;

    // Таблица стримеров
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS streamers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        total_points INTEGER NOT NULL DEFAULT 0,
        total_watch_time_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Таблица ежедневных баллов
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        streamer_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        points_earned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE,
        UNIQUE(streamer_id, date)
      )
    `);

    // Создаем индексы для быстрого поиска
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_daily_points_streamer_date 
      ON daily_points(streamer_id, date);
      
      CREATE INDEX IF NOT EXISTS idx_streamers_username 
      ON streamers(username);
    `);

    logger.verbose(`📊  Database tables created`);
  }

  /**
   * Получает или создает запись стримера
   * @param username Имя стримера
   * @returns ID стримера
   */
  private getOrCreateStreamer(username: string): number {
    if (!this.db) throw new Error('Database not initialized');

    // Пытаемся найти существующего стримера
    const existing = this.db
      .prepare('SELECT id FROM streamers WHERE username = ?')
      .get(username) as { id: number } | undefined;

    if (existing) {
      return existing.id;
    }

    // Создаем нового стримера
    const now = Date.now();
    const result = this.db
      .prepare('INSERT INTO streamers (username, total_points, total_watch_time_ms, created_at, updated_at) VALUES (?, 0, 0, ?, ?)')
      .run(username, now, now);

    logger.verbose(`📝  Created streamer record: ${username} (id: ${result.lastInsertRowid})`);
    return Number(result.lastInsertRowid);
  }

  /**
   * Добавляет баллы за день
   * @param username Имя стримера
   * @param points Количество баллов
   * @param date Дата (опционально, по умолчанию сегодня)
   */
  addDailyPoints(username: string, points: number, date?: string): void {
    if (!this.db) {
      logger.warn('⚠️  Database not initialized, skipping daily points');
      return;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      const targetDate = date || dayjs().format('YYYY-MM-DD');
      const now = Date.now();

      // Используем INSERT OR REPLACE для обновления существующей записи
      this.db
        .prepare(`
          INSERT INTO daily_points (streamer_id, date, points_earned, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(streamer_id, date) DO UPDATE SET
            points_earned = points_earned + ?,
            created_at = CASE 
              WHEN created_at = (SELECT MIN(created_at) FROM daily_points WHERE streamer_id = ? AND date = ?) 
              THEN created_at 
              ELSE ? 
            END
        `)
        .run(streamerId, targetDate, points, now, points, streamerId, targetDate, now);

      logger.verbose(`💰  Added ${points} points for ${username} on ${targetDate}`);
    } catch (error: any) {
      logger.error(`❌  Failed to add daily points: ${error.message || error}`);
    }
  }

  /**
   * Обновляет общее количество баллов стримера
   * @param username Имя стримера
   * @param points Количество баллов для добавления
   */
  addTotalPoints(username: string, points: number): void {
    if (!this.db) {
      logger.warn('⚠️  Database not initialized, skipping total points update');
      return;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      const now = Date.now();

      this.db
        .prepare('UPDATE streamers SET total_points = total_points + ?, updated_at = ? WHERE id = ?')
        .run(points, now, streamerId);

      logger.verbose(`📊  Updated total points for ${username}: +${points}`);
    } catch (error: any) {
      logger.error(`❌  Failed to update total points: ${error.message || error}`);
    }
  }

  /**
   * Обновляет общее время просмотра стримера
   * @param username Имя стримера
   * @param watchTimeMs Время просмотра в миллисекундах
   */
  addWatchTime(username: string, watchTimeMs: number): void {
    if (!this.db) {
      logger.warn('⚠️  Database not initialized, skipping watch time update');
      return;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      const now = Date.now();

      this.db
        .prepare('UPDATE streamers SET total_watch_time_ms = total_watch_time_ms + ?, updated_at = ? WHERE id = ?')
        .run(watchTimeMs, now, streamerId);

      logger.verbose(`⏱️  Updated watch time for ${username}: +${watchTimeMs}ms`);
    } catch (error: any) {
      logger.error(`❌  Failed to update watch time: ${error.message || error}`);
    }
  }

  /**
   * Получает статистику стримера
   * @param username Имя стримера
   * @returns Статистика стримера или null, если не найдено
   */
  getStreamerStats(username: string): StreamerStats | null {
    if (!this.db) return null;

    try {
      const result = this.db
        .prepare('SELECT username, total_points, total_watch_time_ms, created_at, updated_at FROM streamers WHERE username = ?')
        .get(username) as StreamerStats | undefined;

      if (!result) return null;

      return {
        username: result.username,
        totalPoints: result.totalPoints,
        totalWatchTimeMs: result.totalWatchTimeMs,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
      };
    } catch (error: any) {
      logger.error(`❌  Failed to get streamer stats: ${error.message || error}`);
      return null;
    }
  }

  /**
   * Получает баллы за конкретный день
   * @param username Имя стримера
   * @param date Дата в формате YYYY-MM-DD
   * @returns Количество баллов за день или 0
   */
  getDailyPoints(username: string, date: string): number {
    if (!this.db) return 0;

    try {
      const result = this.db
        .prepare(`
          SELECT dp.points_earned 
          FROM daily_points dp
          JOIN streamers s ON dp.streamer_id = s.id
          WHERE s.username = ? AND dp.date = ?
        `)
        .get(username, date) as { points_earned: number } | undefined;

      return result?.points_earned || 0;
    } catch (error: any) {
      logger.error(`❌  Failed to get daily points: ${error.message || error}`);
      return 0;
    }
  }

  /**
   * Получает баллы за период
   * @param username Имя стримера
   * @param startDate Начальная дата (YYYY-MM-DD)
   * @param endDate Конечная дата (YYYY-MM-DD)
   * @returns Массив записей с баллами за каждый день
   */
  getDailyPointsRange(username: string, startDate: string, endDate: string): DailyPoints[] {
    if (!this.db) return [];

    try {
      const results = this.db
        .prepare(`
          SELECT dp.id, dp.streamer_id, dp.date, dp.points_earned, dp.created_at
          FROM daily_points dp
          JOIN streamers s ON dp.streamer_id = s.id
          WHERE s.username = ? AND dp.date >= ? AND dp.date <= ?
          ORDER BY dp.date ASC
        `)
        .all(username, startDate, endDate) as DailyPoints[];

      return results;
    } catch (error: any) {
      logger.error(`❌  Failed to get daily points range: ${error.message || error}`);
      return [];
    }
  }

  /**
   * Получает все статистики стримеров
   * @returns Массив статистик всех стримеров
   */
  getAllStreamerStats(): StreamerStats[] {
    if (!this.db) return [];

    try {
      const results = this.db
        .prepare('SELECT username, total_points, total_watch_time_ms, created_at, updated_at FROM streamers ORDER BY total_points DESC')
        .all() as StreamerStats[];

      return results;
    } catch (error: any) {
      logger.error(`❌  Failed to get all streamer stats: ${error.message || error}`);
      return [];
    }
  }

  /**
   * Получает суммарные баллы за день для всех стримеров
   * @param date Дата в формате YYYY-MM-DD
   * @returns Общее количество баллов за день
   */
  getTotalDailyPoints(date: string): number {
    if (!this.db) return 0;

    try {
      const result = this.db
        .prepare('SELECT SUM(points_earned) as total FROM daily_points WHERE date = ?')
        .get(date) as { total: number | null } | undefined;

      return result?.total || 0;
    } catch (error: any) {
      logger.error(`❌  Failed to get total daily points: ${error.message || error}`);
      return 0;
    }
  }

  /**
   * Закрывает соединение с базой данных
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.isInitialized = false;
      logger.info('🔒  Database connection closed');
    }
  }

  /**
   * Проверяет, инициализирована ли база данных
   */
  isReady(): boolean {
    return this.isInitialized && this.db !== null;
  }

  /**
   * Получает путь к файлу базы данных
   */
  getDbPath(): string {
    return this.config.dbPath;
  }
}
