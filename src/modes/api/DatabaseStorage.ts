/**
 * Модуль для хранения статистики в базе данных SQLite
 */

import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';
import dayjs from 'dayjs';
import type { SqlJsStatic, Database } from 'sql.js';

// Динамический импорт sql.js для поддержки платформ без нативной компиляции
let SQL: SqlJsStatic | null = null;
let isDatabaseAvailable = false;
let databaseError: string | null = null;

// Функция для безопасной загрузки модуля
async function loadSqlJs(): Promise<void> {
  try {
    // Пытаемся загрузить sql.js
    let sqlJsModule: any;
    try {
      sqlJsModule = await import('sql.js');
    } catch (importError: any) {
      const errorCode = importError?.code || 'MODULE_NOT_FOUND';
      if (errorCode === 'MODULE_NOT_FOUND') {
        databaseError = `Module 'sql.js' not found in node_modules`;
      } else {
        databaseError = `Cannot import 'sql.js': ${importError?.message || importError}`;
      }
      isDatabaseAvailable = false;
      SQL = null;
      return;
    }

    // Инициализируем SQL.js
    try {
      SQL = await sqlJsModule.default();
      isDatabaseAvailable = true;
      try {
        logger.verbose(`✅  sql.js loaded and initialized successfully`);
      } catch {
        // logger может быть еще не инициализирован
      }
    } catch (initError: any) {
      throw new Error(`Failed to initialize sql.js: ${initError.message || initError}`);
    }
  } catch (error: any) {
    databaseError = error.message || String(error);
    try {
      if (logger && logger.warn) {
        logger.warn(`⚠️  sql.js not available: ${databaseError}. Database features will be disabled.`);
      } else {
        console.warn(`⚠️  sql.js not available: ${databaseError}. Database features will be disabled.`);
      }
    } catch {
      console.warn(`⚠️  sql.js not available: ${databaseError}. Database features will be disabled.`);
    }
    isDatabaseAvailable = false;
    SQL = null;
  }
}

// Загружаем модуль при инициализации файла (асинхронно)
let loadPromise: Promise<void> | null = null;
if (typeof window === 'undefined') {
  // Только в Node.js окружении
  loadPromise = loadSqlJs();
}

/**
 * Конфигурация базы данных
 */
export interface DatabaseStorageConfig {
  dbPath: string; // Путь к файлу базы данных
  autoBackup: boolean; // Автоматическое резервное копирование
  backupIntervalDays: number; // Интервал резервного копирования в днях
  autoSave: boolean; // Автоматическое сохранение после изменений
}

/**
 * Параметры по умолчанию
 */
