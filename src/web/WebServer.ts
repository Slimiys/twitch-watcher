/**
 * Веб-сервер для мониторинга и dashboard
 */

import express, { Express, Request, Response } from 'express';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../modes/api/logger';
import {
  ensureHttpsCredentials,
  getWebServerScheme,
  isWebServerHttpsEnabled,
  resolveHttpsCredentialPaths,
} from './httpsCredentials';
import { createDashboardApiKeyMiddleware } from './apiAuth';
import {
  getIntegrityCaptureStatus,
  postIntegrityCapture,
  postIntegrityCaptureRequest,
} from './integrityCaptureApi';
import { BotHealthSnapshot } from '../modes/api/botHealthTypes';
import { getAppVersionParts } from '../appVersion';
import {
  isDashboardUpdateEnabled,
  isDashboardUpdateInProgress,
  triggerDashboardUpdate,
  triggerDashboardRestart,
  triggerDashboardStop,
  validateDashboardUpdateRequest,
} from './appUpdate';
import { buildAppUpdateStatus } from './appUpdateStatus';
import {
  applyWatchSettingsFromApi,
  readWatchSettingsForApi,
} from './watchSettingsApi';
import { applyAppSettingsApi, readAppSettingsApi } from './appSettingsApi';
import { StreamWatcher } from '../modes/api/StreamWatcher';

/**
 * Интерфейс для провайдера данных статистики
 */
export interface StatisticsProvider {
  /**
   * Получает статистику просмотра
   * @param includeOffline Включать ли офлайн стримеров
   */
  getStatistics(includeOffline?: boolean): Array<{
    streamerName: string;
    elapsedTime: number;
    pointsEarned: number;
    currentPoints: number;
    status: string;
    game: string | null;
  }>;

  /**
   * Получает информацию о всех стримерах
   */
  getStreamersInfo(): Array<{
    username: string;
    isOnline: boolean;
    channelPoints: number;
    startTime: number;
  }>;

  /**
   * Получает общую статистику
   */
  getOverallStats(): {
    activeWatches: number;
    totalPointsEarned: number;
    lastActivity: number;
    lastOnlineStreamer: string | null;
    streamersCount: number;
  };

  /**
   * Получает историю событий
   */
  getEventsHistory(): Array<{
    timestamp: number;
    type: string;
    streamer: string;
    message: string;
  }>;

  /**
   * Получает историю баллов
   */
  getPointsHistory(): Array<{
    timestamp: number;
    streamer: string;
    points: number;
    totalPoints: number;
  }>;

  /**
   * Получает критические уведомления
   */
  getCriticalNotifications(): Array<{
    id: string;
    type: 'error' | 'warning';
    title: string;
    message: string;
    timestamp: number;
  }>;

  /**
   * Удаляет критическое уведомление
   */
  dismissCriticalNotification?(id: string): void;

  /**
   * Получает информацию о токене
   */
  /**
   * Снимок настроек minute-watched (режим, интервал, очередь)
   */
  getWatchSettingsSnapshot?(): {
    cycleIntervalMs: number;
    cycleIntervalSec: number;
    lastSequentialStreamer: string | null;
    onlineCount: number;
  };

  /**
   * Применяет интервал ротации minute-watched без перезапуска процесса
   */
  applyWatchSettings?(partial: {
    cycleIntervalMs?: number;
  }): {
    cycleIntervalMs: number;
    cycleIntervalSec: number;
    lastSequentialStreamer: string | null;
    onlineCount: number;
  };

  getTokenInfo?(): {
    isValid: boolean;
    expiresAt?: number;
    minutesRemaining?: number;
    hoursRemaining?: number;
    daysRemaining?: number;
    status: 'valid' | 'expired' | 'invalid' | 'unknown';
    tokenInfo?: {
      client_id: string;
      login?: string;
      user_id: string;
      scopes?: string[];
    };
  } | null;

  /**
   * Добавляет тестовое критическое уведомление
   */
  addTestCriticalNotification?(type: 'error' | 'warning'): void;

  /**
   * Добавляет стримера для отслеживания
   */
  addStreamer?(username: string): Promise<{ success: boolean; message: string }>;

  /**
   * Удаляет стримера из отслеживания
   */
  removeStreamer?(username: string): Promise<{ success: boolean; message: string }>;

