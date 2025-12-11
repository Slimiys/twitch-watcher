/**
 * Веб-сервер для мониторинга и dashboard
 */

import express, { Express, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../modes/api/logger';

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
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
      }
      
      next();
    });

    // Парсинг JSON
    this.app.use(express.json());
  }

  /**
   * Настраивает маршруты
   */
  private setupRoutes(): void {
    // API маршруты
    this.app.get('/api/statistics', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available. Please check if the watcher is running and token is configured.' });
          return;
        }

        // Поддерживаем параметр includeOffline для включения офлайн стримеров
        const includeOffline = req.query.includeOffline === 'true';
        const statistics = this.statisticsProvider.getStatistics(includeOffline);
        res.json(statistics);
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

    this.app.get('/api/overall', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ 
            error: 'Statistics provider not available',
            message: 'Watcher is not running. Please check token configuration.'
          });
          return;
        }

        const stats = this.statisticsProvider.getOverallStats();
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
   * Запускает веб-сервер
   */
  start(): void {
    if (this.server) {
      logger.warn('Web server is already running');
      return;
    }

    this.server = this.app.listen(this.port, () => {
      logger.info(`Web server started on port ${this.port}`);
      logger.verbose(`Dashboard: http://localhost:${this.port}`);
      logger.verbose(`API: http://localhost:${this.port}/api`);
    });

    this.server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${this.port} is already in use`);
      } else {
        logger.error('Web server error:', error);
      }
    });
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

