/**
 * Модуль для сохранения статистики просмотра в файл
 */

import * as fs from 'fs';
import * as path from 'path';
import { WatchSession, AggregatedStatistics } from './types';
import { logger } from './logger';
import dayjs from 'dayjs';

/**
 * Конфигурация сохранения статистики
 */
export interface StatisticsStorageConfig {
  storagePath: string; // Путь к директории для хранения файлов
  format: 'json' | 'csv' | 'both'; // Формат сохранения
  rotationDays: number; // Количество дней для хранения записей (0 = без ограничений)
  autoSave: boolean; // Автоматическое сохранение при завершении сессии
}

/**
 * Параметры по умолчанию
 */
const DEFAULT_CONFIG: StatisticsStorageConfig = {
  storagePath: './statistics',
  format: 'json',
  rotationDays: 30, // Хранить записи за последние 30 дней
  autoSave: true,
};

/**
 * Модуль для сохранения и управления статистикой просмотра
 */
export class StatisticsStorage {
  private config: StatisticsStorageConfig;
  private sessions: WatchSession[] = [];
  private sessionsFilePath: string;
  private isInitialized = false;

  /**
   * Создает экземпляр модуля сохранения статистики
   * @param config Конфигурация сохранения
   */
  constructor(config: Partial<StatisticsStorageConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionsFilePath = path.join(this.config.storagePath, 'sessions.json');
    this.initialize();
  }

  /**
   * Инициализирует модуль (создает директорию, загружает существующие данные)
   */
  private initialize(): void {
    try {
      // Создаем директорию, если её нет
      if (!fs.existsSync(this.config.storagePath)) {
        fs.mkdirSync(this.config.storagePath, { recursive: true });
        logger.verbose(`📁  Created statistics directory: ${this.config.storagePath}`);
      }

      // Загружаем существующие сессии
      this.loadSessions();
      
      // Выполняем ротацию старых записей
      this.rotateOldSessions();
      
      this.isInitialized = true;
      logger.info(`✅  Statistics storage initialized (${this.sessions.length} sessions loaded)`);
    } catch (error: any) {
      logger.error(`❌  Failed to initialize statistics storage: ${error.message || error}`);
    }
  }

  /**
   * Загружает сессии из файла
   */
  private loadSessions(): void {
    try {
      if (fs.existsSync(this.sessionsFilePath)) {
        const data = fs.readFileSync(this.sessionsFilePath, 'utf8');
        this.sessions = JSON.parse(data);
        logger.verbose(`📂  Loaded ${this.sessions.length} sessions from file`);
      }
    } catch (error: any) {
      logger.warn(`⚠️  Failed to load sessions: ${error.message || error}`);
      this.sessions = [];
    }
  }

  /**
   * Сохраняет сессии в файл
   */
  private saveSessions(): void {
    try {
      const data = JSON.stringify(this.sessions, null, 2);
      fs.writeFileSync(this.sessionsFilePath, data, 'utf8');
    } catch (error: any) {
      logger.error(`❌  Failed to save sessions: ${error.message || error}`);
    }
  }

  /**
   * Выполняет ротацию старых записей
   */
  private rotateOldSessions(): void {
    if (this.config.rotationDays <= 0) {
      return; // Ротация отключена
    }

    const cutoffDate = Date.now() - (this.config.rotationDays * 24 * 60 * 60 * 1000);
    const initialCount = this.sessions.length;
    
    // Удаляем сессии старше указанного периода
    this.sessions = this.sessions.filter(session => {
      // Используем endTime, если есть, иначе startTime
      const sessionDate = session.endTime || session.startTime;
      return sessionDate >= cutoffDate;
    });

    const removedCount = initialCount - this.sessions.length;
    if (removedCount > 0) {
      logger.info(`🗑️  Rotated ${removedCount} old sessions (older than ${this.config.rotationDays} days)`);
      this.saveSessions();
    }
  }

