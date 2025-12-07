/**
 * HTTP сервер для health checks и мониторинга состояния приложения
 */

import * as http from 'http';
import { logger } from '../modes/api/logger';

/**
 * Статус компонента
 */
export enum ComponentStatus {
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
  UNKNOWN = 'unknown'
}

/**
 * Информация о состоянии компонента
 */
export interface ComponentHealth {
  status: ComponentStatus;
  message?: string;
  lastCheck?: number;
  details?: Record<string, any>;
}

/**
 * Полный отчет о состоянии приложения
 */
export interface HealthReport {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: number;
  uptime: number;
  mode: 'api' | 'unknown';
  components: {
    websocket?: ComponentHealth;
    api?: ComponentHealth;
    token?: ComponentHealth;
    watching?: ComponentHealth;
  };
  metrics?: {
    activeWatches?: number;
    totalPointsEarned?: number;
    lastActivity?: number;
  };
}

/**
 * Провайдеры проверки состояния компонентов
 */
export interface HealthCheckProviders {
  checkWebSocket?: () => Promise<ComponentHealth>;
  checkAPI?: () => Promise<ComponentHealth>;
  checkToken?: () => Promise<ComponentHealth>;
  checkWatching?: () => Promise<ComponentHealth>;
  getMetrics?: () => Promise<Record<string, any>>;
  getMode?: () => 'api' | 'unknown';
}

/**
 * HTTP сервер для health checks
 */
export class HealthCheckServer {
  private server: http.Server | null = null;
  private port: number;
  private startTime: number;
  private providers: HealthCheckProviders;

  /**
   * Создает экземпляр сервера health checks
   * @param port Порт для HTTP сервера (по умолчанию 3000)
   * @param providers Провайдеры для проверки состояния компонентов
   */
  constructor(port: number = 3000, providers: HealthCheckProviders = {}) {
    this.port = port;
    this.startTime = Date.now();
    this.providers = providers;
  }

  /**
   * Запускает HTTP сервер
   */
  start(): void {
    if (this.server) {
      logger.warn('⚠️  Health check server is already running');
      return;
    }

    this.server = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Health check endpoint
      if (req.url === '/health' || req.url === '/health/') {
        try {
          const report = await this.getHealthReport();
          const statusCode = report.status === 'healthy' ? 200 : report.status === 'degraded' ? 200 : 503;
          
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(report, null, 2));
        } catch (error: any) {
          logger.error('❌  Error generating health report:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'unhealthy',
            error: error.message || 'Unknown error',
            timestamp: Date.now()
          }));
        }
      } else {
        // 404 для других путей
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    this.server.listen(this.port, () => {
      logger.info(`✅  Health check server started on port ${this.port}`);
      logger.verbose(`   Health endpoint: http://localhost:${this.port}/health`);
    });

    this.server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`❌  Port ${this.port} is already in use`);
      } else {
        logger.error('❌  Health check server error:', error);
      }
    });
  }

  /**
   * Останавливает HTTP сервер
   */
  stop(): void {
    if (this.server) {
      this.server.close(() => {
        logger.info('🛑  Health check server stopped');
      });
      this.server = null;
    }
  }

  /**
   * Генерирует отчет о состоянии приложения
   */
  private async getHealthReport(): Promise<HealthReport> {
    const components: HealthReport['components'] = {};
    let overallStatus: 'healthy' | 'unhealthy' | 'degraded' = 'healthy';
    let hasUnhealthy = false;
    let hasDegraded = false;

    // Проверка WebSocket
    if (this.providers.checkWebSocket) {
      try {
        components.websocket = await this.providers.checkWebSocket();
        if (components.websocket.status === ComponentStatus.UNHEALTHY) {
          hasUnhealthy = true;
        } else if (components.websocket.status === ComponentStatus.UNKNOWN) {
          hasDegraded = true;
        }
      } catch (error: any) {
        components.websocket = {
          status: ComponentStatus.UNHEALTHY,
          message: error.message || 'Check failed',
          lastCheck: Date.now()
        };
        hasUnhealthy = true;
      }
    }

    // Проверка API
    if (this.providers.checkAPI) {
      try {
        components.api = await this.providers.checkAPI();
        if (components.api.status === ComponentStatus.UNHEALTHY) {
          hasUnhealthy = true;
        } else if (components.api.status === ComponentStatus.UNKNOWN) {
          hasDegraded = true;
        }
      } catch (error: any) {
        components.api = {
          status: ComponentStatus.UNHEALTHY,
          message: error.message || 'Check failed',
          lastCheck: Date.now()
        };
        hasUnhealthy = true;
      }
    }

    // Проверка токена
    if (this.providers.checkToken) {
      try {
        components.token = await this.providers.checkToken();
        if (components.token.status === ComponentStatus.UNHEALTHY) {
          hasUnhealthy = true;
        } else if (components.token.status === ComponentStatus.UNKNOWN) {
          hasDegraded = true;
        }
      } catch (error: any) {
        components.token = {
          status: ComponentStatus.UNHEALTHY,
          message: error.message || 'Check failed',
          lastCheck: Date.now()
        };
        hasUnhealthy = true;
      }
    }

    // Проверка активности просмотра
    if (this.providers.checkWatching) {
      try {
        components.watching = await this.providers.checkWatching();
        if (components.watching.status === ComponentStatus.UNHEALTHY) {
          hasUnhealthy = true;
        } else if (components.watching.status === ComponentStatus.UNKNOWN) {
          hasDegraded = true;
        }
      } catch (error: any) {
        components.watching = {
          status: ComponentStatus.UNHEALTHY,
          message: error.message || 'Check failed',
          lastCheck: Date.now()
        };
        hasUnhealthy = true;
      }
    }

    // Определение общего статуса
    if (hasUnhealthy) {
      overallStatus = 'unhealthy';
    } else if (hasDegraded) {
      overallStatus = 'degraded';
    }

    // Получение метрик
    let metrics: Record<string, any> | undefined;
    if (this.providers.getMetrics) {
      try {
        metrics = await this.providers.getMetrics();
      } catch (error: any) {
        logger.verbose(`⚠️  Error getting metrics: ${error.message || error}`);
      }
    }

    return {
      status: overallStatus,
      timestamp: Date.now(),
      uptime: Date.now() - this.startTime,
      mode: this.providers.getMode ? this.providers.getMode() : 'unknown',
      components,
      metrics
    };
  }
}

