/**
 * Веб-сервер для мониторинга и dashboard
 */

import express, { Express, Request, Response } from 'express';
import * as path from 'path';
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
   * Добавляет тестовое критическое уведомление
   */
  addTestCriticalNotification?(type: 'error' | 'warning'): void;
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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
          res.status(503).json({ error: 'Statistics provider not available' });
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

    this.app.get('/api/overall', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
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
        const events = this.statisticsProvider.getEventsHistory();
        const limitedEvents = events.slice(0, limit);
        
        res.json(limitedEvents);
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

    this.app.post('/api/critical-notifications/test', (req: Request, res: Response) => {
      try {
        if (!this.statisticsProvider) {
          res.status(503).json({ error: 'Statistics provider not available' });
          return;
        }

        const type = (req.body.type || 'error') as 'error' | 'warning';
        if (this.statisticsProvider.addTestCriticalNotification) {
          this.statisticsProvider.addTestCriticalNotification(type);
          res.json({ success: true, message: 'Test notification added' });
        } else {
          res.status(501).json({ error: 'Test notification functionality not available' });
        }
      } catch (error: any) {
        logger.error('Error creating test notification:', error);
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
    });

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

    // Статические файлы (CSS, JS)
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