  /**
   * Создает новую сессию просмотра
   * @param streamerName Имя стримера
   * @param initialChannelPoints Начальные баллы канала
   * @param game Игра стримера (опционально)
   * @param title Название стрима (опционально)
   * @returns ID созданной сессии
   */
  createSession(
    streamerName: string,
    initialChannelPoints: number,
    game?: string | null,
    title?: string | null
  ): string {
    const sessionId = `${streamerName}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    const session: WatchSession = {
      id: sessionId,
      streamerName,
      startTime: Date.now(),
      endTime: null,
      initialChannelPoints,
      finalChannelPoints: null,
      pointsEarned: 0,
      duration: 0,
      status: 'active',
      game: game || null,
      title: title || null,
    };

    this.sessions.push(session);
    
    if (this.config.autoSave) {
      this.saveSessions();
    }

    logger.verbose(`📝  Created session ${sessionId} for ${streamerName}`);
    return sessionId;
  }

  /**
   * Завершает сессию просмотра
   * @param sessionId ID сессии
   * @param finalChannelPoints Конечные баллы канала
   * @param status Статус завершения ('completed' или 'interrupted')
   */
  endSession(sessionId: string, finalChannelPoints: number, status: 'completed' | 'interrupted' = 'completed'): void {
    const session = this.sessions.find(s => s.id === sessionId);
    if (!session) {
      logger.warn(`⚠️  Session ${sessionId} not found`);
      return;
    }

    session.endTime = Date.now();
    session.finalChannelPoints = finalChannelPoints;
    session.pointsEarned = finalChannelPoints - session.initialChannelPoints;
    session.duration = session.endTime - session.startTime;
    session.status = status;

    if (this.config.autoSave) {
      this.saveSessions();
    }

    logger.verbose(`✅  Ended session ${sessionId} for ${session.streamerName} (${session.pointsEarned} points, ${Math.floor(session.duration / 1000)}s)`);
  }

  /**
   * Обновляет текущие баллы активной сессии
   * @param sessionId ID сессии
   * @param currentChannelPoints Текущие баллы канала
   */
  updateSession(sessionId: string, currentChannelPoints: number): void {
    const session = this.sessions.find(s => s.id === sessionId && s.status === 'active');
    if (!session) {
      return;
    }

    // Обновляем заработанные баллы для активной сессии
    session.pointsEarned = currentChannelPoints - session.initialChannelPoints;
    
    // Не сохраняем при каждом обновлении, только при завершении
  }

  /**
   * Получает все сессии
   * @param streamerName Фильтр по имени стримера (опционально)
   * @param limit Ограничение количества записей (опционально)
   * @returns Массив сессий
   */
  getSessions(streamerName?: string, limit?: number): WatchSession[] {
    let sessions = this.sessions;

    if (streamerName) {
      sessions = sessions.filter(s => s.streamerName === streamerName);
    }

    // Сортируем по времени начала (новые первыми)
    sessions.sort((a, b) => b.startTime - a.startTime);

    if (limit) {
      sessions = sessions.slice(0, limit);
    }

    return sessions;
  }

  /**
   * Получает агрегированную статистику за период
   * @param period Период агрегации
   * @param startDate Начало периода (timestamp, опционально)
   * @returns Агрегированная статистика
   */
  getAggregatedStatistics(period: 'day' | 'week' | 'month', startDate?: number): AggregatedStatistics {
    const now = Date.now();
    let periodStart: number;
    let periodEnd: number = now;

    if (startDate) {
      periodStart = startDate;
    } else {
      // Вычисляем начало периода от текущего момента
      switch (period) {
        case 'day':
          periodStart = dayjs().startOf('day').valueOf();
          break;
        case 'week':
          periodStart = dayjs().startOf('week').valueOf();
          break;
        case 'month':
          periodStart = dayjs().startOf('month').valueOf();
          break;
      }
    }

    // Фильтруем сессии по периоду
    const periodSessions = this.sessions.filter(session => {
      const sessionDate = session.endTime || session.startTime;
      return sessionDate >= periodStart && sessionDate <= periodEnd;
    });

    // Вычисляем общую статистику
    const totalSessions = periodSessions.length;
    const totalPointsEarned = periodSessions.reduce((sum, s) => sum + s.pointsEarned, 0);
    const totalWatchTime = periodSessions.reduce((sum, s) => sum + s.duration, 0);
    const averagePointsPerSession = totalSessions > 0 ? totalPointsEarned / totalSessions : 0;
    const averageSessionDuration = totalSessions > 0 ? totalWatchTime / totalSessions : 0;

    // Группируем по стримерам
    const streamersMap = new Map<string, { sessions: number; pointsEarned: number; watchTime: number }>();
    
    for (const session of periodSessions) {
      const existing = streamersMap.get(session.streamerName) || { sessions: 0, pointsEarned: 0, watchTime: 0 };
      existing.sessions++;
      existing.pointsEarned += session.pointsEarned;
      existing.watchTime += session.duration;
      streamersMap.set(session.streamerName, existing);
    }

    const streamers = Array.from(streamersMap.entries()).map(([streamerName, stats]) => ({
      streamerName,
      ...stats,
    }));

    return {
      period,
      startDate: periodStart,
      endDate: periodEnd,
      totalSessions,
      totalPointsEarned,
      totalWatchTime,
      averagePointsPerSession,
      averageSessionDuration,
      streamers,
    };
  }

  /**
   * Экспортирует сессии в CSV формат
   * @param filePath Путь к файлу для сохранения (опционально)
   * @param streamerName Фильтр по имени стримера (опционально)
   * @returns Путь к созданному файлу
   */
  exportToCSV(filePath?: string, streamerName?: string): string {
    const sessions = this.getSessions(streamerName);
    
    if (!filePath) {
      const timestamp = dayjs().format('YYYY-MM-DD_HH-mm-ss');
      const filename = streamerName 
        ? `sessions_${streamerName}_${timestamp}.csv`
        : `sessions_${timestamp}.csv`;
      filePath = path.join(this.config.storagePath, filename);
    }

    // Заголовки CSV
    const headers = [
      'ID',
      'Streamer',
      'Start Time',
      'End Time',
      'Duration (ms)',
      'Initial Points',
      'Final Points',
      'Points Earned',
      'Status',
      'Game',
      'Title',
    ];

    // Данные
    const rows = sessions.map(session => [
      session.id,
      session.streamerName,
      new Date(session.startTime).toISOString(),
      session.endTime ? new Date(session.endTime).toISOString() : '',
      session.duration.toString(),
      session.initialChannelPoints.toString(),
      session.finalChannelPoints?.toString() || '',
      session.pointsEarned.toString(),
      session.status,
      session.game || '',
      session.title || '',
    ]);

    // Экранируем значения для CSV
    const escapeCSV = (value: string): string => {
      if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    };

    const csvContent = [
      headers.map(escapeCSV).join(','),
      ...rows.map(row => row.map(escapeCSV).join(',')),
    ].join('\n');

    fs.writeFileSync(filePath, csvContent, 'utf8');
    logger.info(`📊  Exported ${sessions.length} sessions to CSV: ${filePath}`);
    
    return filePath;
  }

  /**
   * Экспортирует сессии в JSON формат
   * @param filePath Путь к файлу для сохранения (опционально)
   * @param streamerName Фильтр по имени стримера (опционально)
   * @returns Путь к созданному файлу
   */
  exportToJSON(filePath?: string, streamerName?: string): string {
    const sessions = this.getSessions(streamerName);
    
    if (!filePath) {
      const timestamp = dayjs().format('YYYY-MM-DD_HH-mm-ss');
      const filename = streamerName 
        ? `sessions_${streamerName}_${timestamp}.json`
        : `sessions_${timestamp}.json`;
      filePath = path.join(this.config.storagePath, filename);
    }

    const data = {
      exportDate: new Date().toISOString(),
      totalSessions: sessions.length,
      sessions,
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    logger.info(`📊  Exported ${sessions.length} sessions to JSON: ${filePath}`);
    
    return filePath;
  }

  /**
   * Принудительно сохраняет сессии в файл
   */
  save(): void {
    this.saveSessions();
  }

  /**
   * Получает путь к директории статистики
   * @returns Путь к директории
   */
  getStoragePath(): string {
    return this.config.storagePath;
  }
}