  /**
   * Помечает токен как невалидный (для тестирования)
   */
  markTokenAsInvalid?(): void;

  /**
   * Заполняет приложение тестовыми данными
   */
  fillTestData?(): Promise<{ eventsCount: number; streamersCount: number }>;

  /**
   * Снимок здоровья бота (WebSocket, integrity, claim, GraphQL)
   */
  getBotHealth?(): BotHealthSnapshot;
}

/**
 * Веб-сервер для dashboard и API
 */
export class WebServer {
  private app: Express;
  private server: any = null;
  private port: number;
  private statisticsProvider: StatisticsProvider | null = null;

  /**
   * Создает экземпляр веб-сервера
   * @param port Порт для веб-сервера
   */
  constructor(port: number = 3001) {
    this.port = port;
    this.app = express();

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Настраивает middleware
   */
  private setupMiddleware(): void {
    // CORS для API
    this.app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
      
      if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
      }
      
      next();
    });

    // Парсинг JSON
    this.app.use(express.json());

    // API-ключ для /api/* (если задан WEB_DASHBOARD_API_KEY)
    this.app.use(createDashboardApiKeyMiddleware());
  }

  /**
   * Настраивает маршруты
   */
  private setupRoutes(): void {
    // API маршруты - должны быть ДО статических файлов
    // Эндпоинт для проверки статуса инициализации
    this.app.get('/api/server-info', (_req: Request, res: Response) => {
      const { certPath, keyPath } = resolveHttpsCredentialPaths();
      const { semver, revision, label } = getAppVersionParts();
      const dashboardUpdateCheck = validateDashboardUpdateRequest();
      res.json({
        scheme: getWebServerScheme(),
        httpsEnabled: isWebServerHttpsEnabled(),
        port: this.port,
        webServerHttpsEnv: process.env.WEB_SERVER_HTTPS ?? null,
        certPath,
        keyPath,
        certExists: fs.existsSync(certPath),
        keyExists: fs.existsSync(keyPath),
        pid: process.pid,
        /** Момент старта процесса бота (сбрасывается при перезапуске) */
        processStartedAt: Date.now() - Math.floor(process.uptime() * 1000),
        uptimeMs: Math.floor(process.uptime() * 1000),
        appVersion: label,
        appSemver: semver,
        gitRevision: revision,
        dashboardUpdateEnabled: isDashboardUpdateEnabled(),
        dashboardUpdateCanTrigger: dashboardUpdateCheck.ok,
        dashboardUpdateBlockedReason:
          dashboardUpdateCheck.ok === false ? dashboardUpdateCheck.error : null,
        dashboardUpdateInProgress: isDashboardUpdateInProgress(),
      });
    });

    this.app.get('/api/app-update-check', (req: Request, res: Response) => {
      try {
        const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
        res.json(buildAppUpdateStatus(forceRefresh));
      } catch (error: any) {
        logger.error('Error checking app update:', error);
        res.status(500).json({
          error: error.message || 'Unknown error',
          updateAvailable: false,
          uiState: 'error',
          indicatorLabel: 'Ошибка проверки',
        });
      }
    });

    this.app.post('/api/app-update', (req: Request, res: Response) => {
      try {
        const result = triggerDashboardUpdate();
        if (!result.started) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (error: any) {
        logger.error('Error triggering app update:', error);
        res.status(500).json({ started: false, message: error.message || 'Unknown error' });
      }
    });

    this.app.post('/api/app-stop', (req: Request, res: Response) => {
      try {
        const result = triggerDashboardStop();
        if (!result.started) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (error: any) {
        logger.error('Error triggering app stop:', error);
        res.status(500).json({ started: false, message: error.message || 'Unknown error' });
      }
    });

    this.app.post('/api/app-restart', (req: Request, res: Response) => {
      try {
        const result = triggerDashboardRestart();
        if (!result.started) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (error: any) {
        logger.error('Error triggering app restart:', error);
        res.status(500).json({ started: false, message: error.message || 'Unknown error' });
      }
    });

    this.app.get('/api/bot-health', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider?.getBotHealth) {
          const { semver, revision, label } = getAppVersionParts();
          res.status(503).json({
            error: 'Watcher is not running',
            appVersion: label,
            appSemver: semver,
            gitRevision: revision,
            watcherRunning: false,
          });
          return;
        }
        res.json(this.statisticsProvider.getBotHealth());
      } catch (error: any) {
        logger.error('Error getting bot health:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.get('/api/initialization-status', (req: Request, res: Response) => {
      try {
        const status = this.getInitializationStatus();
        res.setHeader('Content-Type', 'application/json');
        res.json(status);
      } catch (error: any) {
        logger.error('Error getting initialization status:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.get('/api/statistics', async (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available. Please check if the watcher is running and token is configured.' });
          return;
        }

        const streamWatcher = this.statisticsProvider as StreamWatcher & {
          syncStatisticsStatusesBeforeRead?: (force?: boolean) => Promise<void>;
        };
        if (typeof streamWatcher.syncStatisticsStatusesBeforeRead === 'function') {
          void streamWatcher.syncStatisticsStatusesBeforeRead();
        }

        // Поддерживаем параметр includeOffline для включения офлайн стримеров
        const includeOffline = req.query.includeOffline === 'true';
        const statistics = this.statisticsProvider.getStatistics(includeOffline);
        
        // Обогащаем статистику данными из базы данных (время последнего запуска/завершения стрима)
        const databaseStorage = streamWatcher.getDatabaseStorage?.();
        
        if (databaseStorage && databaseStorage.isReady()) {
          const streamCountsByWindow = databaseStorage.getStreamCountsByUsernameByWindows();
          const enrichedStatistics = statistics.map((stat: any) => {
            const dbStats = databaseStorage.getStreamerStats(stat.streamerName);
            const windows =
              streamCountsByWindow.get(String(stat.streamerName).toLowerCase()) ?? {
                d7: 0,
                d14: 0,
                d30: 0,
                d60: 0,
              };
            const streamCounts = {
              7: windows.d7,
              14: windows.d14,
              30: windows.d30,
              60: windows.d60,
            };
            const streamsLast30Days = windows.d30;
            if (dbStats) {
              return {
                ...stat,
                lastStreamStart: dbStats.lastStreamStart,
                lastStreamEnd: dbStats.lastStreamEnd,
                lastStreamDurationMs: dbStats.lastStreamDurationMs,
                streamCounts,
                streamsLast30Days,
              };
            }
            return {
              ...stat,
              streamCounts,
              streamsLast30Days,
            };
          });
          res.json(enrichedStatistics);
        } else {
          res.json(statistics);
        }
      } catch (error: any) {
        logger.error('Error getting statistics:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.get('/api/streamers', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamers = this.statisticsProvider.getStreamersInfo();
        res.json(streamers);
      } catch (error: any) {
        logger.error('Error getting streamers:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.post('/api/streamers', async (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const { username } = req.body;
        if (!username || typeof username !== 'string') {
          res.status(400).json({ error: 'Username is required' });
          return;
        }

        if (this.statisticsProvider.addStreamer) {
          const result = await this.statisticsProvider.addStreamer(username);
          if (result.success) {
            res.json(result);
          } else {
            res.status(400).json(result);
          }
        } else {
          res.status(501).json({ error: 'Add streamer functionality not available' });
        }
      } catch (error: any) {
        logger.error('Error adding streamer:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.delete('/api/streamers/:username', async (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const { username } = req.params;
        if (!username) {
          res.status(400).json({ error: 'Username is required' });
          return;
        }

        if (this.statisticsProvider.removeStreamer) {
          const result = await this.statisticsProvider.removeStreamer(username);
          if (result.success) {
            res.json(result);
          } else {
            res.status(400).json(result);
          }
        } else {
          res.status(501).json({ error: 'Remove streamer functionality not available' });
        }
      } catch (error: any) {
        logger.error('Error removing streamer:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.get('/api/overall', async (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ 
            error: 'Statistics provider not available',
            message: 'Watcher is not running. Please check token configuration.'
          });
          return;
        }

        const streamWatcher = this.statisticsProvider as StreamWatcher & {
          syncStatisticsStatusesBeforeRead?: (force?: boolean) => Promise<void>;
        };
        if (typeof streamWatcher.syncStatisticsStatusesBeforeRead === 'function') {
          void streamWatcher.syncStatisticsStatusesBeforeRead();
        }

        const stats = this.statisticsProvider.getOverallStats();
        logger.verbose(
          `GET /api/overall: activeWatches=${stats.activeWatches} totalPoints=${stats.totalPointsEarned} streamers=${stats.streamersCount} lastOnline=${stats.lastOnlineStreamer ?? '—'} agoMs=${stats.lastActivity}`
        );
        res.json(stats);
      } catch (error: any) {
        logger.error('Error getting overall stats:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.get('/api/events', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;
        const events = this.statisticsProvider.getEventsHistory();
        
        // Применяем offset и limit для пагинации
        const paginatedEvents = events.slice(offset, offset + limit);
        
        res.json({
          events: paginatedEvents,
          total: events.length,
          limit,
          offset,
          hasMore: offset + limit < events.length
        });
      } catch (error: any) {
        logger.error('Error getting events:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.get('/api/points-history', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const limit = parseInt(req.query.limit as string) || 200;
        const history = this.statisticsProvider.getPointsHistory();
        const limitedHistory = history.slice(0, limit);
        
        res.json(limitedHistory);
      } catch (error: any) {
        logger.error('Error getting points history:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для сохраненных сессий просмотра
    this.app.get('/api/sessions', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        // Получаем StatisticsStorage из провайдера
        const streamWatcher = this.statisticsProvider as any;
        const statisticsStorage = streamWatcher.getStatisticsStorage?.();
        
        if (!statisticsStorage) {
          res.status(503).json({ error: 'Statistics storage not available' });
          return;
        }

        const streamerName = req.query.streamer as string | undefined;
        const limit = parseInt(req.query.limit as string) || undefined;
        const sessions = statisticsStorage.getSessions(streamerName, limit);
        
        res.json(sessions);
      } catch (error: any) {
        logger.error('Error getting sessions:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для критических уведомлений
    this.app.get('/api/critical-notifications', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const notifications = this.statisticsProvider.getCriticalNotifications();
        res.json(notifications);
      } catch (error: any) {
        logger.error('Error getting critical notifications:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для агрегированной статистики
    this.app.get('/api/aggregated-stats', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamWatcher = this.statisticsProvider as any;
        const statisticsStorage = streamWatcher.getStatisticsStorage?.();
        
        if (!statisticsStorage) {
          res.status(503).json({ error: 'Statistics storage not available' });
          return;
        }

        const period = (req.query.period as 'day' | 'week' | 'month') || 'day';
        const startDate = req.query.startDate ? parseInt(req.query.startDate as string) : undefined;
        const stats = statisticsStorage.getAggregatedStatistics(period, startDate);
        
        res.json(stats);
      } catch (error: any) {
        logger.error('Error getting aggregated stats:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API настроек minute-watched (режим и интервал между каналами)
    this.app.get('/api/watch-settings', (req: Request, res: Response) => {
      try {
        res.json(readWatchSettingsForApi(this.statisticsProvider));
      } catch (error: any) {
        logger.error('Error getting watch settings:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.post('/api/watch-settings', (req: Request, res: Response) => {
      try {
        const body = req.body ?? {};
        const result = applyWatchSettingsFromApi(this.statisticsProvider, {
          cycleIntervalSec: body.cycleIntervalSec,
        });
        res.json(result);
      } catch (error: any) {
        logger.error('Error applying watch settings:', error);
        res.status(400).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.get('/api/app-settings', (_req: Request, res: Response) => {
      try {
        res.json(readAppSettingsApi());
      } catch (error: any) {
        logger.error('Error getting app settings:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.post('/api/app-settings', async (req: Request, res: Response) => {
      try {
        const body = req.body ?? {};
        const result = await applyAppSettingsApi({
          settings: body.settings,
          token: body.token,
        });
        res.json(result);
      } catch (error: any) {
        logger.error('Error applying app settings:', error);
        res.status(400).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.get('/api/integrity/capture/status', (_req: Request, res: Response) => {
      try {
        res.json(getIntegrityCaptureStatus(this.port));
      } catch (error: any) {
        logger.error('Error getting integrity capture status:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.post('/api/integrity/capture', (req: Request, res: Response) => {
      try {
        const streamWatcher = this.statisticsProvider as StreamWatcher | null;
        const result = postIntegrityCapture(req.body ?? {}, streamWatcher);
        const status = result.applied ? 200 : result.skipped ? 200 : 400;
        res.status(status).json(result);
      } catch (error: any) {
        logger.error('Error applying integrity capture:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    this.app.post('/api/integrity/capture/request', (_req: Request, res: Response) => {
      try {
        const result = postIntegrityCaptureRequest();
        res.status(result.ok ? 200 : 400).json(result);
      } catch (error: any) {
        logger.error('Error requesting integrity capture:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для информации о токене
    this.app.get('/api/token-info', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamWatcher = this.statisticsProvider as any;
        const tokenInfo = streamWatcher.getTokenInfo?.();
        
        if (!tokenInfo) {
          res.status(503).json({ error: 'Token info not available' });
          return;
        }

        res.json(tokenInfo);
      } catch (error: any) {
        logger.error('Error getting token info:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для информации о статусе базы данных
    this.app.get('/api/database-status', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamWatcher = this.statisticsProvider as any;
        const databaseStorage = streamWatcher.getDatabaseStorage?.();
        
        if (!databaseStorage) {
          res.json({
            available: false,
            ready: false,
            reason: 'Database storage not initialized',
            dbPath: null
          });
          return;
        }

        const isReady = databaseStorage.isReady();
        const dbPath = databaseStorage.getDbPath();
        const errorReason = databaseStorage.getErrorReason?.();

        res.json({
          available: true,
          ready: isReady,
          reason: isReady ? 'Database is ready' : (errorReason || 'sql.js not available'),
          dbPath: isReady ? dbPath : null,
          error: errorReason || null
        });
      } catch (error: any) {
        logger.error('Error getting database status:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для заполнения тестовыми данными
    this.app.post('/api/test/fill-data', async (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamWatcher = this.statisticsProvider as any;
        if (!streamWatcher.fillTestData) {
          res.status(501).json({ error: 'Fill test data functionality not available' });
          return;
        }

        const result = await streamWatcher.fillTestData();
        res.json({
          success: true,
          eventsCount: result.eventsCount,
          streamersCount: result.streamersCount,
          message: `Generated ${result.eventsCount} events and ${result.streamersCount} streamers`
        });
      } catch (error: any) {
        logger.error('Error filling test data:', error);
        res.status(500).json({ 
          success: false,
          error: error.message || 'Unknown error' 
        });
      }
    });

    // API для пометки токена как невалидного (для тестирования)
    this.app.post('/api/token/mark-invalid', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamWatcher = this.statisticsProvider as any;
        if (streamWatcher.markTokenAsInvalid) {
          streamWatcher.markTokenAsInvalid();
          res.json({ success: true, message: 'Token marked as invalid for testing' });
        } else {
          res.status(501).json({ error: 'Mark token as invalid functionality not available' });
        }
      } catch (error: any) {
        logger.error('Error marking token as invalid:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для закрытия критических уведомлений
    this.app.post('/api/critical-notifications/:id/dismiss', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const notificationId = req.params.id;
        if (this.statisticsProvider.dismissCriticalNotification) {
          this.statisticsProvider.dismissCriticalNotification(notificationId);
          res.json({ success: true });
        } else {
          res.status(501).json({ error: 'Dismiss functionality not available' });
        }
      } catch (error: any) {
        logger.error('Error dismissing notification:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для экспорта в CSV
    this.app.get('/api/export/csv', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamWatcher = this.statisticsProvider as any;
        const statisticsStorage = streamWatcher.getStatisticsStorage?.();
        
        if (!statisticsStorage) {
          res.status(503).json({ error: 'Statistics storage not available' });
          return;
        }

        const streamerName = req.query.streamer as string | undefined;
        const filePath = statisticsStorage.exportToCSV(undefined, streamerName);
        
        // Проверяем, что файл существует
        if (!fs.existsSync(filePath)) {
          res.status(404).json({ error: 'Export file not found' });
          return;
        }

        const fileName = path.basename(filePath);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
        
        fileStream.on('error', (err: any) => {
          logger.error('Error streaming CSV file:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to stream CSV file' });
          }
        });
      } catch (error: any) {
        logger.error('Error exporting to CSV:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: error.message || 'Unknown error' });
        }
      }
    });

    // API для получения статистики стримера из базы данных
    this.app.get('/api/database/streamer-stats', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamWatcher = this.statisticsProvider as any;
        const databaseStorage = streamWatcher.getDatabaseStorage?.();
        
        if (!databaseStorage || !databaseStorage.isReady()) {
          res.status(503).json({ error: 'Database storage not available' });
          return;
        }

        const username = req.query.username as string | undefined;
        if (!username) {
          res.status(400).json({ error: 'Username parameter is required' });
          return;
        }

        const stats = databaseStorage.getStreamerStats(username);
        if (!stats) {
          res.status(404).json({ error: 'Streamer not found' });
          return;
        }

        res.json(stats);
      } catch (error: any) {
        logger.error('Error getting streamer stats from database:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для получения баллов за день
    this.app.get('/api/database/daily-points', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamWatcher = this.statisticsProvider as any;
        const databaseStorage = streamWatcher.getDatabaseStorage?.();
        
        if (!databaseStorage || !databaseStorage.isReady()) {
          res.status(503).json({ error: 'Database storage not available' });
          return;
        }

        const username = req.query.username as string | undefined;
        const date = req.query.date as string | undefined;

        if (!username || !date) {
          res.status(400).json({ error: 'Username and date parameters are required (format: YYYY-MM-DD)' });
          return;
        }

        const points = databaseStorage.getDailyPoints(username, date);
        res.json({ username, date, pointsEarned: points });
      } catch (error: any) {
        logger.error('Error getting daily points from database:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для получения баллов за период
    this.app.get('/api/database/daily-points-range', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamWatcher = this.statisticsProvider as any;
        const databaseStorage = streamWatcher.getDatabaseStorage?.();
        
        if (!databaseStorage || !databaseStorage.isReady()) {
          res.status(503).json({ error: 'Database storage not available' });
          return;
        }

        const username = req.query.username as string | undefined;
        const startDate = req.query.startDate as string | undefined;
        const endDate = req.query.endDate as string | undefined;

        if (!username || !startDate || !endDate) {
          res.status(400).json({ error: 'Username, startDate and endDate parameters are required (format: YYYY-MM-DD)' });
          return;
        }

        const points = databaseStorage.getDailyPointsRange(username, startDate, endDate);
        res.json(points);
      } catch (error: any) {
        logger.error('Error getting daily points range from database:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для получения всех стримеров из базы данных
    this.app.get('/api/database/all-streamers', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamWatcher = this.statisticsProvider as any;
        const databaseStorage = streamWatcher.getDatabaseStorage?.();
        
        if (!databaseStorage || !databaseStorage.isReady()) {
          res.status(503).json({ error: 'Database storage not available' });
          return;
        }

        const stats = databaseStorage.getAllStreamerStats();
        res.json(stats);
      } catch (error: any) {
        logger.error('Error getting all streamers from database:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для получения суммарных баллов за день
    this.app.get('/api/database/total-daily-points', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamWatcher = this.statisticsProvider as any;
        const databaseStorage = streamWatcher.getDatabaseStorage?.();
        
        if (!databaseStorage || !databaseStorage.isReady()) {
          res.status(503).json({ error: 'Database storage not available' });
          return;
        }

        const date = req.query.date as string | undefined;
        if (!date) {
          res.status(400).json({ error: 'Date parameter is required (format: YYYY-MM-DD)' });
          return;
        }

        const totalPoints = databaseStorage.getTotalDailyPoints(date);
        res.json({ date, totalPoints });
      } catch (error: any) {
        logger.error('Error getting total daily points from database:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

    // API для экспорта в JSON
    this.app.get('/api/export/json', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const streamWatcher = this.statisticsProvider as any;
        const statisticsStorage = streamWatcher.getStatisticsStorage?.();
        
        if (!statisticsStorage) {
          res.status(503).json({ error: 'Statistics storage not available' });
          return;
        }

        const streamerName = req.query.streamer as string | undefined;
        const filePath = statisticsStorage.exportToJSON(undefined, streamerName);
        
        // Проверяем, что файл существует
        if (!fs.existsSync(filePath)) {
          res.status(404).json({ error: 'Export file not found' });
          return;
        }

        const fileName = path.basename(filePath);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
        
        fileStream.on('error', (err: any) => {
          logger.error('Error streaming JSON file:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to stream JSON file' });
          }
        });
      } catch (error: any) {
        logger.error('Error exporting to JSON:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: error.message || 'Unknown error' });
        }
      }
    });

    // Статические файлы (CSS, JS) из директории dashboard
    this.app.use(express.static(__dirname));

    // Dashboard страница
    this.app.get('/', (req: Request, res: Response) => {
      const dashboardPath = path.join(__dirname, 'dashboard.html');
      res.sendFile(dashboardPath, (err) => {
        if (err) {
          logger.error('Error sending dashboard:', err);
          res.status(500).send('Dashboard file not found');
        }
      });
    });

    // Статические файлы из папки static (если есть)
    this.app.use('/static', express.static(path.join(__dirname, 'static')));
  }

  /**
   * Устанавливает провайдер статистики
   * @param provider Провайдер статистики
   */
  setStatisticsProvider(provider: StatisticsProvider): void {
    this.statisticsProvider = provider;
  }

  /**
   * Получает статус инициализации приложения
   */
  getInitializationStatus(): {
    isInitialized: boolean;
    currentAction: string;
    progress: number;
    needsToken?: boolean;
  } {
    if (!this.statisticsProvider) {
      if (this.isRunning()) {
        return {
          isInitialized: true,
          currentAction: 'Укажите токен в dashboard → «Конфиг бота»',
          progress: 100,
          needsToken: true,
        };
      }
      return {
        isInitialized: false,
        currentAction: 'Waiting for application to start...',
        progress: 0,
      };
    }

    const streamWatcher = this.statisticsProvider as any;
    if (streamWatcher && typeof streamWatcher.getInitializationStatus === 'function') {
      const status = streamWatcher.getInitializationStatus();
      if (status && typeof status === 'object') {
        if (status.isInitialized || status.progress >= 100) {
          return {
            isInitialized: true,
            currentAction: status.currentAction || 'Application ready',
            progress: Math.max(status.progress || 0, 100),
          };
        }
        return status;
      }
    }

    // Watcher уже отдаёт статистику — считаем готовым (дашборд не зависает на 0%)
    try {
      const stats = this.statisticsProvider.getStatistics(true);
      if (Array.isArray(stats) && stats.length > 0) {
        // Если можем получить статистику, значит приложение готово
        return {
          isInitialized: true,
          currentAction: 'Ready',
          progress: 100
        };
      }
    } catch (e) {
      // Игнорируем ошибки
    }

    return {
      isInitialized: false,
      currentAction: 'Initializing application...',
      progress: 0,
    };
  }

  /**
   * Проверяет, слушает ли веб-сервер порт
   */
  isRunning(): boolean {
    return this.server != null && this.server.listening === true;
  }

  /**
   * Освобождает ссылку на сервер после неудачного listen
   */
  private cleanupFailedStart(): void {
    if (!this.server) {
      return;
    }
    this.server.removeAllListeners();
    try {
      this.server.close();
    } catch {
      // Сервер мог не успеть перейти в состояние listening
    }
    this.server = null;
  }

  /**
   * Запускает веб-сервер (Promise отклоняется при EADDRINUSE и других ошибках listen)
   */
  async start(): Promise<void> {
    if (this.isRunning()) {
      logger.warn('Web server is already running');
      return;
    }

    const scheme = getWebServerScheme();
    const httpsEnv = process.env.WEB_SERVER_HTTPS ?? '(not set)';
    console.log(`[WebServer] WEB_SERVER_HTTPS=${httpsEnv} → ${scheme.toUpperCase()} on port ${this.port}`);

    if (isWebServerHttpsEnabled()) {
      const { certPath, keyPath } = resolveHttpsCredentialPaths();
      logger.info(`🔐  WEB_SERVER_HTTPS=${httpsEnv} — дашборд только по HTTPS`);
      logger.verbose(`    cert: ${certPath}`);
      logger.verbose(`    key:  ${keyPath}`);
    } else if (httpsEnv !== '(not set)' && httpsEnv.trim() !== '') {
      logger.warn(`⚠️  WEB_SERVER_HTTPS=${httpsEnv} не распознан — используется HTTP`);
      console.log('[WebServer] ⚠️  HTTPS не включён — открывайте http://, не https://');
    }

    const logListening = () => {
      logger.info(`Web server started on port ${this.port} (${scheme.toUpperCase()})`);
      console.log(`[WebServer] ✅  Listening ${scheme}://0.0.0.0:${this.port}`);
      logger.verbose(`Dashboard: ${scheme}://0.0.0.0:${this.port}`);
      logger.verbose(`API: ${scheme}://0.0.0.0:${this.port}/api`);
      if (isWebServerHttpsEnabled()) {
        logger.verbose('   Откройте https://<IP>:3001 (не http). Подтвердите самоподписанный сертификат.');
      } else {
        logger.warn('   HTTPS выключен: https:// в браузере даст ERR_SSL_PROTOCOL_ERROR');
      }
    };

    const logPortInUse = () => {
      logger.error(`Port ${this.port} is already in use — остановите старый процесс: fuser -k ${this.port}/tcp`);
      console.log(`[WebServer] ❌  Порт ${this.port} занят. Termux: fuser -k ${this.port}/tcp`);
    };

    return new Promise<void>((resolve, reject) => {
      const onListening = () => {
        logListening();
        resolve();
      };

      const onError = (error: NodeJS.ErrnoException) => {
        this.cleanupFailedStart();
        if (error.code === 'EADDRINUSE') {
          logPortInUse();
        } else {
          logger.error('Web server error:', error);
        }
        reject(error);
      };

      const bindServer = () => {
        this.server!.once('error', onError);
        this.server!.once('listening', onListening);
        this.server!.listen(this.port, '0.0.0.0');
      };

      try {
        if (isWebServerHttpsEnabled()) {
          ensureHttpsCredentials()
            .then(({ cert, key }) => {
              this.server = https.createServer({ cert, key }, this.app);
              bindServer();
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Failed to start web server with HTTPS: ${message}`);
              console.log(`[WebServer] ❌  HTTPS startup failed: ${message}`);
              reject(error instanceof Error ? error : new Error(message));
            });
        } else {
          this.server = http.createServer(this.app);
          bindServer();
        }
      } catch (error: unknown) {
        this.cleanupFailedStart();
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to start web server: ${message}`);
        reject(error instanceof Error ? error : new Error(message));
      }
    });
  }

  /**
   * Запускает веб-сервер с повторными попытками при занятом порте
   * @param options Максимум попыток и пауза между ними (переопределяют env)
   * @returns true если сервер успешно запущен
   */
  async startWithRetry(options?: { maxAttempts?: number; retryDelayMs?: number }): Promise<boolean> {
    const maxAttempts = options?.maxAttempts
      ?? parseInt(process.env.WEB_SERVER_START_MAX_ATTEMPTS || '12', 10);
    const retryDelayMs = options?.retryDelayMs
      ?? parseInt(process.env.WEB_SERVER_START_RETRY_DELAY_MS || '5000', 10);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.start();
        return true;
      } catch (error: unknown) {
        const err = error as NodeJS.ErrnoException;
        const isPortInUse = err.code === 'EADDRINUSE';
        const isLastAttempt = attempt >= maxAttempts;

        if (!isPortInUse) {
          const message = err.message || String(error);
          logger.error(`❌  Web server failed to start: ${message}`);
          return false;
        }

        if (isLastAttempt) {
          logger.error(
            `❌  Web server: port ${this.port} still in use after ${maxAttempts} attempts`
          );
          return false;
        }

        logger.warn(
          `⚠️  Port ${this.port} busy (attempt ${attempt}/${maxAttempts}), retry in ${retryDelayMs / 1000}s...`
        );
        logger.verbose(`   Подсказка: fuser -k ${this.port}/tcp`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    return false;
  }

  /**
   * Повторяет запуск до успеха (для режима только dashboard без watcher)
   */
  async startUntilSuccess(): Promise<void> {
    const backgroundDelayMs = parseInt(
      process.env.WEB_SERVER_BACKGROUND_RETRY_DELAY_MS || '30000',
      10
    );
    let cycle = 0;

    while (true) {
      cycle++;
      const started = await this.startWithRetry();
      if (started) {
        return;
      }
      logger.warn(
        `⚠️  Dashboard недоступен — повторный цикл запуска (#${cycle}) через ${backgroundDelayMs / 1000}s`
      );
      await new Promise((resolve) => setTimeout(resolve, backgroundDelayMs));
    }
  }

  /**
   * Останавливает веб-сервер
   */
  stop(): void {
    if (this.server) {
      this.server.close(() => {
        logger.info('Web server stopped');
      });
      this.server = null;
    }
  }
}

