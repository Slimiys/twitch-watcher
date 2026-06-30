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

/** Окно подсчёта стримов для дашборда (30 суток) */
export const STREAM_COUNT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Допустимые периоды подсчёта стримов на дашборде (сутки) */
export const STREAM_COUNT_WINDOW_DAYS = [7, 14, 30, 60] as const;

export type StreamCountWindowDays = (typeof STREAM_COUNT_WINDOW_DAYS)[number];

/** Количество стримов стримера по периодам */
export interface StreamCountsByWindow {
  d7: number;
  d14: number;
  d30: number;
  d60: number;
}

/** Статистика стримов по категории для дашборда */
export interface StreamerCategoryStreamCount {
  category: string;
  streamCount: number;
}

/** Суммарное время стримов по категории (все стримеры) */
export interface CategoryStreamDurationTotal {
  category: string;
  durationMs: number;
  streamers: StreamerCategoryStreamDurationEntry[];
}

/** Время стримов стримера в конкретной категории */
export interface StreamerCategoryStreamDurationEntry {
  streamerName: string;
  durationMs: number;
}

/** Даты начала стримов по периодам для дашборда */
export interface StreamSessionStartsByWindow {
  d7: number[];
  d14: number[];
  d30: number[];
  d60: number[];
}

/**
 * Преобразует период в миллисекунды
 */