const DEFAULT_CONFIG: DatabaseStorageConfig = {
  dbPath: './statistics/database.db',
  autoBackup: true,
  backupIntervalDays: 7,
  autoSave: true,
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
  lastStreamStart: number | null; // Время последнего запуска стрима (timestamp)
  lastStreamEnd: number | null; // Время последнего завершения стрима (timestamp)
  lastGame: string | null; // Последняя категория стрима
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
  private db: Database | null = null;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Создает экземпляр модуля работы с базой данных
   * @param config Конфигурация базы данных
   */
  constructor(config: Partial<DatabaseStorageConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Инициализируем асинхронно
    this.initPromise = this.initializeAsync();
  }

  /**
   * Асинхронная инициализация базы данных
   */
  private async initializeAsync(): Promise<void> {
    // Ждем загрузки sql.js, если еще не загружен
    if (loadPromise) {
      await loadPromise;
    }

    if (isDatabaseAvailable) {
      await this.initialize();
    } else {
      logger.warn(`⚠️  DatabaseStorage: sql.js not available, database features disabled`);
    }
  }

  /**
   * Инициализирует базу данных (создает файл, таблицы)
   */
  private async initialize(): Promise<void> {
    if (!isDatabaseAvailable || !SQL) {
      logger.warn(`⚠️  Cannot initialize database: sql.js not available`);
      if (databaseError) {
        logger.warn(`   Error reason: ${databaseError}`);
      }
      return;
    }

    try {
      // Создаем директорию, если её нет
      const dbDir = path.dirname(this.config.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        logger.verbose(`📁  Created database directory: ${dbDir}`);
      }

      // Загружаем существующую базу данных или создаем новую
      if (fs.existsSync(this.config.dbPath)) {
        const buffer = fs.readFileSync(this.config.dbPath);
        // Преобразуем Buffer в Uint8Array для sql.js
        const uint8Array = new Uint8Array(buffer);
        this.db = new SQL.Database(uint8Array);
        logger.verbose(`📂  Loaded existing database: ${this.config.dbPath}`);
      } else {
        this.db = new SQL.Database();
        logger.verbose(`🆕  Created new database in memory`);
      }
      
      // Создаем таблицы
      this.createTables();
      
      this.isInitialized = true;
      logger.info(`✅  Database storage initialized: ${this.config.dbPath}`);
    } catch (error: any) {
      const errorMessage = error.message || String(error);
      logger.error(`❌  Failed to initialize database storage: ${errorMessage}`);
      if (error.stack) {
        logger.verbose(`   Stack: ${error.stack}`);
      }
      databaseError = errorMessage;
      this.isInitialized = false;
    }
  }

  /**
   * Сохраняет базу данных в файл
   */
  private saveDatabase(): void {
    if (!this.db || !this.isInitialized) return;

    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.config.dbPath, buffer);
      logger.verbose(`💾  Database saved to ${this.config.dbPath}`);
    } catch (error: any) {
      logger.error(`❌  Failed to save database: ${error.message || error}`);
    }
  }

  /**
   * Создает таблицы в базе данных
   */
  private createTables(): void {
    if (!isDatabaseAvailable || !this.db) return;

    // Таблица стримеров
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS streamers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        total_points INTEGER NOT NULL DEFAULT 0,
        total_watch_time_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_stream_start INTEGER,
        last_stream_end INTEGER
      )
    `);

    // Добавляем новые поля, если таблица уже существует (миграция)
    try {
      this.db.exec(`
        ALTER TABLE streamers ADD COLUMN last_stream_start INTEGER;
      `);
    } catch (error: any) {
      // Поле уже существует - это нормально
      if (!error.message?.includes('duplicate column name')) {
        logger.verbose(`⚠️  Failed to add last_stream_start column: ${error.message}`);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE streamers ADD COLUMN last_stream_end INTEGER;
      `);
    } catch (error: any) {
      // Поле уже существует - это нормально
      if (!error.message?.includes('duplicate column name')) {
        logger.verbose(`⚠️  Failed to add last_stream_end column: ${error.message}`);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE streamers ADD COLUMN last_game TEXT;
      `);
    } catch (error: any) {
      // Поле уже существует - это нормально
      if (!error.message?.includes('duplicate column name')) {
        logger.verbose(`⚠️  Failed to add last_game column: ${error.message}`);
      }
    }

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
    if (!isDatabaseAvailable || !this.db) {
      throw new Error('Database not available');
    }

    // Пытаемся найти существующего стримера
    const stmt = this.db.prepare('SELECT id FROM streamers WHERE username = ?');
    stmt.bind([username]);
    const existing = stmt.step() ? stmt.getAsObject() as { id: number } : null;
    stmt.free();

    if (existing) {
      return existing.id;
    }

    // Создаем нового стримера
    const now = Date.now();
    const insertStmt = this.db.prepare(
      'INSERT INTO streamers (username, total_points, total_watch_time_ms, created_at, updated_at, last_stream_start, last_stream_end) VALUES (?, 0, 0, ?, ?, NULL, NULL)'
    );
    insertStmt.bind([username, now, now]);
    insertStmt.step();
    const lastInsertRowid = this.db.exec('SELECT last_insert_rowid() as id')[0]?.values[0]?.[0] as number;
    insertStmt.free();

    logger.verbose(`📝  Created streamer record: ${username} (id: ${lastInsertRowid})`);
    return lastInsertRowid;
  }

  /**
   * Добавляет баллы за день
   * @param username Имя стримера
   * @param points Количество баллов
   * @param date Дата (опционально, по умолчанию сегодня)
   */
  addDailyPoints(username: string, points: number, date?: string): void {
    if (!isDatabaseAvailable || !this.db) {
      // Тихий возврат - база данных опциональна
      return;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      const targetDate = date || dayjs().format('YYYY-MM-DD');
      const now = Date.now();

      // Используем INSERT OR REPLACE для обновления существующей записи
      const stmt = this.db.prepare(`
        INSERT INTO daily_points (streamer_id, date, points_earned, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(streamer_id, date) DO UPDATE SET
          points_earned = points_earned + ?,
          created_at = CASE 
            WHEN created_at = (SELECT MIN(created_at) FROM daily_points WHERE streamer_id = ? AND date = ?) 
            THEN created_at 
            ELSE ? 
          END
      `);
      stmt.bind([streamerId, targetDate, points, now, points, streamerId, targetDate, now]);
      stmt.step();
      stmt.free();

      if (this.config.autoSave) {
        this.saveDatabase();
      }

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
    if (!isDatabaseAvailable || !this.db) {
      // Тихий возврат - база данных опциональна
      return;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      const now = Date.now();

      const stmt = this.db.prepare('UPDATE streamers SET total_points = total_points + ?, updated_at = ? WHERE id = ?');
      stmt.bind([points, now, streamerId]);
      stmt.step();
      stmt.free();

      if (this.config.autoSave) {
        this.saveDatabase();
      }

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
    if (!isDatabaseAvailable || !this.db) {
      // Тихий возврат - база данных опциональна
      return;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      const now = Date.now();

      const stmt = this.db.prepare('UPDATE streamers SET total_watch_time_ms = total_watch_time_ms + ?, updated_at = ? WHERE id = ?');
      stmt.bind([watchTimeMs, now, streamerId]);
      stmt.step();
      stmt.free();

      if (this.config.autoSave) {
        this.saveDatabase();
      }

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
      const stmt = this.db.prepare('SELECT username, total_points, total_watch_time_ms, created_at, updated_at, last_stream_start, last_stream_end, last_game FROM streamers WHERE username = ?');
      stmt.bind([username]);
      const result = stmt.step() ? stmt.getAsObject() as any : null;
      stmt.free();

      if (!result) return null;

      return {
        username: result.username,
        totalPoints: result.total_points,
        totalWatchTimeMs: result.total_watch_time_ms,
        createdAt: result.created_at,
        updatedAt: result.updated_at,
        lastStreamStart: result.last_stream_start ?? null,
        lastStreamEnd: result.last_stream_end ?? null,
        lastGame: result.last_game ?? null,
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
      const stmt = this.db.prepare(`
        SELECT dp.points_earned 
        FROM daily_points dp
        JOIN streamers s ON dp.streamer_id = s.id
        WHERE s.username = ? AND dp.date = ?
      `);
      stmt.bind([username, date]);
      const result = stmt.step() ? stmt.getAsObject() as any : null;
      stmt.free();

      if (!result) return 0;
      return result.points_earned || 0;
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
      const stmt = this.db.prepare(`
        SELECT dp.id, dp.streamer_id, dp.date, dp.points_earned, dp.created_at
        FROM daily_points dp
        JOIN streamers s ON dp.streamer_id = s.id
        WHERE s.username = ? AND dp.date >= ? AND dp.date <= ?
        ORDER BY dp.date ASC
      `);
      stmt.bind([username, startDate, endDate]);
      
      const results: DailyPoints[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        results.push({
          id: row.id,
          streamerId: row.streamer_id,
          date: row.date,
          pointsEarned: row.points_earned,
          createdAt: row.created_at,
        });
      }
      stmt.free();

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
      const stmt = this.db.prepare('SELECT username, total_points, total_watch_time_ms, created_at, updated_at, last_stream_start, last_stream_end, last_game FROM streamers ORDER BY total_points DESC');
      
      const results: StreamerStats[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        results.push({
          username: row.username,
          totalPoints: row.total_points,
          totalWatchTimeMs: row.total_watch_time_ms,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastStreamStart: row.last_stream_start ?? null,
          lastStreamEnd: row.last_stream_end ?? null,
          lastGame: row.last_game ?? null,
        });
      }
      stmt.free();

      return results;
    } catch (error: any) {
      logger.error(`❌  Failed to get all streamer stats: ${error.message || error}`);
      return [];
    }
  }

  /**
   * Обновляет время последнего запуска стрима
   * @param username Имя стримера
   * @param timestamp Время запуска стрима (timestamp)
   */
  updateLastStreamStart(username: string, timestamp: number): void {
    if (!isDatabaseAvailable || !this.db) {
      return;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      const now = Date.now();

      const stmt = this.db.prepare('UPDATE streamers SET last_stream_start = ?, updated_at = ? WHERE id = ?');
      stmt.bind([timestamp, now, streamerId]);
      stmt.step();
      stmt.free();

      if (this.config.autoSave) {
        this.saveDatabase();
      }

      logger.verbose(`📺  Updated last stream start for ${username}: ${new Date(timestamp).toISOString()}`);
    } catch (error: any) {
      logger.error(`❌  Failed to update last stream start: ${error.message || error}`);
    }
  }

  /**
   * Обновляет время последнего завершения стрима
   * @param username Имя стримера
   * @param timestamp Время завершения стрима (timestamp)
   */
  updateLastStreamEnd(username: string, timestamp: number): void {
    if (!isDatabaseAvailable || !this.db) {
      return;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      const now = Date.now();

      const stmt = this.db.prepare('UPDATE streamers SET last_stream_end = ?, updated_at = ? WHERE id = ?');
      stmt.bind([timestamp, now, streamerId]);
      stmt.step();
      stmt.free();

      if (this.config.autoSave) {
        this.saveDatabase();
      }

      logger.verbose(`📺  Updated last stream end for ${username}: ${new Date(timestamp).toISOString()}`);
    } catch (error: any) {
      logger.error(`❌  Failed to update last stream end: ${error.message || error}`);
    }
  }

  /**
   * Обновляет последнюю категорию стрима
   * @param username Имя стримера
   * @param game Название категории/игры
   */
  updateLastGame(username: string, game: string | null): void {
    if (!isDatabaseAvailable || !this.db) {
      return;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      const now = Date.now();

      const stmt = this.db.prepare('UPDATE streamers SET last_game = ?, updated_at = ? WHERE id = ?');
      stmt.bind([game, now, streamerId]);
      stmt.step();
      stmt.free();

      if (this.config.autoSave) {
        this.saveDatabase();
      }

      logger.verbose(`🎮  Updated last game for ${username}: ${game || 'null'}`);
    } catch (error: any) {
      logger.error(`❌  Failed to update last game: ${error.message || error}`);
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
      const stmt = this.db.prepare('SELECT SUM(points_earned) as total FROM daily_points WHERE date = ?');
      stmt.bind([date]);
      const result = stmt.step() ? stmt.getAsObject() as any : null;
      stmt.free();

      if (!result) return 0;
      return result.total || 0;
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
      // Сохраняем перед закрытием
      if (this.isInitialized) {
        this.saveDatabase();
      }
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
    // Проверяем, завершена ли асинхронная инициализация
    if (this.initPromise && !this.isInitialized) {
      return false;
    }
    return isDatabaseAvailable && this.isInitialized && this.db !== null;
  }

  /**
   * Получает путь к файлу базы данных
   */
  getDbPath(): string {
    return this.config.dbPath;
  }

  /**
   * Получает причину ошибки, если база данных недоступна
   */
  getErrorReason(): string | null {
    return databaseError;
  }

  /**
   * Принудительно сохраняет базу данных
   */
  save(): void {
    this.saveDatabase();
  }
}