export function streamCountWindowMs(days: StreamCountWindowDays): number {
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Формирует уникальный ключ сессии стрима (broadcast id или метка времени старта)
 */
export function buildStreamSessionKey(
  startedAt: number,
  broadcastId?: string | null
): string {
  const trimmed = broadcastId?.trim();
  if (trimmed) {
    return trimmed;
  }
  return `ts:${startedAt}`;
}

/** Порог (мс): один broadcast id с близким started_at — повтор записи, иначе устаревший id */
const STREAM_SESSION_SAME_START_TOLERANCE_MS = 60_000;

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
  lastStreamDurationMs: number | null; // Длительность последнего завершённого стрима (мс)
  lastGame: string | null; // Последняя категория стрима
  lastBalance: number | null; // Последний известный баланс баллов (currentPoints)
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
        last_stream_end INTEGER,
        last_stream_duration_ms INTEGER
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

    try {
      this.db.exec(`
        ALTER TABLE streamers ADD COLUMN last_balance INTEGER;
      `);
    } catch (error: any) {
      // Поле уже существует - это нормально
      if (!error.message?.includes('duplicate column name')) {
        logger.verbose(`⚠️  Failed to add last_balance column: ${error.message}`);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE streamers ADD COLUMN last_stream_duration_ms INTEGER;
      `);
    } catch (error: any) {
      if (!error.message?.includes('duplicate column name')) {
        logger.verbose(`⚠️  Failed to add last_stream_duration_ms column: ${error.message}`);
      }
    }

    try {
      this.db.exec(`
        UPDATE streamers
        SET last_stream_duration_ms = last_stream_end - last_stream_start
        WHERE last_stream_start IS NOT NULL
          AND last_stream_end IS NOT NULL
          AND last_stream_end >= last_stream_start
          AND (last_stream_duration_ms IS NULL OR last_stream_duration_ms = 0)
      `);
    } catch (error: any) {
      logger.verbose(`⚠️  Failed to backfill last_stream_duration_ms: ${error.message}`);
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

    // Сессии стримов (для подсчёта количества стримов за период)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stream_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        streamer_id INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE,
        UNIQUE(streamer_id, session_key)
      )
    `);

    // Уникальные категории в рамках одной сессии стрима
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stream_session_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_session_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        FOREIGN KEY (stream_session_id) REFERENCES stream_sessions(id) ON DELETE CASCADE,
        UNIQUE(stream_session_id, category)
      )
    `);

    // Суммарное время стримов по категориям (все отслеживаемые стримеры)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS category_stream_duration_totals (
        category TEXT NOT NULL PRIMARY KEY,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);

    // Суммарное время стримов по категориям для каждого стримера
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS streamer_category_stream_duration_totals (
        streamer_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (streamer_id, category),
        FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE
      )
    `);

    // Создаем индексы для быстрого поиска
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_daily_points_streamer_date 
      ON daily_points(streamer_id, date);
      
      CREATE INDEX IF NOT EXISTS idx_streamers_username 
      ON streamers(username);

      CREATE INDEX IF NOT EXISTS idx_stream_sessions_streamer_started
      ON stream_sessions(streamer_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_stream_session_categories_session
      ON stream_session_categories(stream_session_id);

      CREATE INDEX IF NOT EXISTS idx_streamer_cat_duration_category
      ON streamer_category_stream_duration_totals(category);
    `);

    logger.verbose(`📊  Database tables created`);
  }

  /**
   * Формирует уникальный ключ сессии стрима (broadcast id или метка времени старта)
   */
  private buildStreamSessionKey(startedAt: number, broadcastId?: string | null): string {
    return buildStreamSessionKey(startedAt, broadcastId);
  }

  /**
   * Возвращает id сессии стрима по ключу
   */
  private getStreamSessionId(streamerId: number, sessionKey: string): number | null {
    if (!this.db) {
      return null;
    }

    const stmt = this.db.prepare(`
      SELECT id FROM stream_sessions
      WHERE streamer_id = ? AND session_key = ?
      LIMIT 1
    `);
    stmt.bind([streamerId, sessionKey]);
    const row = stmt.step() ? (stmt.getAsObject() as { id: number }) : null;
    stmt.free();
    return row?.id ?? null;
  }

  /**
   * Проверяет, есть ли уже сессия с таким ключом
   */
  hasStreamSession(username: string, sessionKey: string): boolean {
    if (!isDatabaseAvailable || !this.db || !sessionKey.trim()) {
      return false;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      const stmt = this.db.prepare(`
        SELECT 1 FROM stream_sessions
        WHERE streamer_id = ? AND session_key = ?
        LIMIT 1
      `);
      stmt.bind([streamerId, sessionKey]);
      const exists = stmt.step();
      stmt.free();
      return exists;
    } catch {
      return false;
    }
  }

  /**
   * Возвращает started_at существующей сессии по ключу (null, если записи нет)
   */
  getStreamSessionStartedAt(username: string, sessionKey: string): number | null {
    if (!isDatabaseAvailable || !this.db || !sessionKey.trim()) {
      return null;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      const stmt = this.db.prepare(`
        SELECT started_at FROM stream_sessions
        WHERE streamer_id = ? AND session_key = ?
        LIMIT 1
      `);
      stmt.bind([streamerId, sessionKey]);
      const row = stmt.step() ? (stmt.getAsObject() as { started_at: number }) : null;
      stmt.free();
      const startedAt = Number(row?.started_at);
      return Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null;
    } catch {
      return null;
    }
  }

  /**
   * Удаляет дубликаты с ключом ts: при появлении записи с broadcast id (та же трансляция)
   */
  private removeStreamSessionTimestampAlias(
    streamerId: number,
    startedAt: number,
    sessionKey: string
  ): void {
    if (!this.db || !sessionKey || sessionKey.startsWith('ts:')) {
      return;
    }

    const tsKey = `ts:${startedAt}`;
    const del = this.db.prepare(`
      DELETE FROM stream_sessions
      WHERE streamer_id = ? AND session_key = ? AND started_at = ?
    `);
    del.bind([streamerId, tsKey, startedAt]);
    del.step();
    del.free();
  }

  /**
   * Удаляет устаревшие ts:-записи, если для того же started_at уже есть ключ с broadcast id
   */
  dedupeStreamSessionTimestampAliases(): void {
    if (!isDatabaseAvailable || !this.db) {
      return;
    }

    try {
      const del = this.db.prepare(`
        DELETE FROM stream_sessions
        WHERE session_key LIKE 'ts:%'
          AND EXISTS (
            SELECT 1 FROM stream_sessions AS dup
            WHERE dup.streamer_id = stream_sessions.streamer_id
              AND dup.started_at = stream_sessions.started_at
              AND dup.session_key NOT LIKE 'ts:%'
          )
      `);
      del.step();
      del.free();
      if (this.config.autoSave) {
        this.saveDatabase();
      }
    } catch (error: any) {
      logger.error(`❌  Failed to dedupe stream sessions: ${error.message || error}`);
    }
  }

  /**
   * Регистрирует начало стрима (одна запись на сессию; повторы с тем же ключом игнорируются)
   * @param username Имя стримера
   * @param startedAt Время начала стрима (timestamp)
   * @param broadcastId Идентификатор трансляции Twitch (если известен)
   * @returns true, если добавлена новая сессия
   */
  recordStreamSession(
    username: string,
    startedAt: number,
    broadcastId?: string | null
  ): boolean {
    if (!isDatabaseAvailable || !this.db || !Number.isFinite(startedAt) || startedAt <= 0) {
      return false;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      let sessionKey = this.buildStreamSessionKey(startedAt, broadcastId);

      if (!sessionKey.startsWith('ts:') && this.hasStreamSession(username, sessionKey)) {
        const existingStartedAt = this.getStreamSessionStartedAt(username, sessionKey);
        if (
          existingStartedAt != null &&
          existingStartedAt !== startedAt &&
          Math.abs(existingStartedAt - startedAt) > STREAM_SESSION_SAME_START_TOLERANCE_MS
        ) {
          // Устаревший broadcastId прошлого стрима — новая трансляция, пишем по ts:
          sessionKey = `ts:${startedAt}`;
        } else {
          return false;
        }
      }

      if (this.hasStreamSession(username, sessionKey)) {
        return false;
      }

      // Не создаём ts:-запись, если уже есть сессия с broadcast id на то же время
      if (sessionKey.startsWith('ts:')) {
        const dup = this.db.prepare(`
          SELECT 1 FROM stream_sessions
          WHERE streamer_id = ? AND started_at = ? AND session_key NOT LIKE 'ts:%'
          LIMIT 1
        `);
        dup.bind([streamerId, startedAt]);
        const hasBroadcastAlias = dup.step();
        dup.free();
        if (hasBroadcastAlias) {
          return false;
        }
      } else {
        this.removeStreamSessionTimestampAlias(streamerId, startedAt, sessionKey);
      }

      const now = Date.now();

      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO stream_sessions (streamer_id, started_at, session_key, created_at)
        VALUES (?, ?, ?, ?)
      `);
      stmt.bind([streamerId, startedAt, sessionKey, now]);
      stmt.step();
      stmt.free();

      const changesResult = this.db.exec('SELECT changes() AS c');
      const inserted = Number(changesResult[0]?.values[0]?.[0] ?? 0) > 0;

      if (inserted && this.config.autoSave) {
        this.saveDatabase();
      }

      if (inserted) {
        logger.verbose(
          `📺  Recorded stream session for ${username} (key=${sessionKey})`
        );
      }

      return inserted;
    } catch (error: any) {
      logger.error(`❌  Failed to record stream session: ${error.message || error}`);
      return false;
    }
  }

  /**
   * Регистрирует категорию в рамках сессии стрима (один раз на категорию за стрим)
   */
  recordStreamSessionCategory(
    username: string,
    sessionKey: string,
    category: string
  ): boolean {
    const normalizedCategory = category?.trim();
    const normalizedSessionKey = sessionKey?.trim();
    if (
      !isDatabaseAvailable ||
      !this.db ||
      !normalizedCategory ||
      !normalizedSessionKey
    ) {
      return false;
    }

    try {
      const streamerId = this.getOrCreateStreamer(username);
      const streamSessionId = this.getStreamSessionId(streamerId, normalizedSessionKey);
      if (!streamSessionId) {
        return false;
      }

      const now = Date.now();
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO stream_session_categories (stream_session_id, category, first_seen_at)
        VALUES (?, ?, ?)
      `);
      stmt.bind([streamSessionId, normalizedCategory, now]);
      stmt.step();
      stmt.free();

      const changesResult = this.db.exec('SELECT changes() AS c');
      const inserted = Number(changesResult[0]?.values[0]?.[0] ?? 0) > 0;

      if (inserted && this.config.autoSave) {
        this.saveDatabase();
      }

      if (inserted) {
        logger.verbose(
          `🎮  Recorded stream category for ${username}: ${normalizedCategory} (session=${normalizedSessionKey})`
        );
      }

      return inserted;
    } catch (error: any) {
      logger.error(`❌  Failed to record stream category: ${error.message || error}`);
      return false;
    }
  }

  /**
   * Количество стримов по категориям для всех стримеров
   */
  getCategoryStreamCountsByUsername(): Map<string, StreamerCategoryStreamCount[]> {
    const result = new Map<string, StreamerCategoryStreamCount[]>();
    if (!isDatabaseAvailable || !this.db) {
      return result;
    }

    try {
      const stmt = this.db.prepare(`
        SELECT s.username, ssc.category, COUNT(DISTINCT ss.id) AS stream_count
        FROM stream_session_categories ssc
        INNER JOIN stream_sessions ss ON ss.id = ssc.stream_session_id
        INNER JOIN streamers s ON s.id = ss.streamer_id
        GROUP BY s.id, ssc.category
        ORDER BY s.username ASC, stream_count DESC, ssc.category ASC
      `);

      while (stmt.step()) {
        const row = stmt.getAsObject() as {
          username: string;
          category: string;
          stream_count: number;
        };
        if (!row.username || !row.category) {
          continue;
        }
        const key = String(row.username).toLowerCase();
        const entry: StreamerCategoryStreamCount = {
          category: String(row.category),
          streamCount: Number(row.stream_count) || 0,
        };
        const list = result.get(key) ?? [];
        list.push(entry);
        result.set(key, list);
      }
      stmt.free();
    } catch (error: any) {
      logger.error(`❌  Failed to get category stream counts: ${error.message || error}`);
    }

    return result;
  }

  /**
   * Добавляет время стрима к суммарной статистике категории и стримера
   */
  addCategoryStreamDuration(username: string, category: string, durationMs: number): boolean {
    const normalizedUsername = username?.trim();
    const normalizedCategory = category?.trim();
    const delta = Math.floor(durationMs);
    if (
      !isDatabaseAvailable ||
      !this.db ||
      !normalizedUsername ||
      !normalizedCategory ||
      delta <= 0
    ) {
      return false;
    }

    try {
      const streamerId = this.getOrCreateStreamer(normalizedUsername);
      const now = Date.now();

      const categoryStmt = this.db.prepare(`
        INSERT INTO category_stream_duration_totals (category, duration_ms, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(category) DO UPDATE SET
          duration_ms = duration_ms + excluded.duration_ms,
          updated_at = excluded.updated_at
      `);
      categoryStmt.bind([normalizedCategory, delta, now]);
      categoryStmt.step();
      categoryStmt.free();

      const streamerStmt = this.db.prepare(`
        INSERT INTO streamer_category_stream_duration_totals (streamer_id, category, duration_ms, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(streamer_id, category) DO UPDATE SET
          duration_ms = duration_ms + excluded.duration_ms,
          updated_at = excluded.updated_at
      `);
      streamerStmt.bind([streamerId, normalizedCategory, delta, now]);
      streamerStmt.step();
      streamerStmt.free();

      if (this.config.autoSave) {
        this.saveDatabase();
      }
      return true;
    } catch (error: any) {
      logger.error(`❌  Failed to add category stream duration: ${error.message || error}`);
      return false;
    }
  }

  /**
   * Возвращает время стримов по стримерам для одной категории
   */
  getStreamerCategoryStreamDurations(category: string): StreamerCategoryStreamDurationEntry[] {
    const normalizedCategory = category?.trim();
    const result: StreamerCategoryStreamDurationEntry[] = [];
    if (!isDatabaseAvailable || !this.db || !normalizedCategory) {
      return result;
    }

    try {
      const stmt = this.db.prepare(`
        SELECT s.username, sc.duration_ms
        FROM streamer_category_stream_duration_totals sc
        INNER JOIN streamers s ON s.id = sc.streamer_id
        WHERE sc.category = ? AND sc.duration_ms > 0
        ORDER BY sc.duration_ms DESC, s.username ASC
      `);
      stmt.bind([normalizedCategory]);

      while (stmt.step()) {
        const row = stmt.getAsObject() as { username: string; duration_ms: number };
        if (!row.username) {
          continue;
        }
        result.push({
          streamerName: String(row.username),
          durationMs: Number(row.duration_ms) || 0,
        });
      }
      stmt.free();
    } catch (error: any) {
      logger.error(
        `❌  Failed to get streamer category stream durations: ${error.message || error}`
      );
    }

    return result;
  }

  /**
   * Возвращает все записи времени стримов по парам стример-категория
   */
  getAllStreamerCategoryStreamDurationRows(): Array<{
    category: string;
    streamerName: string;
    durationMs: number;
  }> {
    const result: Array<{ category: string; streamerName: string; durationMs: number }> = [];
    if (!isDatabaseAvailable || !this.db) {
      return result;
    }

    try {
      const stmt = this.db.prepare(`
        SELECT sc.category, s.username, sc.duration_ms
        FROM streamer_category_stream_duration_totals sc
        INNER JOIN streamers s ON s.id = sc.streamer_id
        WHERE sc.duration_ms > 0
        ORDER BY sc.category ASC, sc.duration_ms DESC, s.username ASC
      `);

      while (stmt.step()) {
        const row = stmt.getAsObject() as {
          category: string;
          username: string;
          duration_ms: number;
        };
        if (!row.category || !row.username) {
          continue;
        }
        result.push({
          category: String(row.category),
          streamerName: String(row.username),
          durationMs: Number(row.duration_ms) || 0,
        });
      }
      stmt.free();
    } catch (error: any) {
      logger.error(
        `❌  Failed to get all streamer category stream durations: ${error.message || error}`
      );
    }

    return result;
  }

  /**
   * Возвращает суммарное время стримов по категориям с разбивкой по стримерам
   */
  getCategoryStreamDurationDetails(): CategoryStreamDurationTotal[] {
    const totals = this.getCategoryStreamDurationTotals();
    const streamersByCategory = new Map<string, StreamerCategoryStreamDurationEntry[]>();

    for (const row of this.getAllStreamerCategoryStreamDurationRows()) {
      if (!streamersByCategory.has(row.category)) {
        streamersByCategory.set(row.category, []);
      }
      streamersByCategory.get(row.category)!.push({
        streamerName: row.streamerName,
        durationMs: row.durationMs,
      });
    }

    return totals.map((entry) => ({
      ...entry,
      streamers: streamersByCategory.get(entry.category) ?? [],
    }));
  }

  /**
   * Возвращает суммарное время стримов по всем зафиксированным категориям
   */
  getCategoryStreamDurationTotals(): CategoryStreamDurationTotal[] {
    const result: CategoryStreamDurationTotal[] = [];
    if (!isDatabaseAvailable || !this.db) {
      return result;
    }

    try {
      const stmt = this.db.prepare(`
        SELECT category, duration_ms
        FROM category_stream_duration_totals
        WHERE duration_ms > 0
        ORDER BY duration_ms DESC, category ASC
      `);

      while (stmt.step()) {
        const row = stmt.getAsObject() as { category: string; duration_ms: number };
        if (!row.category) {
          continue;
        }
        result.push({
          category: String(row.category),
          durationMs: Number(row.duration_ms) || 0,
          streamers: [],
        });
      }
      stmt.free();
    } catch (error: any) {
      logger.error(`❌  Failed to get category stream duration totals: ${error.message || error}`);
    }

    return result;
  }

  /**
   * Даты начала стримов по периодам для всех стримеров (ключ — username в нижнем регистре)
   */
  getStreamSessionStartsByUsernameByWindows(): Map<string, StreamSessionStartsByWindow> {
    const result = new Map<string, StreamSessionStartsByWindow>();
    if (!isDatabaseAvailable || !this.db) {
      return result;
    }

    const now = Date.now();
    const since7 = now - streamCountWindowMs(7);
    const since14 = now - streamCountWindowMs(14);
    const since30 = now - streamCountWindowMs(30);
    const since60 = now - streamCountWindowMs(60);

    try {
      const stmt = this.db.prepare(`
        SELECT s.username, ss.started_at
        FROM stream_sessions ss
        INNER JOIN streamers s ON s.id = ss.streamer_id
        WHERE ss.started_at >= ?
        ORDER BY ss.started_at DESC
      `);
      stmt.bind([since60]);

      const seenByUser = new Map<string, Set<number>>();

      while (stmt.step()) {
        const row = stmt.getAsObject() as { username: string; started_at: number };
        if (!row.username || !row.started_at) {
          continue;
        }
        const key = String(row.username).toLowerCase();
        const startedAt = Number(row.started_at);
        if (!Number.isFinite(startedAt) || startedAt <= 0) {
          continue;
        }

        let seen = seenByUser.get(key);
        if (!seen) {
          seen = new Set<number>();
          seenByUser.set(key, seen);
        }
        if (seen.has(startedAt)) {
          continue;
        }
        seen.add(startedAt);

        let windows = result.get(key);
        if (!windows) {
          windows = { d7: [], d14: [], d30: [], d60: [] };
          result.set(key, windows);
        }

        if (startedAt >= since60) {
          windows.d60.push(startedAt);
        }
        if (startedAt >= since30) {
          windows.d30.push(startedAt);
        }
        if (startedAt >= since14) {
          windows.d14.push(startedAt);
        }
        if (startedAt >= since7) {
          windows.d7.push(startedAt);
        }
      }
      stmt.free();
    } catch (error: any) {
      logger.error(`❌  Failed to get stream session starts: ${error.message || error}`);
    }

    return result;
  }

  /**
   * Количество стримов стримера за последние 30 суток
   */
  getStreamCountLast30Days(username: string): number {
    const counts = this.getStreamCountsLast30DaysByUsername();
    return counts.get(username.toLowerCase()) ?? 0;
  }

  /**
   * Количество стримов за 30 суток для всех стримеров (ключ — username в нижнем регистре)
   */
  getStreamCountsLast30DaysByUsername(): Map<string, number> {
    const all = this.getStreamCountsByUsernameByWindows();
    const result = new Map<string, number>();
    for (const [username, windows] of all) {
      result.set(username, windows.d30);
    }
    return result;
  }

  /**
   * Количество стримов за указанный период для всех стримеров (ключ — username в нижнем регистре)
   */
  getStreamCountsByUsername(windowDays: StreamCountWindowDays): Map<string, number> {
    const all = this.getStreamCountsByUsernameByWindows();
    const field = this.streamCountWindowField(windowDays);
    const result = new Map<string, number>();
    for (const [username, windows] of all) {
      result.set(username, windows[field]);
    }
    return result;
  }

  /**
   * Количество стримов по периодам 7/14/30/60 суток для всех стримеров
   */
  getStreamCountsByUsernameByWindows(): Map<string, StreamCountsByWindow> {
    const result = new Map<string, StreamCountsByWindow>();
    if (!isDatabaseAvailable || !this.db) {
      return result;
    }

    const now = Date.now();
    const since7 = now - streamCountWindowMs(7);
    const since14 = now - streamCountWindowMs(14);
    const since30 = now - streamCountWindowMs(30);
    const since60 = now - streamCountWindowMs(60);

    try {
      const stmt = this.db.prepare(`
        SELECT s.username,
          COUNT(DISTINCT CASE WHEN ss.started_at >= ? THEN ss.started_at END) AS c7,
          COUNT(DISTINCT CASE WHEN ss.started_at >= ? THEN ss.started_at END) AS c14,
          COUNT(DISTINCT CASE WHEN ss.started_at >= ? THEN ss.started_at END) AS c30,
          COUNT(DISTINCT CASE WHEN ss.started_at >= ? THEN ss.started_at END) AS c60
        FROM stream_sessions ss
        INNER JOIN streamers s ON s.id = ss.streamer_id
        WHERE ss.started_at >= ?
        GROUP BY s.id
      `);
      stmt.bind([since7, since14, since30, since60, since60]);

      while (stmt.step()) {
        const row = stmt.getAsObject() as {
          username: string;
          c7: number;
          c14: number;
          c30: number;
          c60: number;
        };
        if (row.username) {
          result.set(String(row.username).toLowerCase(), {
            d7: Number(row.c7) || 0,
            d14: Number(row.c14) || 0,
            d30: Number(row.c30) || 0,
            d60: Number(row.c60) || 0,
          });
        }
      }
      stmt.free();
    } catch (error: any) {
      logger.error(`❌  Failed to get stream counts by windows: ${error.message || error}`);
    }

    return result;
  }

  private streamCountWindowField(
    windowDays: StreamCountWindowDays
  ): keyof StreamCountsByWindow {
    switch (windowDays) {
      case 7:
        return 'd7';
      case 14:
        return 'd14';
      case 30:
        return 'd30';
      case 60:
        return 'd60';
      default:
        return 'd30';
    }
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
      'INSERT INTO streamers (username, total_points, total_watch_time_ms, created_at, updated_at, last_stream_start, last_stream_end, last_stream_duration_ms) VALUES (?, 0, 0, ?, ?, NULL, NULL, NULL)'
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
      const stmt = this.db.prepare(
        'SELECT username, total_points, total_watch_time_ms, created_at, updated_at, last_stream_start, last_stream_end, last_stream_duration_ms, last_game, last_balance FROM streamers WHERE username = ?'
      );
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
        lastStreamDurationMs: result.last_stream_duration_ms ?? null,
        lastGame: result.last_game ?? null,
        lastBalance: result.last_balance ?? null,
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
      const stmt = this.db.prepare(
        'SELECT username, total_points, total_watch_time_ms, created_at, updated_at, last_stream_start, last_stream_end, last_stream_duration_ms, last_game, last_balance FROM streamers ORDER BY total_points DESC'
      );
      
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
          lastStreamDurationMs: row.last_stream_duration_ms ?? null,
          lastGame: row.last_game ?? null,
          lastBalance: row.last_balance ?? null,
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

      let durationMs: number | null = null;
      const startStmt = this.db.prepare('SELECT last_stream_start FROM streamers WHERE id = ?');
      startStmt.bind([streamerId]);
      const startRow = startStmt.step() ? (startStmt.getAsObject() as { last_stream_start: number | null }) : null;
      startStmt.free();

      const streamStart = startRow?.last_stream_start;
      if (streamStart != null && timestamp >= streamStart) {
        durationMs = timestamp - streamStart;
      }

      const stmt = this.db.prepare(
        'UPDATE streamers SET last_stream_end = ?, last_stream_duration_ms = ?, updated_at = ? WHERE id = ?'
      );
      stmt.bind([timestamp, durationMs, now, streamerId]);
      stmt.step();
      stmt.free();

      if (this.config.autoSave) {
        this.saveDatabase();
      }

      const durationLabel =
        durationMs != null ? `, duration ${Math.round(durationMs / 60_000)} min` : '';
      logger.verbose(
        `📺  Updated last stream end for ${username}: ${new Date(timestamp).toISOString()}${durationLabel}`
      );
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
   * Обновляет последний известный баланс баллов стримера
   * @param username Имя стримера
   * @param balance Текущий баланс баллов
   */
  updateLastBalance(username: string, balance: number | null): void {
    if (!isDatabaseAvailable || !this.db) {
      return;
    }
    try {
      const streamerId = this.getOrCreateStreamer(username);
      const now = Date.now();
      const stmt = this.db.prepare('UPDATE streamers SET last_balance = ?, updated_at = ? WHERE id = ?');
      stmt.bind([balance, now, streamerId]);
      stmt.step();
      stmt.free();
      if (this.config.autoSave) {
        this.saveDatabase();
      }
      logger.verbose(`💰  Updated last balance for ${username}: ${balance || 'null'}`);
    } catch (error: any) {
      logger.error(`❌  Failed to update last balance: ${error.message || error}`);
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

