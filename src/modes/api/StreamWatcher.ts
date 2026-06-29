/**
 * Менеджер просмотра стримов в API-режиме
 */

import { TwitchAPI } from './TwitchAPI';
import { WebSocketManager, WebSocketEventHandler } from './WebSocketManager';
import { ClaimBonusResult, StreamerInfo, WatchStatistics } from './types';
import { BotHealthSnapshot, StreamerClaimHealth } from './botHealthTypes';
import { getAppVersionParts } from '../../appVersion';
import { allowApiIntegrityFallback, getManualIntegrityFromEnv, resolveIntegritySource } from './integrityConfig';
import { getLastIntegrityCaptureAt } from './integrityBrowserCapture';
import {
  deriveIntegrityBonusClaimStatus,
  resolveLastIntegrityUpdatedAt,
} from './integrityBonusClaimStatus';
import { getGqlContextHealthSnapshot } from './browserGqlContextCapture';
import { getIntegrityTokenDisplay } from './integrityTokenDisplay';
import { GraphQLClient } from './GraphQLClient';
import { formatElapsedTime, setSafeAsyncInterval, runSafeAsync, withTimeout } from './utils';
import { logger } from './logger';
import dayjs from 'dayjs';
import { HealthCheckServer, ComponentStatus, ComponentHealth, HealthCheckProviders } from '../../health';
import { GQL_URL, CLIENT_ID } from './constants';
import { WebServer, StatisticsProvider } from '../../web';
import { TokenManager, TokenManagerConfig } from './TokenManager';
import { StatisticsStorage } from './StatisticsStorage';
import { DatabaseStorage, buildStreamSessionKey } from './DatabaseStorage';
import {
  applyBriefOfflineResume,
  beginTentativeOfflineState,
  canResumeFromBriefOffline,
  finalizeOfflineState,
  getDisplayStreamStatus,
  getEffectiveWatchStartTime,
  getOfflineResumeGraceMs,
  isEffectivelyOnline,
  isWithinOfflineResumeGrace,
  shouldFinalizeOffline,
} from './streamOnlineGrace';
import { publishDashboardHubEvent } from './dashboardEventHub';
import { loadStatisticsConfig } from './configLoader';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from '../../types';
import { isNetworkError } from './errorUtils';
import { ClaimIdBlocklist } from './claimIdBlocklist';
import {
  isTransientNetworkErrorCode,
  shouldAutoExitOnInvalidToken,
  shouldAutoExitOnUnhealthy,
} from './runtimeEnv';
import {
  getWatchCycleIntervalMs,
  WatchSettingsSnapshot,
  applyWatchCycleIntervalOverride,
} from './watchSettings';
import { logFatalExit } from '../../processGuards';

/**
 * Менеджер просмотра стримов
 */
export class StreamWatcher {
  private twitchAPI: TwitchAPI;
  private wsManager: WebSocketManager | null = null;
  private streamers: Map<string, StreamerInfo> = new Map();
  private priorityChannels: string[];
  private isRunning = false;
  private statsInterval: NodeJS.Timeout | null = null;
  private statusCheckInterval: NodeJS.Timeout | null = null;
  private wsHealthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckMonitorInterval: NodeJS.Timeout | null = null;
  private authToken: string;
  private userAgent: string;
  private validatedUserId: string | null = null;
  private maxSimultaneousChannels: number;
  private healthCheckServer: HealthCheckServer | null = null;
  private webServer: WebServer | null = null;
  private webServerRetryTimer: NodeJS.Timeout | null = null;
  private eventsHistory: Array<{
    timestamp: number;
    type: string;
    streamer: string;
    message: string;
  }> = [];
  private maxEventsHistory: number = 1000;
  private pointsHistory: Array<{
    timestamp: number;
    streamer: string;
    points: number;
    totalPoints: number;
  }> = [];
  private maxPointsHistory: number = 1000;
  private tokenManager: TokenManager | null = null;
  private criticalNotifications: Array<{
    id: string;
    type: 'error' | 'warning';
    title: string;
    message: string;
    timestamp: number;
  }> = [];
  private maxCriticalNotifications: number = 10;
  private statisticsStorage: StatisticsStorage | null = null;
  private databaseStorage: DatabaseStorage | null = null;
  private activeSessions: Map<string, string> = new Map(); // Map<streamerName, sessionId>
  /** Активные ключи сессий стримов для учёта категорий (username -> sessionKey) */
  private activeStreamSessionKeys: Map<string, string> = new Map();
  private processedRaids: Map<string, number> = new Map(); // Map<raidId, timestamp> - отслеживание обработанных рейдов
  private raidCooldownMs: number = 30000; // 30 секунд между попытками присоединения к рейду
  private claimCheckInterval: NodeJS.Timeout | null = null;
  private graphqlClient: GraphQLClient | null = null;
  private recentClaimAttempts = new Map<string, number>();
  private claimIdBlocklist = new ClaimIdBlocklist(
    parseInt(process.env.CLAIM_FAILED_BLOCK_MS || '86400000', 10)
  );
  /** Сколько последних claim показывать в /api/bot-health */
  private static readonly CLAIM_HEALTH_RECENT_MAX = 5;
  /** Последние попытки claim (для dashboard), не более CLAIM_HEALTH_RECENT_MAX */
  private claimHealthRecent: StreamerClaimHealth[] = [];
  /** Последняя ошибка integrity при claim */
  private lastIntegrityFailure: { timestamp: number; streamer: string } | null = null;
  /** Время последней активности бота (minute-watched, баллы) */
  private lastGlobalActivityAt = 0;
  /** Последний переход стримера в онлайн (для Last Activity на dashboard) */
  private lastOnlineTransition: { username: string; at: number } | null = null;
  private watchPrepIntervalMs = parseInt(process.env.WATCH_PREP_INTERVAL_MS || '300000', 10);
  private watchOpTimeoutMs = parseInt(process.env.WATCH_OPERATION_TIMEOUT_MS || '10000', 10);
  private watchCycleIntervalMs = 60_000;
  private sequentialWatchLoopActive = false;
  private sequentialRotationIndex = 0;
  private lastSequentialStreamer: string | null = null;
  private channelWatchInProgress = new Set<string>();
  private claimCheckIntervalMs = parseInt(process.env.CLAIM_CHECK_INTERVAL_MS || '120000', 10);
  private claimAttemptCooldownMs = 60000;
  private configPath: string = './config.json'; // Путь к файлу конфигурации
  // Персистентное состояние баллов между рестартами
  private pointsStatePath: string | null = null;
  // Статус инициализации
  private initializationStatus: {
    isInitialized: boolean;
    currentAction: string;
    progress: number; // 0-100
  } = {
    isInitialized: false,
    currentAction: 'Starting application...',
    progress: 0
  };
  private pointsState: Record<string, {
    channelPoints: number;
    initialChannelPoints: number | null;
    lastChannelPoints: number | null;
    streamPointsEarned: number;
    isOnline: boolean;
    startTime: number;
    broadcastId: string | null;
    updatedAt: number;
  }> = {};
  private lastPointsStateSave = 0;
  private pointsStateSaveIntervalMs = 10000;

  /**
   * Создает экземпляр менеджера просмотра
   * @param authToken Токен авторизации
   * @param userAgent User-Agent
   * @param priorityChannels Список приоритетных каналов
   * @param maxSimultaneousChannels Максимальное количество одновременно просматриваемых каналов (по умолчанию 2)
   * @param sharedWebServer Уже запущенный dashboard (режим без токена при старте)
   */
  constructor(
    authToken: string,
    userAgent: string,
    priorityChannels: string[],
    maxSimultaneousChannels?: number,
    sharedWebServer?: WebServer
  ) {
    this.authToken = authToken;
    this.userAgent = userAgent;
    this.priorityChannels = priorityChannels;
    if (sharedWebServer) {
      this.webServer = sharedWebServer;
    }
    this.twitchAPI = new TwitchAPI(authToken, userAgent);
    // Парсим из переменной окружения или используем переданное значение, или значение по умолчанию
    this.maxSimultaneousChannels = maxSimultaneousChannels ?? 
      (process.env.MAX_SIMULTANEOUS_CHANNELS ? parseInt(process.env.MAX_SIMULTANEOUS_CHANNELS, 10) : 2);
    
    // Валидация: минимум 1, максимум 10 (разумное ограничение)
    if (this.maxSimultaneousChannels < 1) {
      logger.warn(`⚠️  MAX_SIMULTANEOUS_CHANNELS меньше 1, используем значение по умолчанию: 2`);
      this.maxSimultaneousChannels = 2;
    } else if (this.maxSimultaneousChannels > 10) {
      logger.warn(`⚠️  MAX_SIMULTANEOUS_CHANNELS больше 10, ограничиваем до 10`);
      this.maxSimultaneousChannels = 10;
    }

    this.syncWatchConfigFromSettings();
    logger.verbose(`📊  Max simultaneous channels: ${this.maxSimultaneousChannels}`);
    logger.verbose(`📊  Watch rotation: pause ${Math.round(this.watchCycleIntervalMs / 1000)}s between channels`);
    
    // Инициализируем TokenManager для отслеживания истечения токена
    try {
      const tokenManagerConfig: TokenManagerConfig = {
        checkIntervalMs: process.env.TOKEN_CHECK_INTERVAL_MS 
          ? parseInt(process.env.TOKEN_CHECK_INTERVAL_MS, 10) 
          : 5 * 60 * 1000, // 5 минут по умолчанию
        warningThresholdMinutes: process.env.TOKEN_WARNING_THRESHOLD_MINUTES
          ? parseInt(process.env.TOKEN_WARNING_THRESHOLD_MINUTES, 10)
          : 60, // 60 минут по умолчанию
        enableNotifications: process.env.TOKEN_NOTIFICATIONS_ENABLED !== 'false',
      };

      this.tokenManager = new TokenManager(
        this.twitchAPI,
        tokenManagerConfig,
        {
          onTokenExpiringSoon: (expiresAt, minutesRemaining) => {
            // Не добавляем предупреждения - только критические уведомления
            logger.verbose(`ℹ️  Token will expire in ${minutesRemaining} minutes`);
          },
          onTokenExpired: () => {
            logger.error('❌  Token has expired! Application may stop working.');
            this.addCriticalNotification(
              'error',
              'Token Expired',
              'Your Twitch token has expired. Please update it in dashboard → «Конфиг бота» or config.json.'
            );
            this.addEvent('token-expired', 'system', 'Token has expired - please update it');
          },
          onTokenInvalid: () => {
            logger.error('❌  Token is invalid! Application may stop working.');
            this.addCriticalNotification(
              'error',
              'Token Invalid',
              'Your Twitch token is invalid. Please update it in dashboard → «Конфиг бота» or config.json.'
            );
            this.addEvent('token-invalid', 'system', 'Token is invalid - please update it');
            
            // Если включено автоматическое завершение при невалидном токене, завершаем процесс
            if (shouldAutoExitOnInvalidToken()) {
              logger.warn('⚠️  Auto-exit on invalid token is enabled. Shutting down in 2 seconds...');
              setTimeout(() => {
                logFatalExit('TokenManager', 'Shutting down due to invalid token');
                logger.error('🛑  Shutting down due to invalid token');
                this.stop();
                process.exit(1);
              }, 2000);
            } else {
              logger.warn(
                '⚠️  Токен невалиден — процесс продолжает работу (AUTO_EXIT_ON_INVALID_TOKEN не включён)'
              );
            }
          },
        }
      );
      logger.verbose(`🔐  TokenManager initialized`);
    } catch (error: any) {
      logger.warn(`⚠️  Failed to initialize TokenManager: ${error.message || error}`);
    }

    // Инициализируем модуль сохранения статистики
    try {
      const statsConfig = loadStatisticsConfig();
      this.statisticsStorage = new StatisticsStorage(statsConfig);
      this.pointsStatePath = path.join(statsConfig.storagePath, 'current-points.json');
      this.pointsState = this.loadPointsState();
      logger.verbose(`📊  Statistics storage initialized`);
    } catch (error: any) {
      logger.warn(`⚠️  Failed to initialize statistics storage: ${error.message || error}`);
    }

    // Инициализируем модуль базы данных (опционально, может не работать на некоторых платформах)
    try {
      const statsConfig = loadStatisticsConfig();
      const dbPath = path.join(statsConfig.storagePath, 'database.db');
      this.databaseStorage = new DatabaseStorage({ dbPath });
      if (this.databaseStorage.isReady()) {
        logger.info(`💾  Database storage initialized successfully`);
      } else {
        const errorReason = this.databaseStorage.getErrorReason?.();
        if (errorReason) {
          logger.warn(`⚠️  Database storage not available: ${errorReason}`);
        } else {
          logger.verbose(`ℹ️  Database storage not available (sql.js not installed or not compatible)`);
        }
      }
    } catch (error: any) {
      logger.warn(`⚠️  Failed to initialize database storage: ${error.message || error}`);
      // Не критично - приложение может работать без БД
    }
  }

  /**
   * Запускает просмотр стримов
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    logger.info('🚀  Starting API mode watcher...');
    this.isRunning = true;
    this.updateInitializationStatus('Starting application...', 5);
    
    // Запускаем веб-сервер СРАЗУ, чтобы интерфейс был доступен во время инициализации
    this.updateInitializationStatus('Starting web server...', 10);
    await this.startWebServer();
    
    // Небольшая задержка, чтобы веб-сервер успел запуститься
    await new Promise(resolve => setTimeout(resolve, 100));

    await this.loadStreamCountsFromDatabase();

    // Инициализируем WebSocket
    try {
      logger.verbose('🔌  Initializing WebSocket connection...');
      this.updateInitializationStatus('Validating token...', 15);
      
      // Всегда получаем user ID из валидации токена (это правильный способ)
      // User ID нужен для WebSocket подписки на события текущего пользователя
      const envUserId = process.env.TWITCH_USER_ID?.trim() || '';
      logger.verbose('Getting user ID from token validation...');

      const startupValidateAttempts = parseInt(process.env.TWITCH_STARTUP_VALIDATE_ATTEMPTS || '3', 10);
      const startupValidateDelayMs = parseInt(process.env.TWITCH_STARTUP_VALIDATE_DELAY_MS || '5000', 10);
      let userId: string | null = null;
      let lastValidation = await this.twitchAPI.validateTokenWithInfo();

      for (let attempt = 1; attempt <= startupValidateAttempts; attempt++) {
        if (lastValidation.isValid && lastValidation.tokenInfo?.user_id) {
          userId = lastValidation.tokenInfo.user_id;
          break;
        }
        if (lastValidation.errorType !== 'network') {
          break;
        }
        if (attempt < startupValidateAttempts) {
          logger.warn(
            `⚠️  Сеть id.twitch.tv недоступна (попытка ${attempt}/${startupValidateAttempts}), повтор через ${startupValidateDelayMs / 1000} с...`
          );
          await new Promise((resolve) => setTimeout(resolve, startupValidateDelayMs));
          lastValidation = await this.twitchAPI.validateTokenWithInfo();
        }
      }

      if (!userId && lastValidation.errorType === 'network' && envUserId) {
        userId = envUserId;
        logger.warn(
          `⚠️  id.twitch.tv недоступен из контейнера — используем TWITCH_USER_ID=${envUserId} (задайте после curl validate на хосте)`
        );
      }

      if (!userId) {
        if (lastValidation.errorType === 'network') {
          logger.error('❌  Не удалось подключиться к Twitch (id.twitch.tv). Проверьте DNS или прокси.');
          logger.error('   Укажите TWITCH_USER_ID в «Конфиг бота» или настройте proxy при недоступности id.twitch.tv');
        } else {
          logger.error('❌  Token validation failed or user_id not found');
          logger.error(`   Token valid: ${lastValidation.isValid}`);
          logger.error(`   Token info: ${JSON.stringify(lastValidation.tokenInfo || {})}`);
        }
        throw new Error('WebSocket startup deferred — user ID unavailable, will retry');
      }

      this.validatedUserId = userId;
      this.twitchAPI.setValidatedUserId(userId);
      logger.info(`✅  User ID for watcher: ${userId}`);
      
      const graphqlClient = new GraphQLClient(this.authToken, this.userAgent);
      this.graphqlClient = graphqlClient;
      const eventHandlers = this.createWebSocketEventHandlers(graphqlClient);

      this.wsManager = new WebSocketManager(this.authToken, userId, graphqlClient, eventHandlers);
      await this.wsManager.start();
      this.wsManager.startPingInterval();
      
      // Сохраняем валидированный user_id для использования в payload
      this.validatedUserId = this.wsManager.getValidatedUserId();
      // Передаем валидированный user_id в TwitchAPI
      this.twitchAPI.setValidatedUserId(this.validatedUserId);
      logger.verbose(`✅  WebSocket initialized successfully (validated user_id: ${this.validatedUserId})`);
      this.updateInitializationStatus('WebSocket connected', 45);
      logger.info(`📋  WebSocket готов, загрузка ${this.priorityChannels.length} стримеров...`);
    } catch (error: any) {
      logger.error('❌  Failed to initialize WebSocket:', error.message || error);
      logger.error(`   Error details: ${error.stack || JSON.stringify(error)}`);
      if (!this.graphqlClient) {
        this.graphqlClient = new GraphQLClient(this.authToken, this.userAgent);
      }
      logger.warn('⚠️  Continuing without WebSocket - events will be sent via API only');
      logger.warn('⚠️  Channel points events will not be received in real-time');
      logger.warn('⚠️  Attempting to reinitialize WebSocket in 30 seconds...');
      this.updateInitializationStatus('WebSocket initialization failed, continuing...', 30);
      
      // Пытаемся переинициализировать WebSocket через 30 секунд
      setTimeout(() => {
        runSafeAsync('ws-init-retry', () => this.reinitializeWebSocket());
      }, 30000);
    }

    // Инициализируем стримеров
    this.updateInitializationStatus('Loading streamers...', 55);
    await this.initializeStreamers();
    

    // Запускаем отправку событий просмотра
    this.updateInitializationStatus('Starting watch services...', 70);
    logger.info('▶️  Запуск сервиса просмотра (minute-watched)...');
    this.startWatching();

    // Запускаем периодическую статистику
    this.startStatistics();
    
    // Запускаем периодическую проверку статуса стримеров
    this.startStatusCheck();
    
    // Запускаем периодическую проверку и переинициализацию WebSocket
    this.startWebSocketHealthCheck();
    
    // Запускаем TokenManager для отслеживания истечения токена
    if (this.tokenManager) {
      this.tokenManager.start();
    }
    
    // Добавляем начальные точки в историю баллов для всех онлайн стримеров
    // Используем setTimeout чтобы дать время на инициализацию стримеров
    setTimeout(() => {
      this.initializePointsHistory();
    }, 2000);

    // Запускаем health check server
    this.updateInitializationStatus('Starting health check server...', 90);
    this.startHealthCheckServer();
    this.startHealthCheckMonitoring();

    // Даем время на завершение инициализации, затем завершаем
    setTimeout(() => {
      this.updateInitializationStatus('Application ready', 100);
      this.initializationStatus.isInitialized = true;
      logger.info('✅  Приложение готово к работе');
    }, 1000);
  }

  /**
   * Повторно инициализирует WebSocket соединение
   * Используется для восстановления соединения после ошибки инициализации
   */
  private async reinitializeWebSocket(): Promise<void> {
    if (this.wsManager?.isConnected()) {
      logger.verbose('ℹ️  WebSocket already connected, skipping reinitialization');
      return;
    }

    if (this.wsManager) {
      this.wsManager.stop();
      this.wsManager = null;
    }

    logger.info('🔄  Attempting to reinitialize WebSocket connection...');
    
    try {
      logger.verbose('Getting user ID from token validation...');
      const tokenValidation = await this.twitchAPI.validateTokenWithInfo();
      if (!tokenValidation.isValid || !tokenValidation.tokenInfo?.user_id) {
        if (tokenValidation.errorType === 'network') {
          logger.warn('⚠️  Сетевая ошибка при реинициализации WebSocket — повтор через 5 минут');
          setTimeout(() => {
            runSafeAsync('ws-reinit-network-retry', () => this.reinitializeWebSocket());
          }, 5 * 60 * 1000);
          return;
        }
        logger.error('❌  Token validation failed during WebSocket reinitialization');
        logger.error(`   Token valid: ${tokenValidation.isValid}`);
        logger.error(`   Token info: ${JSON.stringify(tokenValidation.tokenInfo || {})}`);
        logger.warn('⚠️  Will retry WebSocket reinitialization in 5 minutes...');
        setTimeout(() => {
          runSafeAsync('ws-reinit-token-retry', () => this.reinitializeWebSocket());
        }, 5 * 60 * 1000);
        return;
      }
      
      const userId = tokenValidation.tokenInfo.user_id;
      this.twitchAPI.setValidatedUserId(userId);
      logger.info(`✅  User ID obtained from token validation: ${userId}`);
      
      const graphqlClient = this.graphqlClient ?? new GraphQLClient(this.authToken, this.userAgent);
      this.graphqlClient = graphqlClient;
      const eventHandlers = this.createWebSocketEventHandlers(graphqlClient);

      this.wsManager = new WebSocketManager(this.authToken, userId, graphqlClient, eventHandlers);
      await this.wsManager.start();
      this.wsManager.startPingInterval();
      
      this.validatedUserId = this.wsManager.getValidatedUserId();
      this.twitchAPI.setValidatedUserId(this.validatedUserId);
      logger.info(`✅  WebSocket reinitialized successfully (validated user_id: ${this.validatedUserId})`);
      
      // Добавляем всех существующих стримеров в WebSocket менеджер
      for (const streamerInfo of this.streamers.values()) {
        this.wsManager.addStreamer(streamerInfo);
      }
      
      this.addEvent('websocket-reconnected', 'system', 'WebSocket connection restored');
    } catch (error: any) {
      logger.error('❌  Failed to reinitialize WebSocket:', error.message || error);
      logger.error(`   Error details: ${error.stack || JSON.stringify(error)}`);
      logger.warn('⚠️  Will retry WebSocket reinitialization in 5 minutes...');
      
      // Повторная попытка через 5 минут
      setTimeout(() => {
        runSafeAsync('ws-reinit-failed-retry', () => this.reinitializeWebSocket());
      }, 5 * 60 * 1000);
    }
  }

  /**
   * Возвращает true, если watcher активен (для crash-диагностики)
   */
  isWatcherRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Останавливает просмотр
   */
  stop(): void {
    this.isRunning = false;
    this.sequentialWatchLoopActive = false;

    if (this.claimCheckInterval) {
      clearInterval(this.claimCheckInterval);
      this.claimCheckInterval = null;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }

    if (this.wsHealthCheckInterval) {
      clearInterval(this.wsHealthCheckInterval);
      this.wsHealthCheckInterval = null;
    }

    // Завершаем все активные сессии как прерванные
    if (this.statisticsStorage) {
      for (const [streamerName, sessionId] of this.activeSessions.entries()) {
        const streamerInfo = this.streamers.get(streamerName);
        if (streamerInfo) {
          this.flushStreamPointsEarnedToDatabase(streamerInfo);
          const finalPoints = streamerInfo.lastChannelPoints ?? streamerInfo.channelPoints;
          this.statisticsStorage.endSession(sessionId, finalPoints, 'interrupted');
          
          // Сохраняем время просмотра в базу данных
          this.saveWatchTimeToDatabase(streamerName, sessionId);
        }
      }
      this.activeSessions.clear();
      this.statisticsStorage.save();
      logger.verbose(`💾  All active sessions saved`);
    }

    // Закрываем соединение с базой данных
    if (this.databaseStorage) {
      this.databaseStorage.close();
      this.databaseStorage = null;
    }

    if (this.wsManager) {
      this.wsManager.stop();
      this.wsManager = null;
    }

    if (this.healthCheckMonitorInterval) {
      clearInterval(this.healthCheckMonitorInterval);
      this.healthCheckMonitorInterval = null;
    }

    if (this.healthCheckServer) {
      this.healthCheckServer.stop();
      this.healthCheckServer = null;
    }

    if (this.tokenManager) {
      this.tokenManager.stop();
      this.tokenManager = null;
    }

    if (this.webServerRetryTimer) {
      clearTimeout(this.webServerRetryTimer);
      this.webServerRetryTimer = null;
    }

    // Сохраняем текущее состояние баллов при остановке
    this.savePointsState(true);

    logger.info('🛑 API mode watcher stopped');
  }

  /**
   * Инициализирует стримеров с graceful degradation
   */
  private async initializeStreamers(): Promise<void> {
    const total = this.priorityChannels.length;
    const concurrency = Math.min(
      6,
      Math.max(1, parseInt(process.env.STREAMER_INIT_CONCURRENCY || '4', 10))
    );
    const perStreamerTimeoutMs = parseInt(process.env.STREAMER_INIT_TIMEOUT_MS || '45000', 10);

    logger.info(`📋  Инициализация ${total} стримеров (параллельно: ${concurrency}, таймаут: ${perStreamerTimeoutMs / 1000}с)...`);

    const initOne = async (username: string): Promise<void> => {
      const withTimeout = <T>(promise: Promise<T>): Promise<T> =>
        Promise.race([
          promise,
          new Promise<T>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Таймаут инициализации (${perStreamerTimeoutMs / 1000}с)`)),
              perStreamerTimeoutMs
            )
          ),
        ]);

      try {
        const streamerInfo = await withTimeout(this.twitchAPI.initializeStreamer(username));

        if (streamerInfo) {
          this.loadStreamerDataFromDatabase(streamerInfo);
          this.applyPersistedPoints(streamerInfo);
          this.restoreWatchSessionAfterRestart(streamerInfo);
          this.streamers.set(username, streamerInfo);

          if (this.wsManager) {
            this.wsManager.addStreamer(streamerInfo);
          }

          if (streamerInfo.isOnline) {
            logger.info(`✅  [${username}] Initialized - ONLINE`);

            if (this.statisticsStorage && streamerInfo.initialChannelPoints !== null) {
              const sessionId = this.statisticsStorage.createSession(
                streamerInfo.username,
                streamerInfo.initialChannelPoints,
                streamerInfo.game,
                streamerInfo.title
              );
              this.activeSessions.set(streamerInfo.username, sessionId);
            }
          } else {
            logger.info(`😴  [${username}] Initialized - OFFLINE`);
          }
        } else {
          logger.warn(`⚠️  [${username}] Failed to initialize, creating fallback entry`);
          this.streamers.set(username, this.createFallbackStreamerInfo(username));
        }
      } catch (error: any) {
        logger.warn(`⚠️  [${username}] ${error.message || error} — fallback, повтор позже`);
        const fallback = this.createFallbackStreamerInfo(username);
        this.applyPersistedPoints(fallback);
        this.restoreWatchSessionAfterRestart(fallback);
        this.streamers.set(username, fallback);
      }
    };

    for (let i = 0; i < total; i += concurrency) {
      const batch = this.priorityChannels.slice(i, i + concurrency);
      await Promise.all(batch.map(initOne));
      const done = Math.min(i + concurrency, total);
      logger.info(`📋  Прогресс инициализации: ${done}/${total}`);
      if (total > 0) {
        const initProgress = 55 + Math.round((done / total) * 30);
        this.updateInitializationStatus(`Loading streamers (${done}/${total})...`, initProgress);
      }
    }

    const onlineCount = Array.from(this.streamers.values()).filter(s => s.isOnline).length;
    logger.info(`✅  Инициализация завершена: ${onlineCount} онлайн из ${this.streamers.size} стримеров`);

    // Сохраняем актуальное состояние после инициализации
    this.savePointsState(true);
  }

  /**
   * Обработчики событий WebSocket (единая точка для старта и переинициализации)
   */
  private createWebSocketEventHandlers(graphqlClient: GraphQLClient): WebSocketEventHandler {
    return {
      onPointsEarned: (streamerInfo, points, reason) => {
        logger.info(`🚀  +${points} → ${streamerInfo.username} - Reason: ${reason}`);
        this.touchGlobalActivity();

        let eventType: string;
        if (reason === 'CLAIM') {
          eventType = 'claim-earned';
        } else if (reason === 'WATCH_STREAK') {
          eventType = 'streak-earned';
        } else {
          eventType = 'points-earned';
        }
        this.addEvent(eventType, streamerInfo.username, `Earned ${points} points (${reason})`);

        if (
          !this.activeSessions.has(streamerInfo.username) &&
          streamerInfo.initialChannelPoints !== null &&
          streamerInfo.isOnline &&
          this.statisticsStorage
        ) {
          const sessionId = this.statisticsStorage.createSession(
            streamerInfo.username,
            streamerInfo.initialChannelPoints,
            streamerInfo.game,
            streamerInfo.title
          );
          this.activeSessions.set(streamerInfo.username, sessionId);
          logger.verbose(`📊  [${streamerInfo.username}] Session created from WebSocket points update`);
        }

        const sessionId = this.activeSessions.get(streamerInfo.username);
        if (this.statisticsStorage && sessionId && streamerInfo.channelPoints !== null) {
          this.statisticsStorage.updateSession(sessionId, streamerInfo.channelPoints);
        }

        const stats = this.getStatistics();
        const totalPoints = stats.reduce((sum, stat) => sum + stat.pointsEarned, 0);
        this.addPointsHistory(streamerInfo.username, points, totalPoints);
        this.savePointsState();
      },
      onClaimAvailable: (streamerInfo, claimId) =>
        this.handleClaimAvailable(streamerInfo, claimId, graphqlClient),
      onStreamUp: async (streamerInfo) => {
        if (canResumeFromBriefOffline(streamerInfo)) {
          await this.resumeFromBriefOffline(streamerInfo, 'websocket');
          return;
        }

        const onlineAt = Date.now();
        const resumedSameStreamAfterRestart =
          streamerInfo.startTime > 0 && streamerInfo.startTime < onlineAt - 30_000;

        if (resumedSameStreamAfterRestart) {
          logger.info(
            `🥳  [${streamerInfo.username}] Stream still ONLINE after restart (same session)`
          );
          streamerInfo.webSocketOnlineAt = onlineAt;
          this.restoreStreamSessionCategoryTracking(streamerInfo);
          this.applyPersistedPoints(streamerInfo);
          try {
            await this.twitchAPI.updateStreamerInfo(streamerInfo, {
              allowOfflineDemotion: false,
            });
          } catch (error: any) {
            logger.verbose(
              `⚠️  [${streamerInfo.username}] Failed to update streamer info on stream-up resume: ${error.message || error}`
            );
          }
          return;
        }

        logger.info(`🥳  [${streamerInfo.username}] Stream went ONLINE`);
        this.recordLastOnlineTransition(streamerInfo.username, onlineAt);
        this.flushStreamPointsEarnedToDatabase(streamerInfo);
        this.resetStreamSessionPoints(streamerInfo);
        streamerInfo.startTime = onlineAt;
        streamerInfo.webSocketOnlineAt = onlineAt;
        this.persistLastStreamStart(streamerInfo.username, streamerInfo.startTime);
        this.addEvent('stream-up', streamerInfo.username, 'Stream went online');

        try {
          await this.twitchAPI.updateStreamerInfo(streamerInfo, { allowOfflineDemotion: false });
        } catch (error: any) {
          logger.verbose(
            `⚠️  [${streamerInfo.username}] Failed to update streamer info on stream-up: ${error.message || error}`
          );
        }

        this.persistStreamSession(
          streamerInfo.username,
          onlineAt,
          streamerInfo.broadcastId
        );
        this.beginStreamSessionCategoryTracking(streamerInfo, onlineAt);

        await this.updateInitialPoints(streamerInfo);

        if (this.statisticsStorage && streamerInfo.initialChannelPoints !== null) {
          const sessionId = this.statisticsStorage.createSession(
            streamerInfo.username,
            streamerInfo.initialChannelPoints,
            streamerInfo.game,
            streamerInfo.title
          );
          this.activeSessions.set(streamerInfo.username, sessionId);
        }

        const stats = this.getStatistics();
        const totalPoints = stats.reduce((sum, stat) => sum + stat.pointsEarned, 0);
        this.addPointsHistory(streamerInfo.username, 0, totalPoints);
        this.savePointsState();
      },
      onStreamDown: (streamerInfo) => {
        this.beginTentativeOffline(streamerInfo, 'websocket');
      },
      onRaidAvailable: async (streamerInfo, raidId, targetLogin) => {
        const now = Date.now();
        const lastAttempt = this.processedRaids.get(raidId);

        if (lastAttempt && now - lastAttempt < this.raidCooldownMs) {
          logger.verbose(
            `⏭️  [${streamerInfo.username}] Raid ${raidId} already processed recently, skipping`
          );
          return;
        }

        this.processedRaids.set(raidId, now);

        const fiveMinutesAgo = now - 5 * 60 * 1000;
        for (const [id, timestamp] of this.processedRaids.entries()) {
          if (timestamp < fiveMinutesAgo) {
            this.processedRaids.delete(id);
          }
        }

        logger.info(`🎭  [${streamerInfo.username}] Обнаружен рейд на канал ${targetLogin}`);
        const success = await graphqlClient.joinRaid(raidId);
        if (success) {
          logger.info(`✅  [${streamerInfo.username}] Успешно присоединились к рейду на ${targetLogin}!`);
          this.addEvent('raid-joined', streamerInfo.username, `Joined raid to ${targetLogin}`);
        } else {
          logger.verbose(
            `ℹ️  [${streamerInfo.username}] Не удалось присоединиться к рейду (возможно, уже присоединились)`
          );
        }
      },
    };
  }

  /**
   * Восстанавливает время просмотра после перезапуска, если стрим тот же
   */
  private restoreWatchSessionAfterRestart(streamerInfo: StreamerInfo): void {
    if (!streamerInfo.isOnline) {
      streamerInfo.startTime = 0;
      return;
    }

    const saved = this.pointsState[streamerInfo.username];
    const maxResumeAgeMs = parseInt(
      process.env.WATCH_RESUME_MAX_AGE_MS || String(24 * 60 * 60 * 1000),
      10
    );
    const now = Date.now();

    const canResumeByBroadcast =
      saved?.isOnline &&
      saved.startTime > 0 &&
      saved.broadcastId &&
      streamerInfo.broadcastId &&
      saved.broadcastId === streamerInfo.broadcastId;

    if (canResumeByBroadcast) {
      streamerInfo.startTime = saved.startTime;
      logger.info(
        `⏱️  [${streamerInfo.username}] Просмотр возобновлён (тот же стрим): ${formatElapsedTime(now - streamerInfo.startTime)}`
      );
      this.restoreStreamSessionCategoryTracking(streamerInfo);
      this.applyPersistedPoints(streamerInfo);
      return;
    }

    const canResumeByRecentState =
      saved?.isOnline &&
      saved.startTime > 0 &&
      saved.updatedAt > 0 &&
      now - saved.updatedAt < maxResumeAgeMs &&
      (!saved.broadcastId || !streamerInfo.broadcastId);

    if (canResumeByRecentState) {
      streamerInfo.startTime = saved.startTime;
      logger.info(
        `⏱️  [${streamerInfo.username}] Просмотр возобновлён (сохранённое состояние): ${formatElapsedTime(now - streamerInfo.startTime)}`
      );
      this.restoreStreamSessionCategoryTracking(streamerInfo);
      this.applyPersistedPoints(streamerInfo);
      return;
    }

    if (this.databaseStorage?.isReady()) {
      const dbStats = this.databaseStorage.getStreamerStats(streamerInfo.username);
      const streamStillActive =
        dbStats?.lastStreamStart &&
        (!dbStats.lastStreamEnd || dbStats.lastStreamEnd < dbStats.lastStreamStart);

      if (streamStillActive && dbStats.lastStreamStart) {
        streamerInfo.startTime = dbStats.lastStreamStart;
        logger.info(
          `⏱️  [${streamerInfo.username}] Просмотр возобновлён (из БД): ${formatElapsedTime(now - streamerInfo.startTime)}`
        );
        this.restoreStreamSessionCategoryTracking(streamerInfo);
        this.applyPersistedPoints(streamerInfo);
        return;
      }
    }

    if (!streamerInfo.startTime || streamerInfo.startTime <= 0) {
      streamerInfo.startTime = now;
      logger.verbose(`⏱️  [${streamerInfo.username}] Новая сессия просмотра`);
    }
    this.applyPersistedPoints(streamerInfo);
  }

  /**
   * Гарантирует startTime для онлайн-стримера (счётчик Active Watches в dashboard)
   */
  private ensureWatchSessionStarted(streamerInfo: StreamerInfo): void {
    if (!isEffectivelyOnline(streamerInfo) || streamerInfo.startTime > 0) {
      return;
    }
    const snap = streamerInfo.offlineWatchSnapshot;
    if (snap && snap.startTime > 0) {
      streamerInfo.startTime = snap.startTime;
      return;
    }
    streamerInfo.startTime = Date.now();
    logger.verbose(`⏱️  [${streamerInfo.username}] Сессия просмотра: startTime установлен`);
  }

  /**
   * Кратковременный офлайн: логируем OFFLINE, сессию не завершаем (grace до 5 мин)
   */
  private beginTentativeOffline(streamerInfo: StreamerInfo, source: string): void {
    if (!beginTentativeOfflineState(streamerInfo)) {
      return;
    }
    const graceMin = Math.round(getOfflineResumeGraceMs() / 60_000);
    logger.info(
      `😴  [${streamerInfo.username}] Stream went OFFLINE (${source}); сессия сохранена до ${graceMin} мин`
    );
    this.syncStreamPointsEarned(streamerInfo);
    this.addEvent('stream-down', streamerInfo.username, 'Stream went offline');
    this.savePointsState();
  }

  /**
   * Окончательный офлайн после истечения grace или явного завершения
   */
  private finalizeStreamerOffline(streamerInfo: StreamerInfo, source: string): void {
    if ((streamerInfo.offlineAt ?? 0) <= 0 && streamerInfo.isOnline) {
      beginTentativeOfflineState(streamerInfo);
    }

    logger.info(`😴  [${streamerInfo.username}] Stream OFFLINE confirmed (${source})`);
    this.flushStreamPointsEarnedToDatabase(streamerInfo);
    this.resetStreamSessionPoints(streamerInfo);
    const streamEndTime = Date.now();
    this.persistLastStreamEnd(streamerInfo.username, streamEndTime);

    const sessionId = this.activeSessions.get(streamerInfo.username);
    if (this.statisticsStorage && sessionId) {
      const finalPoints = streamerInfo.lastChannelPoints ?? streamerInfo.channelPoints;
      this.statisticsStorage.endSession(sessionId, finalPoints, 'completed');
      this.saveWatchTimeToDatabase(streamerInfo.username, sessionId);
      this.activeSessions.delete(streamerInfo.username);
    }

    streamerInfo.viewersCount = null;
    finalizeOfflineState(streamerInfo);
    this.activeStreamSessionKeys.delete(streamerInfo.username);
    this.savePointsState();
  }

  /**
   * Возврат в онлайн в пределах grace — без новой сессии и сброса баллов
   */
  private async resumeFromBriefOffline(
    streamerInfo: StreamerInfo,
    source: string
  ): Promise<void> {
    const offlineSec = Math.round((Date.now() - (streamerInfo.offlineAt ?? Date.now())) / 1000);
    if (!applyBriefOfflineResume(streamerInfo)) {
      return;
    }

    logger.info(
      `🥳  [${streamerInfo.username}] Stream ONLINE again (${source}, офлайн ${offlineSec}s) — сессия продолжена`
    );
    this.recordLastOnlineTransition(streamerInfo.username, Date.now());
    this.addEvent('stream-up', streamerInfo.username, 'Stream resumed after brief offline');

    try {
      await this.twitchAPI.updateStreamerInfo(streamerInfo, { allowOfflineDemotion: false });
    } catch (error: any) {
      logger.verbose(
        `⚠️  [${streamerInfo.username}] Failed to refresh streamer info on resume: ${error.message || error}`
      );
    }

    this.ensureWatchSessionStarted(streamerInfo);
    this.savePointsState();
  }

  /**
   * Завершает watch для стримеров с истёкшим grace краткого офлайна
   */
  private finalizeExpiredOfflineGraces(): void {
    for (const streamerInfo of this.streamers.values()) {
      if (shouldFinalizeOffline(streamerInfo)) {
        this.finalizeStreamerOffline(streamerInfo, 'offline-grace-expired');
      }
    }
  }

  /**
   * Отмечает активность бота (minute-watched, баллы)
   */
  private touchGlobalActivity(): void {
    this.lastGlobalActivityAt = Date.now();
  }

  /**
   * Запоминает переход стримера в онлайн для Last Activity на dashboard
   */
  private recordLastOnlineTransition(username: string, at: number = Date.now()): void {
    this.lastOnlineTransition = { username, at };
  }

  /**
   * Количество активных просмотров для /api/overall
   */
  getActiveWatchCount(): number {
    for (const info of this.streamers.values()) {
      if (isEffectivelyOnline(info) && info.startTime <= 0) {
        this.ensureWatchSessionStarted(info);
      }
    }

    const stats: WatchStatistics[] = [];
    for (const streamerInfo of this.streamers.values()) {
      if (!isEffectivelyOnline(streamerInfo)) {
        continue;
      }
      const watchStart = getEffectiveWatchStartTime(streamerInfo);
      if (watchStart <= 0) {
        continue;
      }
      stats.push({
        streamerName: streamerInfo.username,
        elapsedTime: Date.now() - watchStart,
        pointsEarned: streamerInfo.streamPointsEarned ?? 0,
        currentPoints: streamerInfo.channelPoints ?? 0,
        status: 'ONLINE',
        game: streamerInfo.game,
        viewersCount: streamerInfo.viewersCount ?? null,
      });
    }
    return stats.length;
  }

  /**
   * Базовая запись стримера при сбое инициализации
   */
  private createFallbackStreamerInfo(username: string): StreamerInfo {
    return {
      username,
      channelId: '',
      channelPoints: 0,
      isOnline: false,
      broadcastId: null,
      game: null,
      title: null,
      tags: [],
      spadeUrl: null,
      startTime: 0,
      initialChannelPoints: null,
      lastChannelPoints: null,
      streamPointsEarned: 0,
      pointsEarnedBaseline: 0,
    };
  }

  /**
   * Есть ли сохранённая сессия баллов (для восстановления после перезапуска)
   */
  private hasPersistedPointsSession(username: string): boolean {
    const saved = this.pointsState[username];
    if (!saved) {
      return false;
    }
    if (Number.isFinite(saved.streamPointsEarned) && saved.streamPointsEarned > 0) {
      return true;
    }
    return (
      !!saved.isOnline &&
      saved.startTime > 0 &&
      saved.initialChannelPoints != null &&
      Number.isFinite(saved.initialChannelPoints)
    );
  }

  /**
   * Сбрасывает счётчик баллов за стрим при переходе в онлайн
   */
  private resetStreamSessionPoints(streamerInfo: StreamerInfo): void {
    streamerInfo.streamPointsEarned = 0;
    streamerInfo.initialChannelPoints = null;
  }

  /**
   * Сохраняет баллы текущей сессии в БД (как watch time при завершении просмотра)
   */
  private flushStreamPointsEarnedToDatabase(streamerInfo: StreamerInfo): void {
    this.syncStreamPointsEarned(streamerInfo);
    const earned = Math.max(0, streamerInfo.streamPointsEarned ?? 0);
    if (earned <= 0) {
      return;
    }

    if (this.databaseStorage?.isReady()) {
      this.databaseStorage.addTotalPoints(streamerInfo.username, earned);
      this.databaseStorage.addDailyPoints(streamerInfo.username, earned);
    }

    streamerInfo.streamPointsEarned = 0;
    logger.verbose(
      `📊  [${streamerInfo.username}] Session points saved to DB: +${earned}`
    );
  }

  /**
   * Активна ли сессия начисления баллов (онлайн или краткий офлайн в пределах grace)
   */
  private isInActivePointsSession(streamerInfo: StreamerInfo, now = Date.now()): boolean {
    if (streamerInfo.initialChannelPoints === null) {
      return false;
    }
    if (streamerInfo.isOnline) {
      return true;
    }
    return (
      isWithinOfflineResumeGrace(streamerInfo, now) &&
      streamerInfo.offlineWatchSnapshot != null
    );
  }

  /**
   * Итого заработанных баллов для dashboard (только текущая сессия стрима)
   */
  private getPointsEarnedForDisplay(streamerInfo: StreamerInfo): number {
    if (!this.isInActivePointsSession(streamerInfo)) {
      return 0;
    }
    this.syncStreamPointsEarned(streamerInfo);
    return streamerInfo.streamPointsEarned ?? 0;
  }

  /**
   * Обновляет заработанные за текущий стрим баллы по балансу и начальной точке
   */
  private syncStreamPointsEarned(streamerInfo: StreamerInfo): void {
    if (streamerInfo.initialChannelPoints === null) {
      return;
    }

    const balance = streamerInfo.lastChannelPoints ?? streamerInfo.channelPoints ?? 0;
    streamerInfo.streamPointsEarned = balance - streamerInfo.initialChannelPoints;
  }

  /**
   * Собирает бонусный сундук по событию claim-available из WebSocket
   */
  private async handleClaimAvailable(
    streamerInfo: StreamerInfo,
    claimId: string,
    graphqlClient: GraphQLClient
  ): Promise<void> {
    if (this.claimIdBlocklist.isBlocked(claimId)) {
      logger.verbose(
        `⏭️  [${streamerInfo.username}] Пропуск бонуса ${claimId} (уже была неудачная попытка)`
      );
      return;
    }

    logger.info(`🎁  [${streamerInfo.username}] Доступен бонус ${claimId}, собираем...`);

    const attemptedIds: string[] = [claimId];
    const attemptResults: ClaimBonusResult[] = [];
    let lastResult = await graphqlClient.claimBonus(streamerInfo.channelId, claimId);
    attemptResults.push(lastResult);

    if (!lastResult.success) {
      try {
        const pointsInfo = await graphqlClient.getChannelPoints(streamerInfo.username);
        const fallbackClaimId = pointsInfo?.availableClaim?.id;
        if (
          fallbackClaimId &&
          fallbackClaimId !== claimId &&
          !this.claimIdBlocklist.isBlocked(fallbackClaimId)
        ) {
          logger.verbose(
            `ℹ️  [${streamerInfo.username}] Повтор с ID из GraphQL: ${fallbackClaimId}`
          );
          attemptedIds.push(fallbackClaimId);
          lastResult = await graphqlClient.claimBonus(streamerInfo.channelId, fallbackClaimId);
          attemptResults.push(lastResult);
        }
      } catch (error: any) {
        logger.verbose(
          `⚠️  [${streamerInfo.username}] Не удалось получить fallback claim: ${error.message || error}`
        );
      }
    }

    if (lastResult.success) {
      for (const id of attemptedIds) {
        this.claimIdBlocklist.clear(id);
      }
      logger.info(`✅  [${streamerInfo.username}] Бонус успешно собран!`);
      this.recordClaimHealth(streamerInfo.username, {
        outcome: 'success',
        message: 'Bonus chest claimed',
      });
      this.addEvent('claim-success', streamerInfo.username, 'Bonus chest claimed');
      return;
    }

    const hadIntegrityFailure = attemptResults.some((r) => r.failureKind === 'integrity');
    const hadPermanentFailure = attemptResults.some((r) => r.failureKind === 'permanent');
    const failureKind = hadIntegrityFailure
      ? 'integrity'
      : hadPermanentFailure
        ? 'permanent'
        : lastResult.failureKind ?? 'unknown';

    if (hadPermanentFailure) {
      this.claimIdBlocklist.markPermanent(...attemptedIds);
      logger.verbose(
        `⚠️  [${streamerInfo.username}] Бонус не собран (FORBIDDEN / уже собран) — claimId в blocklist`
      );
    } else if (hadIntegrityFailure) {
      logger.warn(
        `⚠️  [${streamerInfo.username}] failed integrity check — обновите Client-Integrity в «Конфиг бота» (DevTools → gql)`
      );
    } else {
      logger.verbose(`⚠️  [${streamerInfo.username}] Не удалось собрать бонус — повторим при следующем опросе`);
    }

    const failMessage = hadIntegrityFailure
      ? 'Failed integrity check — update TWITCH_CLIENT_INTEGRITY'
      : 'Failed to claim bonus';
    this.recordClaimHealth(streamerInfo.username, {
      outcome: 'failed',
      failureKind,
      message: failMessage,
    });
    this.addEvent('claim-failed', streamerInfo.username, failMessage);
  }

  /**
   * Сохраняет результат claim для панели здоровья бота (хранятся только последние 5 по времени)
   */
  private recordClaimHealth(
    streamer: string,
    data: {
      outcome: 'success' | 'failed';
      failureKind?: StreamerClaimHealth['failureKind'];
      message: string;
    }
  ): void {
    const entry: StreamerClaimHealth = {
      streamer,
      outcome: data.outcome,
      failureKind: data.failureKind,
      timestamp: Date.now(),
      message: data.message,
    };
    this.claimHealthRecent.push(entry);
    this.claimHealthRecent.sort((a, b) => b.timestamp - a.timestamp);
    if (this.claimHealthRecent.length > StreamWatcher.CLAIM_HEALTH_RECENT_MAX) {
      this.claimHealthRecent.length = StreamWatcher.CLAIM_HEALTH_RECENT_MAX;
    }
    if (data.failureKind === 'integrity') {
      this.lastIntegrityFailure = { timestamp: entry.timestamp, streamer };
    }
  }

  /**
   * Запускает отправку событий просмотра и периодическую проверку бонусов
   */
  private startWatching(): void {
    this.syncWatchConfigFromSettings();
    this.sequentialWatchLoopActive = false;
    this.startSequentialWatchLoop();
    this.startClaimPolling();
  }

  /**
   * Синхронизирует интервал ротации из config.json / runtime
   */
  private syncWatchConfigFromSettings(): void {
    this.watchCycleIntervalMs = getWatchCycleIntervalMs();
  }

  /**
   * Перезапускает сервис minute-watched после смены настроек
   */
  private restartWatchService(): void {
    if (!this.isRunning) {
      return;
    }
    this.startWatching();
  }

  /**
   * Применяет настройки просмотра (dashboard API)
   */
  applyWatchSettings(partial: { cycleIntervalMs?: number }): WatchSettingsSnapshot {
    if (partial.cycleIntervalMs !== undefined) {
      applyWatchCycleIntervalOverride(partial.cycleIntervalMs);
    }
    this.syncWatchConfigFromSettings();
    this.restartWatchService();
    return this.getWatchSettingsSnapshot();
  }

  /**
   * Снимок настроек minute-watched для dashboard
   */
  getWatchSettingsSnapshot(): WatchSettingsSnapshot {
    const cycleIntervalMs = getWatchCycleIntervalMs();
    return {
      cycleIntervalMs,
      cycleIntervalSec: Math.round(cycleIntervalMs / 1000),
      lastSequentialStreamer: this.lastSequentialStreamer,
      onlineCount: this.getOrderedOnlineStreamers().length,
    };
  }

  /**
   * Возвращает Twitch API клиент для dashboard (поиск категорий)
   */
  getTwitchApiForDashboard(): TwitchAPI {
    return this.twitchAPI;
  }

  /**
   * Онлайн-стримеры в порядке priorityChannels, затем остальные по имени
   */
  private getOrderedOnlineStreamers(): StreamerInfo[] {
    const online = Array.from(this.streamers.values()).filter((s) => s.isOnline);
    const order = new Map(this.priorityChannels.map((name, index) => [name.toLowerCase(), index]));
    return online.sort((a, b) => {
      const ai = order.get(a.username.toLowerCase());
      const bi = order.get(b.username.toLowerCase());
      if (ai !== undefined && bi !== undefined) {
        return ai - bi;
      }
      if (ai !== undefined) {
        return -1;
      }
      if (bi !== undefined) {
        return 1;
      }
      return a.username.localeCompare(b.username);
    });
  }

  /**
   * Запускает очередь minute-watched (один канал → пауза → следующий)
   */
  private startSequentialWatchLoop(): void {
    if (this.sequentialWatchLoopActive) {
      return;
    }
    this.sequentialWatchLoopActive = true;
    logger.info(
      `📺  Sequential minute-watched: интервал ${Math.round(this.watchCycleIntervalMs / 1000)}s между каналами`
    );
    runSafeAsync('minute-watched-sequential', () => this.runSequentialWatchLoop());
  }

  /**
   * Цикл: один онлайн-канал за итерацию, затем пауза watchCycleIntervalMs
   */
  private async runSequentialWatchLoop(): Promise<void> {
    while (this.isRunning && this.sequentialWatchLoopActive) {
      this.syncWatchConfigFromSettings();

      const online = this.getOrderedOnlineStreamers();
      if (online.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, this.watchCycleIntervalMs));
        continue;
      }

      const position = this.sequentialRotationIndex % online.length;
      const streamer = online[position];
      const nextPosition = (position + 1) % online.length;
      const nextUsername = online[nextPosition]?.username ?? '—';
      this.lastSequentialStreamer = streamer.username;

      const pauseSec = Math.round(this.watchCycleIntervalMs / 1000);
      logger.info(
        `📺  [sequential] ${position + 1}/${online.length}: ${streamer.username} → пауза ${pauseSec}s → ${nextUsername}`
      );

      await this.sendMinuteWatchedForStreamer(streamer);
      this.sequentialRotationIndex = nextPosition;

      if (!this.isRunning || !this.sequentialWatchLoopActive) {
        break;
      }

      logger.verbose(`⏱️  [sequential] Пауза ${pauseSec}s до ${nextUsername}`);
      await new Promise((resolve) => setTimeout(resolve, this.watchCycleIntervalMs));
    }

    this.sequentialWatchLoopActive = false;
  }

  /**
   * Отправляет minute-watched для одного стримера
   */
  private async sendMinuteWatchedForStreamer(streamerInfo: StreamerInfo): Promise<void> {
    if (this.channelWatchInProgress.has(streamerInfo.username)) {
      logger.verbose(
        `⏭️  [${streamerInfo.username}] minute-watched: предыдущая отправка ещё выполняется`
      );
      return;
    }

    this.channelWatchInProgress.add(streamerInfo.username);
    const tickStart = Date.now();

    try {
      if (!streamerInfo.isOnline) {
        return;
      }

      try {
        await this.prepareStreamerForWatch(streamerInfo);
      } catch (error: any) {
        logger.warn(
          `⚠️  [${streamerInfo.username}] Failed to prepare for watch: ${error.message || error}`
        );
        logger.verbose(`ℹ️  [${streamerInfo.username}] Continuing with last known data`);
      }

      if (!streamerInfo.isOnline) {
        logger.verbose(
          `ℹ️  [${streamerInfo.username}] Стример ушел офлайн, пропускаем отправку события`
        );
        return;
      }

      if (!streamerInfo.spadeUrl) {
        logger.warn(`⚠️  [${streamerInfo.username}] Spade URL not available, skipping event`);
        return;
      }

      const success = await withTimeout(
        () => this.twitchAPI.sendMinuteWatched(streamerInfo),
        this.watchOpTimeoutMs,
        `sendMinuteWatched:${streamerInfo.username}`
      );

      if (success) {
        logger.info(`✅  [${streamerInfo.username}] Minute watched event sent`);
        this.touchGlobalActivity();
        if (this.graphqlClient) {
          runSafeAsync(`claim-after-watch-${streamerInfo.username}`, () =>
            this.tryClaimBonusForStreamer(streamerInfo)
          );
        }
      } else if (!streamerInfo.isOnline) {
        logger.verbose(`ℹ️  [${streamerInfo.username}] Стример ушел офлайн, событие не отправлено`);
      } else {
        streamerInfo.spadeUrl = null;
        logger.verbose(
          `🔄  [${streamerInfo.username}] minute-watched не отправлен, spade_url будет обновлён на следующем цикле`
        );
      }
    } catch (error: any) {
      logger.error(
        `❌  [${streamerInfo.username}] Error sending minute watched event: ${error.message || error}`
      );
    } finally {
      const tickMs = Date.now() - tickStart;
      if (tickMs > this.watchCycleIntervalMs - 5000) {
        logger.warn(
          `⚠️  [${streamerInfo.username}] minute-watched tick took ${tickMs}ms (interval ${this.watchCycleIntervalMs}ms)`
        );
      } else {
        logger.verbose(`ℹ️  [${streamerInfo.username}] minute-watched tick took ${tickMs}ms`);
      }
      this.channelWatchInProgress.delete(streamerInfo.username);
    }
  }

  /**
   * Проверяет и собирает бонус после успешного minute-watched
   */
  private async tryClaimBonusForStreamer(streamerInfo: StreamerInfo): Promise<void> {
    const graphqlClient = this.graphqlClient;
    if (!graphqlClient || !streamerInfo.isOnline || !streamerInfo.channelId) {
      return;
    }

    const now = Date.now();
    const lastAttempt = this.recentClaimAttempts.get(streamerInfo.username);
    if (lastAttempt && now - lastAttempt < this.claimAttemptCooldownMs) {
      return;
    }

    try {
      const pointsInfo = await graphqlClient.getChannelPoints(streamerInfo.username);
      const claimId = pointsInfo?.availableClaim?.id;
      if (!claimId || this.claimIdBlocklist.isBlocked(claimId)) {
        return;
      }

      this.recentClaimAttempts.set(streamerInfo.username, now);
      await this.handleClaimAvailable(streamerInfo, claimId, graphqlClient);
    } catch (error: any) {
      logger.verbose(
        `⚠️  [${streamerInfo.username}] Claim check after watch failed: ${error.message || error}`
      );
    }
  }

  /**
   * Периодический опрос GraphQL на доступные бонусы (дополнение к WebSocket)
   */
  private startClaimPolling(): void {
    if (this.claimCheckInterval) {
      return;
    }

    this.claimCheckInterval = setSafeAsyncInterval(
      'claim-poll',
      () => this.pollPendingClaims(),
      this.claimCheckIntervalMs
    );
    runSafeAsync('claim-poll-initial', () => this.pollPendingClaims());
  }

  /**
   * Проверяет онлайн-каналы на availableClaim и собирает бонусы
   */
  private async pollPendingClaims(): Promise<void> {
    const graphqlClient = this.graphqlClient;
    if (!graphqlClient) {
      return;
    }

    const onlineStreamers = Array.from(this.streamers.values()).filter(
      (s) => s.isOnline && s.channelId
    );
    if (onlineStreamers.length === 0) {
      return;
    }

    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    for (const [username, timestamp] of this.recentClaimAttempts.entries()) {
      if (timestamp < fiveMinutesAgo) {
        this.recentClaimAttempts.delete(username);
      }
    }
    this.claimIdBlocklist.prune(now);

    for (const streamerInfo of onlineStreamers) {
      const lastAttempt = this.recentClaimAttempts.get(streamerInfo.username);
      if (lastAttempt && now - lastAttempt < this.claimAttemptCooldownMs) {
        continue;
      }

      try {
        const pointsInfo = await graphqlClient.getChannelPoints(streamerInfo.username);
        const claimId = pointsInfo?.availableClaim?.id;
        if (!claimId) {
          continue;
        }
        if (this.claimIdBlocklist.isBlocked(claimId)) {
          continue;
        }

        this.recentClaimAttempts.set(streamerInfo.username, now);
        logger.verbose(
          `🔍  [${streamerInfo.username}] GraphQL poll: бонус ${claimId}, собираем...`
        );
        await this.handleClaimAvailable(streamerInfo, claimId, graphqlClient);
      } catch (error: any) {
        logger.verbose(
          `⚠️  [${streamerInfo.username}] Ошибка опроса бонуса: ${error.message || error}`
        );
      }
    }
  }

  /**
   * Лёгкая подготовка стримера перед minute-watched (полное обновление — по интервалу)
   */
  private async prepareStreamerForWatch(streamerInfo: StreamerInfo): Promise<void> {
    const now = Date.now();
    const needsFullUpdate =
      !streamerInfo.lastWatchPrepAt ||
      now - streamerInfo.lastWatchPrepAt > this.watchPrepIntervalMs ||
      !streamerInfo.broadcastId;

    if (needsFullUpdate) {
      await withTimeout(
        () => this.twitchAPI.updateStreamerInfo(streamerInfo),
        this.watchOpTimeoutMs,
        `updateStreamerInfo:${streamerInfo.username}`
      );
      streamerInfo.lastWatchPrepAt = now;
    }

    if (!streamerInfo.spadeUrl && streamerInfo.isOnline) {
      logger.verbose(`🔄  [${streamerInfo.username}] Attempting to get spade_url...`);
      streamerInfo.spadeUrl = await withTimeout(
        () => this.twitchAPI.getSpadeUrl(streamerInfo.username),
        this.watchOpTimeoutMs,
        `getSpadeUrl:${streamerInfo.username}`
      );
      if (streamerInfo.spadeUrl) {
        logger.verbose(`✅  [${streamerInfo.username}] Spade URL obtained`);
      }
    }
  }

  /** Троттлинг GraphQL-синхронизации статуса перед отдачей в dashboard API */
  private lastDashboardStatusSyncAt = 0;
  /** Фоновая синхронизация для dashboard API (не блокирует ответ) */
  private dashboardStatusSyncInFlight: Promise<void> | null = null;

  /**
   * Собирает стримеров для GraphQL-синхронизации статуса
   */
  private collectDashboardStatusSyncCandidates(now = Date.now()): StreamerInfo[] {
    const candidates = new Set<StreamerInfo>();
    for (const info of this.streamers.values()) {
      if (info.isOnline || isEffectivelyOnline(info)) {
        candidates.add(info);
      }
    }

    const lastOnline = this.lastOnlineTransition;
    if (lastOnline && now - lastOnline.at < 10 * 60 * 1000) {
      for (const info of this.streamers.values()) {
        if (info.username === lastOnline.username && !info.isOnline) {
          candidates.add(info);
          break;
        }
      }
    }

    return [...candidates];
  }

  /**
   * GraphQL-синхронизация статусов (параллельно, с ограничением concurrency)
   */
  private async runDashboardStatusSync(): Promise<void> {
    const candidates = this.collectDashboardStatusSyncCandidates();
    if (candidates.length === 0) {
      return;
    }

    const concurrency = Math.max(
      1,
      parseInt(process.env.STATS_STATUS_SYNC_CONCURRENCY || '3', 10)
    );
    let index = 0;

    const worker = async (): Promise<void> => {
      while (index < candidates.length) {
        const streamerInfo = candidates[index];
        index += 1;
        try {
          await this.twitchAPI.updateStreamerInfo(streamerInfo);
        } catch (error: any) {
          logger.verbose(
            `⚠️  [${streamerInfo.username}] Status sync for dashboard failed: ${error.message || error}`
          );
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker())
    );
  }

  /**
   * Подтягивает статус через GraphQL для dashboard API.
   * По умолчанию не блокирует HTTP-ответ — синхронизация идёт в фоне.
   * @param force true — дождаться синхронизации (printStatistics)
   */
  async syncStatisticsStatusesBeforeRead(force = false): Promise<void> {
    const now = Date.now();
    const minIntervalMs = parseInt(process.env.STATS_STATUS_SYNC_MS || '5000', 10);

    if (!force) {
      if (now - this.lastDashboardStatusSyncAt < minIntervalMs) {
        return;
      }
      if (this.dashboardStatusSyncInFlight) {
        return;
      }
      this.lastDashboardStatusSyncAt = now;
      this.dashboardStatusSyncInFlight = this.runDashboardStatusSync().finally(() => {
        this.dashboardStatusSyncInFlight = null;
      });
      return;
    }

    if (this.dashboardStatusSyncInFlight) {
      await this.dashboardStatusSyncInFlight;
    }
    this.lastDashboardStatusSyncAt = now;
    await this.runDashboardStatusSync();
  }

  /**
   * Запускает периодический вывод статистики
   */
  private startStatistics(): void {
    // Выводим статистику каждые 30 секунд
    this.statsInterval = setSafeAsyncInterval('statistics', () => this.printStatistics(), 30000);
    runSafeAsync('statistics-initial', () => this.printStatistics());
  }

  /**
   * Выводит статистику просмотра
   */
  private async printStatistics(): Promise<void> {
    await this.syncStatisticsStatusesBeforeRead(true);

    const stats = this.getStatistics();

    if (stats.length === 0) {
      logger.important('📊  Currently watching: none');
    } else {
      logger.important(`\n📊  Currently watching (${stats.length}):`);
      for (const stat of stats) {
        const elapsed = formatElapsedTime(stat.elapsedTime);
        const pointsDisplay = stat.pointsEarned >= 0
          ? `+${stat.pointsEarned}`
          : `${stat.pointsEarned}`;

        logger.important(
          `   • ${stat.streamerName}: ${elapsed} | Points: ${stat.currentPoints} | Earned: ${pointsDisplay} | Status: ${stat.status}`
        );
      }
    }

    this.logOverallDashboardStats();
  }

  /**
   * Логирует сводку метрик дашборда (Active Watches, Total Points, Streamers, Last Activity).
   */
  private logOverallDashboardStats(): void {
    const { activeWatches, totalPointsEarned, streamersCount, lastActivity, lastOnlineStreamer } =
      this.getOverallStats();
    let lastActivityLabel = '—';
    if (lastOnlineStreamer && lastActivity > 0) {
      lastActivityLabel = `${lastOnlineStreamer} · ${formatElapsedTime(lastActivity)} ago`;
    }

    logger.important(
      `📊  Dashboard: Active Watches=${activeWatches} | Total Points=+${totalPointsEarned} | Streamers=${streamersCount} | Last Online=${lastActivityLabel}`
    );
  }

  /**
   * Получает статистику просмотра
   * @param includeOffline Включать ли офлайн стримеров (по умолчанию false для обратной совместимости)
   * @returns Массив статистики
   */
  getStatistics(includeOffline: boolean = false): WatchStatistics[] {
    const stats: WatchStatistics[] = [];

    for (const streamerInfo of this.streamers.values()) {
      const effectivelyOnline = isEffectivelyOnline(streamerInfo);

      // Если не включаем офлайн, пропускаем офлайн стримеров
      if (!includeOffline && !effectivelyOnline) {
        continue;
      }

      const watchStart = getEffectiveWatchStartTime(streamerInfo);
      // Для офлайн стримеров используем 0 для elapsedTime
      const elapsed =
        effectivelyOnline && watchStart > 0 ? Date.now() - watchStart : 0;

      let currentPoints = streamerInfo.channelPoints ?? 0;

      if (effectivelyOnline) {
        // Если channelPoints не установлен, пробуем использовать lastChannelPoints
        if (currentPoints === 0 && streamerInfo.lastChannelPoints !== null) {
          currentPoints = streamerInfo.lastChannelPoints;
        }
      } else {
        // Для офлайн стримеров используем lastChannelPoints, если channelPoints равен 0
        if (currentPoints === 0 && streamerInfo.lastChannelPoints !== null) {
          currentPoints = streamerInfo.lastChannelPoints;
        }
        
        // Если все еще 0, пробуем загрузить из сохраненного состояния
        if (currentPoints === 0) {
          const saved = this.pointsState[streamerInfo.username];
          if (saved && Number.isFinite(saved.channelPoints) && saved.channelPoints > 0) {
            currentPoints = saved.channelPoints;
            streamerInfo.lastChannelPoints = saved.channelPoints;
          }
        }
      }

      const pointsEarned = this.getPointsEarnedForDisplay(streamerInfo);

      const status = getDisplayStreamStatus(streamerInfo);
      
      stats.push({
        streamerName: streamerInfo.username,
        elapsedTime: elapsed,
        pointsEarned,
        currentPoints,
        status,
        game: streamerInfo.game,
        viewersCount:
          effectivelyOnline && streamerInfo.viewersCount != null
            ? streamerInfo.viewersCount
            : null,
      });
    }

    // Периодически сохраняем состояние баллов
    this.savePointsState();

    return stats;
  }

  /**
   * Обновляет начальные баллы стримера
   * @param streamerInfo Информация о стримере
   */
  private async updateInitialPoints(streamerInfo: StreamerInfo): Promise<void> {
    // Пробуем получить начальные баллы через GraphQL (опционально)
    // Если не получится - WebSocket событие points-earned установит их
    try {
      const graphqlClient = new GraphQLClient(this.authToken, this.userAgent);
      const pointsInfo = await graphqlClient.getChannelPoints(streamerInfo.username);
      
      if (pointsInfo && streamerInfo.initialChannelPoints === null) {
        streamerInfo.initialChannelPoints = pointsInfo.balance;
        streamerInfo.lastChannelPoints = pointsInfo.balance;
        streamerInfo.channelPoints = pointsInfo.balance;
        logger.verbose(`💰  [${streamerInfo.username}] Initial points set via GraphQL: ${pointsInfo.balance}`);
      }
    } catch (error: any) {
      // Не критично - баллы будут установлены при первом WebSocket событии points-earned
      logger.verbose(`⚠️  [${streamerInfo.username}] Failed to get initial points via GraphQL (will be set from WebSocket): ${error.message || error}`);
    }
  }

  /**
   * Периодически проверяет статус стримеров
   * ВАЖНО: WebSocket события stream-up/stream-down являются основным источником статуса
   * GraphQL проверка используется только как fallback для стримеров, которые были офлайн
   */
  startStatusCheck(): void {
    if (this.statusCheckInterval) {
      logger.verbose('ℹ️  Status check already running, skipping duplicate start');
      return;
    }

    // Проверяем статус каждые 2 минуты как fallback для WebSocket событий
    // WebSocket события stream-up/stream-down являются основным источником статуса
    // GraphQL проверка нужна для случаев, когда WebSocket события не приходят
    this.statusCheckInterval = setSafeAsyncInterval(
      'streamers-status',
      () => this.checkStreamersStatus(),
      120000
    );
  }

  /**
   * Периодически проверяет статус WebSocket и пытается переинициализировать, если он не инициализирован
   */
  private startWebSocketHealthCheck(): void {
    // Интервал проверки WebSocket — по умолчанию 2 мин (WS_HEALTH_CHECK_INTERVAL_MS)
    const wsHealthIntervalMs = parseInt(process.env.WS_HEALTH_CHECK_INTERVAL_MS || '120000', 10);

    this.wsHealthCheckInterval = setSafeAsyncInterval(
      'websocket-health',
      async () => {
        if (!this.wsManager) {
          logger.warn('⚠️  WebSocket manager not initialized, attempting to reinitialize...');
          await this.reinitializeWebSocket();
          return;
        }

        if (this.wsManager.isConnected()) {
          logger.verbose('✅  WebSocket is connected and healthy');
          return;
        }

        const state = this.wsManager.getConnectionState();
        if (this.wsManager.isActive()) {
          logger.verbose(`ℹ️  WebSocket переподключается (state: ${state})`);
          return;
        }

        logger.warn(`⚠️  WebSocket не активен (state: ${state}), переинициализация...`);
        this.wsManager.stop();
        this.wsManager = null;
        await this.reinitializeWebSocket();
      },
      wsHealthIntervalMs
    );
  }

  /**
   * Сохраняет время начала стрима в БД (WebSocket и GraphQL fallback)
   */
  private persistLastStreamStart(username: string, timestamp: number): void {
    if (this.databaseStorage?.isReady()) {
      this.databaseStorage.updateLastStreamStart(username, timestamp);
    }
  }

  /**
   * Сохраняет сессию стрима в БД (дедуп по broadcast id или времени старта)
   */
  private persistStreamSession(
    username: string,
    startedAt: number,
    broadcastId?: string | null
  ): void {
    if (this.databaseStorage?.isReady()) {
      this.databaseStorage.recordStreamSession(username, startedAt, broadcastId);
    }
  }

  /**
   * Начинает отслеживание категорий для новой сессии стрима
   */
  private beginStreamSessionCategoryTracking(
    streamerInfo: StreamerInfo,
    startedAt: number
  ): void {
    const sessionKey = buildStreamSessionKey(startedAt, streamerInfo.broadcastId);
    this.activeStreamSessionKeys.set(streamerInfo.username, sessionKey);
    this.trackStreamCategoryForSession(streamerInfo);
  }

  /**
   * Восстанавливает отслеживание категорий после перезапуска или краткого офлайна
   */
  private restoreStreamSessionCategoryTracking(streamerInfo: StreamerInfo): void {
    if (!streamerInfo.isOnline) {
      return;
    }

    const startedAt =
      streamerInfo.startTime > 0
        ? streamerInfo.startTime
        : streamerInfo.webSocketOnlineAt ?? Date.now();
    const sessionKey = buildStreamSessionKey(startedAt, streamerInfo.broadcastId);
    this.activeStreamSessionKeys.set(streamerInfo.username, sessionKey);

    if (this.databaseStorage?.isReady()) {
      if (!this.databaseStorage.hasStreamSession(streamerInfo.username, sessionKey)) {
        this.databaseStorage.recordStreamSession(
          streamerInfo.username,
          startedAt,
          streamerInfo.broadcastId
        );
      }
      this.trackStreamCategoryForSession(streamerInfo);
    }
  }

  /**
   * Сохраняет текущую категорию в активной сессии стрима (без дубликатов)
   */
  private trackStreamCategoryForSession(streamerInfo: StreamerInfo): void {
    const category = streamerInfo.game?.trim();
    if (!category || !this.databaseStorage?.isReady()) {
      return;
    }

    const sessionKey = this.activeStreamSessionKeys.get(streamerInfo.username);
    if (!sessionKey) {
      return;
    }

    this.databaseStorage.recordStreamSessionCategory(
      streamerInfo.username,
      sessionKey,
      category
    );
  }

  /**
   * Дожидается БД и подгружает агрегаты стримов за 30 суток (для API дашборда)
   */
  private async loadStreamCountsFromDatabase(): Promise<void> {
    if (!this.databaseStorage) {
      return;
    }

    for (let attempt = 0; attempt < 100; attempt++) {
      if (this.databaseStorage.isReady()) {
        this.databaseStorage.dedupeStreamSessionTimestampAliases();
        const counts = this.databaseStorage.getStreamCountsLast30DaysByUsername();
        const categoryCounts = this.databaseStorage.getCategoryStreamCountsByUsername();
        const sessionStarts = this.databaseStorage.getStreamSessionStartsByUsernameByWindows();
        logger.verbose(
          `📊  Статистика стримов загружена из БД (${counts.size} стримеров с записями, ${categoryCounts.size} с категориями, ${sessionStarts.size} с датами стримов)`
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    logger.verbose('ℹ️  База данных недоступна — счётчик стримов (30д) не загружен');
  }

  /**
   * Сохраняет время окончания стрима в БД (WebSocket и GraphQL fallback)
   */
  private persistLastStreamEnd(username: string, timestamp: number): void {
    if (this.databaseStorage?.isReady()) {
      this.databaseStorage.updateLastStreamEnd(username, timestamp);
    }
  }

  /**
   * Проверяет статус всех стримеров с graceful degradation
   */
  private async checkStreamersStatus(): Promise<void> {
    this.finalizeExpiredOfflineGraces();

    for (const streamerInfo of this.streamers.values()) {
      try {
        const wasOnline = streamerInfo.isOnline;
        const wasBriefOfflinePending = canResumeFromBriefOffline(streamerInfo);
        const previousGame = streamerInfo.game;
        await this.twitchAPI.updateStreamerInfo(streamerInfo);
        
        // Сохраняем категорию в БД при изменении
        this.saveGameToDatabaseIfChanged(streamerInfo, previousGame);

        if (!wasOnline && streamerInfo.isOnline) {
          if (wasBriefOfflinePending || canResumeFromBriefOffline(streamerInfo)) {
            if (canResumeFromBriefOffline(streamerInfo)) {
              await this.resumeFromBriefOffline(streamerInfo, 'status-check');
            } else {
              logger.verbose(
                `🥳  [${streamerInfo.username}] Краткий офлайн завершён (GraphQL), сессия без сброса`
              );
              this.recordLastOnlineTransition(streamerInfo.username, Date.now());
              this.ensureWatchSessionStarted(streamerInfo);
            }
            continue;
          }
          // Стример перешел из офлайн в онлайн
          logger.info(`🥳  [${streamerInfo.username}] is now ONLINE - starting watch`);
          const streamStartTime = Date.now();
          this.recordLastOnlineTransition(streamerInfo.username, streamStartTime);
          this.flushStreamPointsEarnedToDatabase(streamerInfo);
          this.resetStreamSessionPoints(streamerInfo);
          streamerInfo.startTime = streamStartTime;
          streamerInfo.webSocketOnlineAt = streamStartTime;
          this.persistLastStreamStart(streamerInfo.username, streamStartTime);

          this.persistStreamSession(
            streamerInfo.username,
            streamStartTime,
            streamerInfo.broadcastId
          );
          this.beginStreamSessionCategoryTracking(streamerInfo, streamStartTime);
          
          try {
            await this.updateInitialPoints(streamerInfo);
          } catch (error: any) {
            // Graceful degradation: если не удалось обновить баллы, продолжаем
            logger.warn(`⚠️  [${streamerInfo.username}] Failed to update initial points: ${error.message || error}`);
          }
          
          // Создаем сессию просмотра для статистики
          if (this.statisticsStorage && streamerInfo.initialChannelPoints !== null) {
            const sessionId = this.statisticsStorage.createSession(
              streamerInfo.username,
              streamerInfo.initialChannelPoints,
              streamerInfo.game,
              streamerInfo.title
            );
            this.activeSessions.set(streamerInfo.username, sessionId);
          }
          
          // Добавляем начальную точку в историю баллов
          const stats = this.getStatistics();
          const totalPoints = stats.reduce((sum, stat) => sum + stat.pointsEarned, 0);
          this.addPointsHistory(streamerInfo.username, 0, totalPoints);
        this.ensureWatchSessionStarted(streamerInfo);
      } else if (wasOnline && !streamerInfo.isOnline) {
          this.beginTentativeOffline(streamerInfo, 'status-check');
        } else if (!wasOnline && !streamerInfo.isOnline && shouldFinalizeOffline(streamerInfo)) {
          this.finalizeStreamerOffline(streamerInfo, 'status-check');
        }
      } catch (error: any) {
        // Graceful degradation: при ошибке проверки статуса изолируем этого стримера и продолжаем с остальными
        logger.warn(`⚠️  [${streamerInfo.username}] Error checking status: ${error.message || error}`);
        logger.verbose(`ℹ️  [${streamerInfo.username}] Continuing with last known status`);
      }
    }
  }

  /**
   * Запускает health check server
   */
  private startHealthCheckServer(): void {
    const port = process.env.HEALTH_CHECK_PORT ? parseInt(process.env.HEALTH_CHECK_PORT, 10) : 3000;
    
    const providers: HealthCheckProviders = {
      checkWebSocket: async () => {
        if (!this.wsManager) {
          return {
            status: ComponentStatus.UNKNOWN,
            message: 'WebSocket manager not initialized',
            lastCheck: Date.now()
          };
        }

        const isConnected = this.wsManager.isConnected();
        const state = this.wsManager.getConnectionState();
        const hasCriticalErrors = this.wsManager.hasCriticalErrors();
        const lastCriticalError = this.wsManager.getLastCriticalError();
        const criticalErrors = this.wsManager.getCriticalErrors();

        // DNS/сеть — degraded (UNKNOWN), не unhealthy: процесс не должен завершаться из-за кратковременного офлайна
        if (hasCriticalErrors && lastCriticalError) {
          const isTransient =
            isTransientNetworkErrorCode(lastCriticalError.code) ||
            lastCriticalError.code === 'MAX_RECONNECT_ATTEMPTS';

          return {
            status: isTransient ? ComponentStatus.UNKNOWN : ComponentStatus.UNHEALTHY,
            message: isTransient
              ? `Временная проблема WebSocket: ${lastCriticalError.error}`
              : `Критическая ошибка WebSocket: ${lastCriticalError.error} (код: ${lastCriticalError.code})`,
            lastCheck: Date.now(),
            details: {
              state,
              isConnected,
              hasCriticalErrors: true,
              transient: isTransient,
              lastCriticalError: {
                timestamp: lastCriticalError.timestamp,
                error: lastCriticalError.error,
                code: lastCriticalError.code,
              },
              criticalErrorsCount: criticalErrors.length,
            },
          };
        }

        if (!isConnected) {
          const wsActive = this.wsManager.isActive();
          return {
            status: ComponentStatus.UNKNOWN,
            message: wsActive
              ? `WebSocket переподключается (state: ${state})`
              : `WebSocket не подключен (state: ${state})`,
            lastCheck: Date.now(),
            details: {
              state,
              isConnected,
              wsActive,
              hasCriticalErrors: false,
            },
          };
        }

        // Все в порядке
        return {
          status: ComponentStatus.HEALTHY,
          message: `WebSocket подключен (state: ${state})`,
          lastCheck: Date.now(),
          details: {
            state,
            isConnected,
            hasCriticalErrors: false
          }
        };
      },
      checkAPI: async () => {
        try {
          // Проверяем доступность через GraphQL endpoint (который реально используется приложением)
          // GraphQL требует POST запросы, но для проверки доступности можно использовать простой запрос
          // Или проверять, что сервер отвечает (даже 405 означает, что сервер доступен)
          const response = await fetch(GQL_URL, {
            method: 'POST',
            headers: {
              'Client-ID': CLIENT_ID,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: '{ __typename }' }), // Минимальный GraphQL запрос
          });

          // Любой HTTP ответ (кроме сетевых ошибок) означает, что API доступен
          // 200 - успешный ответ (API работает)
          // 400/401 - сервер доступен, но запрос неверный (это нормально для проверки доступности)
          // 500+ - проблемы с сервером, но сервер все равно доступен и отвечает
          // Только сетевые ошибки (catch блок) означают, что API недоступен
          const isAvailable = response.status < 600; // Любой валидный HTTP статус
          
          return {
            status: isAvailable ? ComponentStatus.HEALTHY : ComponentStatus.UNHEALTHY,
            message: `Twitch GraphQL API status: ${response.status}`,
            lastCheck: Date.now(),
            details: {
              statusCode: response.status,
              endpoint: 'gql.twitch.tv',
              available: isAvailable
            }
          };
        } catch (error: any) {
          if (isNetworkError(error)) {
            return {
              status: ComponentStatus.UNKNOWN,
              message: `Twitch API temporarily unreachable: ${error.message || error}`,
              lastCheck: Date.now()
            };
          }
          return {
            status: ComponentStatus.UNHEALTHY,
            message: `API check failed: ${error.message || error}`,
            lastCheck: Date.now()
          };
        }
      },
      checkToken: async () => {
        try {
          // Сначала проверяем, был ли токен принудительно помечен как невалидный
          if (this.tokenManager && this.tokenManager.isTokenManuallyMarkedInvalid()) {
            return {
              status: ComponentStatus.UNHEALTHY,
              message: 'Token manually marked as invalid (for testing)',
              lastCheck: Date.now(),
              details: {
                manuallyMarkedInvalid: true
              }
            };
          }

          // Проверяем последний результат валидации из TokenManager
          if (this.tokenManager) {
            const lastResult = this.tokenManager.getLastValidationResult();
            if (lastResult && !lastResult.isValid) {
              if (lastResult.errorType === 'network') {
                return {
                  status: ComponentStatus.UNKNOWN,
                  message: 'Token check skipped: network error (token not marked invalid)',
                  lastCheck: Date.now(),
                  details: { lastValidationResult: lastResult }
                };
              }
              return {
                status: ComponentStatus.UNHEALTHY,
                message: 'Token validation failed (from last check)',
                lastCheck: Date.now(),
                details: {
                  lastValidationResult: lastResult
                }
              };
            }
          }

          const validation = await this.twitchAPI.validateTokenWithInfo();
          if (validation.isValid) {
            return {
              status: ComponentStatus.HEALTHY,
              message: 'Token is valid',
              lastCheck: Date.now()
            };
          }
          if (validation.errorType === 'network') {
            return {
              status: ComponentStatus.UNKNOWN,
              message: 'Token check failed due to network (token not marked invalid)',
              lastCheck: Date.now(),
              details: { errorType: 'network' }
            };
          }
          return {
            status: ComponentStatus.UNHEALTHY,
            message: 'Token validation failed',
            lastCheck: Date.now()
          };
        } catch (error: any) {
          if (isNetworkError(error)) {
            return {
              status: ComponentStatus.UNKNOWN,
              message: `Token check network error: ${error.message || error}`,
              lastCheck: Date.now()
            };
          }
          return {
            status: ComponentStatus.UNHEALTHY,
            message: `Token check error: ${error.message || error}`,
            lastCheck: Date.now()
          };
        }
      },
      checkWatching: async () => {
        const onlineStreamers = Array.from(this.streamers.values()).filter(s => s.isOnline);
        const activeWatches = onlineStreamers.filter(s => s.startTime > 0);

        return {
          status: activeWatches.length > 0 ? ComponentStatus.HEALTHY : ComponentStatus.UNKNOWN,
          message: `${activeWatches.length} active watch(es), ${onlineStreamers.length} online streamer(s)`,
          lastCheck: Date.now(),
          details: {
            activeWatches: activeWatches.length,
            onlineStreamers: onlineStreamers.length,
            totalStreamers: this.streamers.size
          }
        };
      },
      getMetrics: async () => {
        const activeWatches = this.getActiveWatchCount();
        const stats = this.getStatistics();
        const totalPointsEarned = stats.reduce((sum, stat) => sum + stat.pointsEarned, 0);
        const lastActivity = stats.length > 0 
          ? Math.max(...stats.map(s => s.elapsedTime))
          : 0;

        return {
          activeWatches,
          totalPointsEarned,
          lastActivity,
          streamersCount: this.streamers.size
        };
      },
      getMode: () => 'api'
    };

    try {
      this.healthCheckServer = new HealthCheckServer(port, providers);
      this.healthCheckServer.start();
      logger.verbose(`🏥  Health check server initialization completed`);
    } catch (error: any) {
      logger.error(`❌  Failed to start health check server: ${error.message || error}`);
      // Не прерываем работу приложения, если healthcheck не запустился
    }
  }

  /**
   * Запускает мониторинг healthcheck статуса и завершает процесс при unhealthy
   */
  private startHealthCheckMonitoring(): void {
    if (!shouldAutoExitOnUnhealthy()) {
      logger.info(
        'ℹ️  Авто-завершение при unhealthy отключено (Termux/локальный запуск или AUTO_EXIT_ON_UNHEALTHY=false)'
      );
      return;
    }

    logger.verbose('ℹ️  Health check auto-exit enabled (AUTO_EXIT_ON_UNHEALTHY=true)');

    const checkInterval = 10000; // Проверяем каждые 10 секунд
    const monitoringStartDelayMs = 20000; // Даём health-серверу подняться до первой проверки
    const startupGraceMs = 90000; // После старта не завершаем процесс из-за недоступности /health
    const monitoringStartedAt = Date.now();
    let consecutiveUnhealthyCount = 0;
    const maxUnhealthyCount = 3; // Завершаем после 3 неудачных проверок подряд (~30 с)

    const runCheck = async () => {
      const inStartupGrace = Date.now() - monitoringStartedAt < startupGraceMs;
      try {
        const port = process.env.HEALTH_CHECK_PORT ? parseInt(process.env.HEALTH_CHECK_PORT, 10) : 3000;
        const host = process.env.HEALTH_CHECK_HOST || '127.0.0.1';
        // Используем таймаут для fetch (совместимо с Node.js 18+)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(`http://${host}:${port}/health`, {
          method: 'GET',
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) {
          // HTTP статус не 200 (может быть 503 при unhealthy)
          consecutiveUnhealthyCount++;
          logger.warn(`⚠️  Health check returned status ${response.status} (unhealthy count: ${consecutiveUnhealthyCount})`);
          
          if (!inStartupGrace && consecutiveUnhealthyCount >= maxUnhealthyCount) {
            logFatalExit('HealthCheckMonitor', `Health check HTTP status ${response.status}`);
            logger.error('🛑  Health check is unhealthy for too long. Shutting down...');
            this.stop();
            process.exit(1);
          }
          return;
        }

        const report = await response.json();
        if (report.status === 'unhealthy') {
          consecutiveUnhealthyCount++;
          logger.warn(`⚠️  Health check report shows unhealthy status (unhealthy count: ${consecutiveUnhealthyCount})`);
          
          if (!inStartupGrace && consecutiveUnhealthyCount >= maxUnhealthyCount) {
            logFatalExit('HealthCheckMonitor', 'Health check report status unhealthy');
            logger.error('🛑  Health check is unhealthy for too long. Shutting down...');
            this.stop();
            process.exit(1);
          }
        } else {
          // Статус healthy или degraded - сбрасываем счетчик
          if (consecutiveUnhealthyCount > 0) {
            logger.verbose(`✅  Health check recovered (status: ${report.status})`);
            consecutiveUnhealthyCount = 0;
          }
        }
      } catch (error: any) {
        consecutiveUnhealthyCount++;
        if (inStartupGrace) {
          logger.verbose(`⚠️  Health check not ready yet: ${error.message || error}`);
          return;
        }
        logger.warn(`⚠️  Health check monitoring error: ${error.message || error} (unhealthy count: ${consecutiveUnhealthyCount})`);
        
        if (consecutiveUnhealthyCount >= maxUnhealthyCount) {
          logFatalExit('HealthCheckMonitor', `Health check monitoring error: ${error.message || error}`);
          logger.error('🛑  Health check server is unavailable. Shutting down...');
          this.stop();
          process.exit(1);
        }
      }
    };

    setTimeout(() => {
      runSafeAsync('health-check-monitor', () => runCheck());
      this.healthCheckMonitorInterval = setSafeAsyncInterval('health-check-monitor', () => runCheck(), checkInterval);
    }, monitoringStartDelayMs);

    logger.verbose(
      `🔍  Health check monitoring scheduled (delay: ${monitoringStartDelayMs}ms, interval: ${checkInterval}ms, grace: ${startupGraceMs}ms)`
    );
  }

  /**
   * Запускает веб-сервер для dashboard (с retry при занятом порте)
   */
  private async startWebServer(): Promise<void> {
    const port = process.env.WEB_SERVER_PORT ? parseInt(process.env.WEB_SERVER_PORT, 10) : 3001;

    if (!this.webServer) {
      this.webServer = new WebServer(port);
    }

    this.webServer.setStatisticsProvider(this);

    if (this.webServer.isRunning()) {
      return;
    }

    const started = await this.webServer.startWithRetry();
    if (started) {
      if (this.webServerRetryTimer) {
        clearTimeout(this.webServerRetryTimer);
        this.webServerRetryTimer = null;
      }
      return;
    }

    this.scheduleWebServerRetry();
  }

  /**
   * Планирует фоновый повтор запуска веб-сервера, если порт был занят
   */
  private scheduleWebServerRetry(): void {
    if (this.webServerRetryTimer || !this.isRunning) {
      return;
    }

    const delayMs = parseInt(process.env.WEB_SERVER_BACKGROUND_RETRY_DELAY_MS || '30000', 10);
    logger.warn(
      `⚠️  Dashboard недоступен — watcher продолжит работу, повтор запуска веб-сервера через ${delayMs / 1000}s`
    );

    this.webServerRetryTimer = setTimeout(() => {
      this.webServerRetryTimer = null;
      runSafeAsync('web-server-retry', async () => {
        if (!this.isRunning || !this.webServer || this.webServer.isRunning()) {
          return;
        }

        const started = await this.webServer.startWithRetry({ maxAttempts: 3 });
        if (started) {
          logger.info('✅  Web server started after background retry');
          return;
        }

        this.scheduleWebServerRetry();
      });
    }, delayMs);
  }

  /**
   * Добавляет событие в историю
   * @param type Тип события
   * @param streamer Имя стримера
   * @param message Сообщение
   */
  private addEvent(type: string, streamer: string, message: string): void {
    const entry = {
      timestamp: Date.now(),
      type,
      streamer,
      message,
    };
    this.eventsHistory.push(entry);

    // Ограничиваем размер истории
    if (this.eventsHistory.length > this.maxEventsHistory) {
      this.eventsHistory.shift();
    }

    publishDashboardHubEvent(entry);
  }

  /**
   * Сохраняет время просмотра в базу данных при завершении сессии
   * @param streamerName Имя стримера
   * @param sessionId ID сессии
   */
  private saveWatchTimeToDatabase(streamerName: string, sessionId: string): void {
    if (!this.databaseStorage || !this.statisticsStorage) return;

    try {
      const sessions = this.statisticsStorage.getSessions(streamerName, 1);
      const session = sessions.find(s => s.id === sessionId);
      
      if (session) {
        const watchTime = session.duration || (Date.now() - session.startTime);
        if (watchTime > 0) {
          this.databaseStorage.addWatchTime(streamerName, watchTime);
        }
      }
    } catch (error: any) {
      logger.warn(`⚠️  Failed to save watch time to database: ${error.message || error}`);
    }
  }

  /**
   * Добавляет запись в историю баллов
   * @param streamer Имя стримера
   * @param points Количество заработанных баллов
   * @param totalPoints Общее количество заработанных баллов
   */
  private addPointsHistory(streamer: string, points: number, totalPoints: number): void {
    this.pointsHistory.push({
      timestamp: Date.now(),
      streamer,
      points,
      totalPoints
    });

    // Ограничиваем размер истории
    if (this.pointsHistory.length > this.maxPointsHistory) {
      this.pointsHistory.shift();
    }
  }

  /**
   * Инициализирует начальные точки в истории баллов для всех онлайн стримеров
   */
  private initializePointsHistory(): void {
    const stats = this.getStatistics();
    const totalPoints = stats.reduce((sum, stat) => sum + stat.pointsEarned, 0);
    
    // Добавляем начальную точку для каждого активного стримера
    for (const stat of stats) {
      this.addPointsHistory(stat.streamerName, 0, totalPoints);
    }
    
    // Если нет активных стримеров, добавляем общую точку
    if (stats.length === 0) {
      this.addPointsHistory('system', 0, 0);
    }
  }

  /**
   * Сбрасывает кэш integrity во всех GraphQL-клиентах процесса
   */
  invalidateIntegrityProviders(): void {
    this.graphqlClient?.getIntegrityProvider().invalidate();
    this.twitchAPI.invalidateIntegrityCache();
  }

  /**
   * Снимок здоровья бота для dashboard (/api/bot-health)
   */
  getBotHealth(): BotHealthSnapshot {
    const { semver, revision, label } = getAppVersionParts();
    const graphqlClient = this.graphqlClient;

    const integrity = graphqlClient
      ? graphqlClient.getIntegrityProvider().getHealthSnapshot()
      : (() => {
          const manual = getManualIntegrityFromEnv();
          const now = Date.now();
          const expiresAtMs = manual?.expiresAtMs ?? null;
          const base = {
            source: resolveIntegritySource(),
            configured: Boolean(manual?.token),
            valid: manual ? now < manual.expiresAtMs - 60_000 : false,
            expiresAtMs,
            expiresInMs:
              expiresAtMs != null && expiresAtMs > now ? expiresAtMs - now : expiresAtMs != null ? 0 : null,
            fallbackApiEnabled: allowApiIntegrityFallback(),
            deviceIdPrefix: (process.env.TWITCH_DEVICE_ID?.trim() || '—').slice(0, 8),
          };
          const lastUpdated = resolveLastIntegrityUpdatedAt(
            getLastIntegrityCaptureAt(),
            base.expiresAtMs,
            now
          );
          const tokenDisplay = getIntegrityTokenDisplay();
          return {
            ...base,
            lastUpdatedAtMs: lastUpdated.atMs,
            lastUpdatedAtEstimated: lastUpdated.estimated,
            bonusClaim: deriveIntegrityBonusClaimStatus(base, [], null),
            tokenPreviousPrefix: tokenDisplay.previousPrefix,
            tokenCurrentPrefix: tokenDisplay.currentPrefix,
          };
        })();

    const websocket = this.wsManager
      ? this.wsManager.getHealthSnapshot()
      : {
          status: 'stopped' as const,
          connectionState: 'CLOSED',
          reconnectAttempt: 0,
          maxReconnectAttempts: 0,
          hasCriticalErrors: false,
          lastCriticalError: null,
        };

    const graphql = graphqlClient
      ? graphqlClient.getHealthSnapshot()
      : { circuitBreaker: 'CLOSED' as const, hadRecentNetworkFailure: false };

    const claimByStreamer = [...this.claimHealthRecent];

    const lastUpdated = resolveLastIntegrityUpdatedAt(
      getLastIntegrityCaptureAt(),
      integrity.expiresAtMs
    );
    const tokenDisplay = getIntegrityTokenDisplay();
    const enrichedIntegrity = {
      ...integrity,
      lastUpdatedAtMs: lastUpdated.atMs,
      lastUpdatedAtEstimated: lastUpdated.estimated,
      bonusClaim: deriveIntegrityBonusClaimStatus(
        integrity,
        claimByStreamer,
        this.lastIntegrityFailure
      ),
      tokenPreviousPrefix: tokenDisplay.previousPrefix,
      tokenCurrentPrefix: tokenDisplay.currentPrefix,
    };

    return {
      timestamp: Date.now(),
      appVersion: label,
      appSemver: semver,
      gitRevision: revision,
      watcherRunning: this.isRunning,
      websocket,
      integrity: enrichedIntegrity,
      gqlContext: getGqlContextHealthSnapshot(),
      graphql,
      lastIntegrityFailure: this.lastIntegrityFailure
        ? { ...this.lastIntegrityFailure }
        : null,
      claimByStreamer,
    };
  }

  // Реализация интерфейса StatisticsProvider

  /**
   * Получает информацию о всех стримерах (реализация StatisticsProvider)
   */
  getStreamersInfo(): Array<{
    username: string;
    isOnline: boolean;
    channelPoints: number;
    startTime: number;
  }> {
    return Array.from(this.streamers.values()).map(s => ({
      username: s.username,
      isOnline: s.isOnline,
      channelPoints: s.channelPoints,
      startTime: s.startTime
    }));
  }

  /**
   * Получает общую статистику (реализация StatisticsProvider)
   */
  getOverallStats(): {
    activeWatches: number;
    totalPointsEarned: number;
    lastActivity: number;
    lastOnlineStreamer: string | null;
    streamersCount: number;
  } {
    const now = Date.now();
    let totalPointsEarned = 0;

    for (const info of this.streamers.values()) {
      if (isEffectivelyOnline(info)) {
        this.ensureWatchSessionStarted(info);
        totalPointsEarned += this.getPointsEarnedForDisplay(info);
      }
    }

    const activeWatches = this.getActiveWatchCount();

    let lastActivity = 0;
    let lastOnlineStreamer: string | null = null;
    if (this.lastOnlineTransition) {
      lastOnlineStreamer = this.lastOnlineTransition.username;
      lastActivity = Math.max(0, now - this.lastOnlineTransition.at);
    }

    return {
      activeWatches,
      totalPointsEarned,
      lastActivity,
      lastOnlineStreamer,
      streamersCount: this.streamers.size,
    };
  }

  /**
   * Получает историю событий (реализация StatisticsProvider)
   */
  getEventsHistory(): Array<{
    timestamp: number;
    type: string;
    streamer: string;
    message: string;
  }> {
    return [...this.eventsHistory].reverse(); // Новые события первыми
  }

  /**
   * Получает историю баллов (реализация StatisticsProvider)
   */
  getPointsHistory(): Array<{
    timestamp: number;
    streamer: string;
    points: number;
    totalPoints: number;
  }> {
    return [...this.pointsHistory]; // Хронологический порядок
  }

  /**
   * Добавляет критическое уведомление
   * @param type Тип уведомления
   * @param title Заголовок
   * @param message Сообщение
   */
  private addCriticalNotification(type: 'error' | 'warning', title: string, message: string): void {
    const notification = {
      id: `critical_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type,
      title,
      message,
      timestamp: Date.now(),
    };

    this.criticalNotifications.push(notification);

    // Ограничиваем размер списка
    if (this.criticalNotifications.length > this.maxCriticalNotifications) {
      this.criticalNotifications.shift();
    }

    logger.warn(`🚨  Critical notification: ${title} - ${message}`);
  }

  /**
   * Получает критические уведомления (реализация StatisticsProvider)
   */
  getCriticalNotifications(): Array<{
    id: string;
    type: 'error' | 'warning';
    title: string;
    message: string;
    timestamp: number;
  }> {
    return [...this.criticalNotifications].reverse(); // Новые первыми
  }

  /**
   * Удаляет критическое уведомление по ID
   * @param id ID уведомления
   */
  dismissCriticalNotification(id: string): void {
    this.criticalNotifications = this.criticalNotifications.filter(n => n.id !== id);
  }

  /**
   * Добавляет тестовое критическое уведомление (для тестирования)
   * @param type Тип уведомления
   */
  addTestCriticalNotification(type: 'error' | 'warning' = 'error'): void {
    if (type === 'error') {
      this.addCriticalNotification(
        'error',
        'Test Error Notification',
        'This is a test error notification. Your application is working correctly!'
      );
    } else {
      this.addCriticalNotification(
        'warning',
        'Test Warning Notification',
        'This is a test warning notification. Your application is working correctly!'
      );
    }
  }

  /**
   * Получает модуль сохранения статистики
   * @returns StatisticsStorage или null
   */
  getStatisticsStorage(): StatisticsStorage | null {
    return this.statisticsStorage;
  }

  /**
   * Получает модуль базы данных
   * @returns DatabaseStorage или null
   */
  getDatabaseStorage(): DatabaseStorage | null {
    return this.databaseStorage;
  }

  /**
   * Обновляет статус инициализации
   * @param currentAction Текущее действие
   * @param progress Прогресс (0-100)
   */
  private updateInitializationStatus(currentAction: string, progress: number): void {
    this.initializationStatus.currentAction = currentAction;
    this.initializationStatus.progress = Math.min(100, Math.max(0, progress));
    if (this.initializationStatus.progress >= 100) {
      this.initializationStatus.isInitialized = true;
    }
  }

  /**
   * Получает статус инициализации
   * @returns Статус инициализации
   */
  getInitializationStatus(): {
    isInitialized: boolean;
    currentAction: string;
    progress: number;
  } {
    return { ...this.initializationStatus };
  }

  /**
   * Получает информацию о токене (реализация StatisticsProvider)
   */
  getTokenInfo(): {
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
  } | null {
    if (!this.tokenManager) {
      return null;
    }

    const validationResult = this.tokenManager.getLastValidationResult();
    if (!validationResult) {
      // TokenManager ещё не проверял или проверка не завершена — опираемся на успешный старт
      if (this.validatedUserId) {
        return {
          isValid: true,
          status: 'valid',
          tokenInfo: {
            client_id: '',
            user_id: this.validatedUserId,
          },
        };
      }
      return {
        isValid: false,
        status: 'unknown',
      };
    }

    if (!validationResult.isValid) {
      if (validationResult.errorType === 'network') {
        return {
          isValid: false,
          status: 'unknown'
        };
      }
      return {
        isValid: false,
        status: 'invalid'
      };
    }

    if (!validationResult.expiresAt) {
      return {
        isValid: true,
        status: 'valid'
      };
    }

    const now = Date.now();
    const expiresAt = validationResult.expiresAt;
    const msRemaining = expiresAt - now;

    if (msRemaining <= 0) {
      return {
        isValid: false,
        expiresAt,
        status: 'expired'
      };
    }

    const minutesRemaining = Math.floor(msRemaining / 1000 / 60);
    const hoursRemaining = Math.floor(minutesRemaining / 60);
    const daysRemaining = Math.floor(hoursRemaining / 24);

    return {
      isValid: true,
      expiresAt,
      minutesRemaining,
      hoursRemaining,
      daysRemaining,
      status: 'valid',
      tokenInfo: validationResult.tokenInfo ? {
        client_id: validationResult.tokenInfo.client_id,
        login: validationResult.tokenInfo.login,
        user_id: validationResult.tokenInfo.user_id,
        scopes: validationResult.tokenInfo.scopes
      } : undefined
    };
  }

  /**
   * Помечает токен как невалидный (для тестирования перезапуска контейнера)
   */
  markTokenAsInvalid(): void {
    if (this.tokenManager) {
      this.tokenManager.markTokenAsInvalid();
      logger.warn('⚠️  Token marked as invalid via API (for testing)');
    }
  }

  /**
   * Добавляет стримера для отслеживания
   * @param username Имя стримера
   * @returns Результат операции
   */
  async addStreamer(username: string): Promise<{ success: boolean; message: string }> {
    // Нормализуем имя стримера (убираем пробелы, приводим к нижнему регистру)
    const normalizedUsername = username.trim().toLowerCase();
    
    if (!normalizedUsername) {
      return { success: false, message: 'Username cannot be empty' };
    }

    // Проверяем, не добавлен ли уже стример
    if (this.streamers.has(normalizedUsername)) {
      const existingStreamer = this.streamers.get(normalizedUsername);
      const status = existingStreamer?.isOnline ? 'ONLINE' : 'OFFLINE';
      logger.warn(`⚠️  Attempted to add already tracked streamer: ${normalizedUsername} (${status})`);
      return { 
        success: false, 
        message: `Streamer "${normalizedUsername}" is already being tracked (Status: ${status})` 
      };
    }

    try {
      logger.info(`➕  Adding streamer: ${normalizedUsername}`);
      
      // Сначала проверяем существование стримера через GraphQL клиент
      const graphqlClient = new GraphQLClient(this.authToken, this.userAgent);
      const channelId = await graphqlClient.getChannelId(normalizedUsername);
      if (!channelId) {
        logger.error(`❌  Streamer ${normalizedUsername} not found`);
        return { success: false, message: `Streamer "${normalizedUsername}" not found. Please check the username and try again.` };
      }

      // Инициализируем стримера (теперь мы знаем, что он существует)
      const streamerInfo = await this.twitchAPI.initializeStreamer(normalizedUsername);
      
      if (!streamerInfo) {
        // Если инициализация не удалась, но канал существует, это временная проблема
        logger.warn(`⚠️  [${normalizedUsername}] Failed to initialize, but channel exists. This might be a temporary issue.`);
        return { success: false, message: `Failed to initialize streamer "${normalizedUsername}". This might be a temporary issue. Please try again later.` };
      }

      // Загружаем данные из базы данных перед добавлением
      this.loadStreamerDataFromDatabase(streamerInfo);
      this.applyPersistedPoints(streamerInfo);
      this.restoreWatchSessionAfterRestart(streamerInfo);

      // Стример успешно инициализирован
      this.streamers.set(normalizedUsername, streamerInfo);
      
      // Добавляем в WebSocket менеджер
      if (this.wsManager) {
        this.wsManager.addStreamer(streamerInfo);
      }

      // Если стример онлайн, создаем сессию
      if (streamerInfo.isOnline) {
        logger.info(`✅  [${normalizedUsername}] Added - ONLINE`);
        
        if (this.statisticsStorage && streamerInfo.initialChannelPoints !== null) {
          const sessionId = this.statisticsStorage.createSession(
            streamerInfo.username,
            streamerInfo.initialChannelPoints,
            streamerInfo.game,
            streamerInfo.title
          );
          this.activeSessions.set(streamerInfo.username, sessionId);
        }
        this.ensureWatchSessionStarted(streamerInfo);
      } else {
        logger.info(`😴  [${normalizedUsername}] Added - OFFLINE`);
      }

      // Добавляем событие
      this.addEvent('streamer-added', normalizedUsername, `Streamer ${normalizedUsername} added to tracking`);

      // Сохраняем список стримеров в config.json
      this.saveStreamersToConfig();

      return { success: true, message: `Streamer ${normalizedUsername} added successfully` };
    } catch (error: any) {
      logger.error(`❌  Error adding streamer ${normalizedUsername}: ${error.message || error}`);
      return { success: false, message: `Failed to add streamer: ${error.message || 'Unknown error'}` };
    }
  }

  /**
   * Удаляет стримера из отслеживания
   * @param username Имя стримера
   * @returns Результат операции
   */
  async removeStreamer(username: string): Promise<{ success: boolean; message: string }> {
    const normalizedUsername = username.trim().toLowerCase();
    
    if (!this.streamers.has(normalizedUsername)) {
      return { success: false, message: `Streamer ${normalizedUsername} is not being tracked` };
    }

    try {
      logger.info(`➖  Removing streamer: ${normalizedUsername}`);
      
      const streamerInfo = this.streamers.get(normalizedUsername);
      
      // Завершаем активную сессию, если есть
      if (this.activeSessions.has(normalizedUsername)) {
        const sessionId = this.activeSessions.get(normalizedUsername);
        if (sessionId && this.statisticsStorage && streamerInfo) {
          const finalPoints = streamerInfo.channelPoints || streamerInfo.lastChannelPoints || 0;
          this.statisticsStorage.endSession(sessionId, finalPoints, 'interrupted');
          
          // Сохраняем время просмотра в базу данных
          this.saveWatchTimeToDatabase(normalizedUsername, sessionId);
        }
        this.activeSessions.delete(normalizedUsername);
      }

      // Удаляем из WebSocket менеджера
      if (this.wsManager && streamerInfo) {
        this.wsManager.removeStreamer(streamerInfo.channelId);
      }

      // Удаляем из Map
      this.streamers.delete(normalizedUsername);

      // Добавляем событие
      this.addEvent('streamer-removed', normalizedUsername, `Streamer ${normalizedUsername} removed from tracking`);

      // Сохраняем список стримеров в config.json
      this.saveStreamersToConfig();

      logger.info(`✅  [${normalizedUsername}] Removed successfully`);
      return { success: true, message: `Streamer ${normalizedUsername} removed successfully` };
    } catch (error: any) {
      logger.error(`❌  Error removing streamer ${normalizedUsername}: ${error.message || error}`);
      return { success: false, message: `Failed to remove streamer: ${error.message || 'Unknown error'}` };
    }
  }

  /**
   * Сохраняет список стримеров в config.json
   */
  private saveStreamersToConfig(): void {
    try {
      const streamersList = Array.from(this.streamers.keys());
      
      // Читаем существующий config.json или создаем новый
      let config: AppConfig = {};
      if (fs.existsSync(this.configPath)) {
        try {
          const configContent = fs.readFileSync(this.configPath, 'utf8');
          config = JSON.parse(configContent);
        } catch (error: any) {
          logger.warn(`⚠️  Failed to parse config.json: ${error.message}, creating new config`);
          config = {};
        }
      }

      // Обновляем список стримеров
      config.streamers = streamersList;

      // Сохраняем обратно в файл
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
      logger.verbose(`💾  Saved ${streamersList.length} streamers to config.json`);
    } catch (error: any) {
      logger.error(`❌  Error saving streamers to config: ${error.message || error}`);
    }
  }

  /**
   * Загружает список стримеров из config.json
   * @returns Список стримеров или null, если не удалось загрузить
   */
  static loadStreamersFromConfig(configPath: string = './config.json'): string[] | null {
    try {
      if (!fs.existsSync(configPath)) {
        return null;
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      const config: AppConfig = JSON.parse(configContent);

      if (config.streamers && Array.isArray(config.streamers)) {
        return config.streamers;
      }

      return null;
    } catch (error: any) {
      logger.error(`❌  Error loading streamers from config: ${error.message || error}`);
      return null;
    }
  }

  /**
   * Загружает сохраненное состояние баллов
   */
  private loadPointsState(): typeof this.pointsState {
    if (!this.pointsStatePath) return {};
    try {
      if (fs.existsSync(this.pointsStatePath)) {
        const raw = fs.readFileSync(this.pointsStatePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (error: any) {
      logger.warn(`⚠️  Failed to load points state: ${error.message || error}`);
    }
    return {};
  }

  /**
   * Сохраняет категорию стрима в базу данных при изменении
   * @param streamerInfo Информация о стримере
   * @param previousGame Предыдущая категория (для проверки изменения)
   */
  private saveGameToDatabaseIfChanged(streamerInfo: StreamerInfo, previousGame: string | null): void {
    if (!this.databaseStorage || !this.databaseStorage.isReady()) {
      return;
    }

    // Сохраняем категорию, если она изменилась и не пустая
    if (streamerInfo.game !== previousGame && streamerInfo.game) {
      this.databaseStorage.updateLastGame(streamerInfo.username, streamerInfo.game);
      if (streamerInfo.isOnline && this.activeStreamSessionKeys.has(streamerInfo.username)) {
        this.trackStreamCategoryForSession(streamerInfo);
      }
    }
  }

  /**
   * Загружает данные стримера из базы данных и применяет их
   * @param streamerInfo Информация о стримере
   */
  private loadStreamerDataFromDatabase(streamerInfo: StreamerInfo): void {
    if (!this.databaseStorage || !this.databaseStorage.isReady()) {
      return;
    }

    try {
      const dbStats = this.databaseStorage.getStreamerStats(streamerInfo.username);
      
      if (dbStats) {
        // Логируем информацию из БД
        logger.verbose(`📊  [${streamerInfo.username}] Loaded from DB: total_points=${dbStats.totalPoints}, watch_time=${dbStats.totalWatchTimeMs}ms`);
        
        if (dbStats.lastStreamStart) {
          logger.verbose(`📊  [${streamerInfo.username}] Last stream start: ${new Date(dbStats.lastStreamStart).toISOString()}`);
        }
        if (dbStats.lastStreamEnd) {
          logger.verbose(`📊  [${streamerInfo.username}] Last stream end: ${new Date(dbStats.lastStreamEnd).toISOString()}`);
        }
        if (dbStats.lastStreamDurationMs) {
          logger.verbose(
            `📊  [${streamerInfo.username}] Last stream duration: ${Math.round(dbStats.lastStreamDurationMs / 60_000)} min`
          );
        }
        if (dbStats.lastGame) {
          logger.verbose(`📊  [${streamerInfo.username}] Last game: ${dbStats.lastGame}`);
          // Загружаем последнюю категорию из БД, если текущая категория не установлена
          if (!streamerInfo.game && dbStats.lastGame) {
            streamerInfo.game = dbStats.lastGame;
          }
        }
        
        // Загружаем последний известный баланс из БД для офлайн стримеров
        if (dbStats.lastBalance !== null && dbStats.lastBalance !== undefined) {
          // Если channelPoints равен 0 (что часто бывает для офлайн стримеров),
          // используем значение из базы данных
          if (streamerInfo.channelPoints === 0 || streamerInfo.channelPoints === null) {
            streamerInfo.channelPoints = dbStats.lastBalance;
            streamerInfo.lastChannelPoints = dbStats.lastBalance;
            logger.verbose(`📊  [${streamerInfo.username}] Loaded last balance from DB: ${dbStats.lastBalance}`);
          }
        }
        
        // Начальные баллы = текущий баланс только для новой сессии (не при восстановлении из current-points.json)
        if (
          streamerInfo.channelPoints > 0 &&
          streamerInfo.initialChannelPoints === null &&
          !this.hasPersistedPointsSession(streamerInfo.username)
        ) {
          streamerInfo.initialChannelPoints = streamerInfo.channelPoints;
          logger.verbose(`📊  [${streamerInfo.username}] Set initial points from current balance: ${streamerInfo.channelPoints}`);
        }
      } else {
        logger.verbose(`📊  [${streamerInfo.username}] No database record found (will be created on first points earned)`);
      }
    } catch (error: any) {
      // Не критично - продолжаем работу без данных из БД
      logger.verbose(`⚠️  [${streamerInfo.username}] Failed to load from database: ${error.message || error}`);
    }
  }

  /**
   * Применяет сохраненное состояние баллов к стримеру
   */
  private applyPersistedPoints(streamerInfo: StreamerInfo): void {
    const saved = this.pointsState[streamerInfo.username];
    if (!saved) return;

    if (Number.isFinite(saved.channelPoints)) {
      streamerInfo.channelPoints = saved.channelPoints;
      streamerInfo.lastChannelPoints = saved.channelPoints;
    }
    if (Number.isFinite(saved.initialChannelPoints)) {
      streamerInfo.initialChannelPoints = saved.initialChannelPoints;
    }
    if (Number.isFinite(saved.streamPointsEarned)) {
      streamerInfo.streamPointsEarned = saved.streamPointsEarned;
    }
  }

  /**
   * Заполняет приложение тестовыми данными
   * @returns Результат операции с количеством созданных событий и стримеров
   */
  async fillTestData(): Promise<{ eventsCount: number; streamersCount: number }> {
    logger.info('🧪  Filling application with test data...');
    
    const testStreamers = [
      'test_streamer_1', 'test_streamer_2', 'test_streamer_3', 'test_streamer_4', 'test_streamer_5',
      'test_streamer_6', 'test_streamer_7', 'test_streamer_8', 'test_streamer_9', 'test_streamer_10'
    ];
    
    const eventTypes = [
      'points-earned', 'claim-earned', 'streak-earned', 'claim-success', 'claim-failed',
      'stream-up', 'stream-down', 'raid-joined', 'token-expired', 'websocket-reconnected'
    ];
    
    const messages = {
      'points-earned': ['Earned {points} points (WATCH_STREAK)', 'Earned {points} points (BONUS)', 'Earned {points} points (AD_WATCH)'],
      'claim-earned': ['Bonus chest available', 'Channel points bonus ready'],
      'streak-earned': ['Watch streak bonus earned'],
      'claim-success': ['Bonus chest claimed', 'Successfully claimed bonus'],
      'claim-failed': ['Failed to claim bonus', 'Bonus claim failed'],
      'stream-up': ['Stream went online', 'Stream started'],
      'stream-down': ['Stream went offline', 'Stream ended'],
      'raid-joined': ['Joined raid to {target}', 'Successfully joined raid'],
      'token-expired': ['Token has expired - please update it'],
      'websocket-reconnected': ['WebSocket connection restored']
    };
    
    let eventsCount = 0;
    let streamersCount = 0;
    const now = Date.now();
    
    // Добавляем тестовых стримеров
    for (const username of testStreamers) {
      if (!this.streamers.has(username)) {
        try {
          const isOnline = Math.random() > 0.5;
          const streamerInfo: StreamerInfo = {
            username,
            channelId: `test_${username}_${Date.now()}`,
            isOnline,
            channelPoints: Math.floor(Math.random() * 100000) + 1000,
            initialChannelPoints: Math.floor(Math.random() * 100000) + 1000,
            lastChannelPoints: null,
            streamPointsEarned: Math.floor(Math.random() * 500),
            startTime: isOnline ? now - Math.floor(Math.random() * 3600000) : 0,
            game: ['Just Chatting', 'Minecraft', 'Fortnite', 'Valorant', 'League of Legends'][Math.floor(Math.random() * 5)],
            title: `Test stream ${username}`,
            broadcastId: null,
            tags: [],
            spadeUrl: null
          };
          
          // Загружаем данные из базы данных
          this.loadStreamerDataFromDatabase(streamerInfo);
          this.applyPersistedPoints(streamerInfo);
          
          this.streamers.set(username, streamerInfo);
          
          // Добавляем в WebSocket менеджер, если он доступен
          if (this.wsManager) {
            this.wsManager.addStreamer(streamerInfo);
          }
          
          streamersCount++;
        } catch (error: any) {
          logger.warn(`⚠️  Failed to add test streamer ${username}: ${error.message || error}`);
        }
      }
    }
    
    // Генерируем около 1000 событий
    const targetEventsCount = 1000;
    const streamersList = Array.from(this.streamers.keys());
    
    if (streamersList.length === 0) {
      logger.warn('⚠️  No streamers available for generating test events');
      return { eventsCount: 0, streamersCount };
    }
    
    for (let i = 0; i < targetEventsCount; i++) {
      const streamer = streamersList[Math.floor(Math.random() * streamersList.length)];
      const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
      const typeMessages = messages[eventType as keyof typeof messages] || ['Test event'];
      const messageTemplate = typeMessages[Math.floor(Math.random() * typeMessages.length)];
      
      // Заменяем плейсхолдеры в сообщениях
      let message = messageTemplate;
      if (message.includes('{points}')) {
        message = message.replace('{points}', String(Math.floor(Math.random() * 1000) + 10));
      }
      if (message.includes('{target}')) {
        message = message.replace('{target}', streamersList[Math.floor(Math.random() * streamersList.length)]);
      }
      
      // Генерируем timestamp в диапазоне последних 7 дней
      const daysAgo = Math.random() * 7;
      const timestamp = now - (daysAgo * 24 * 60 * 60 * 1000);
      
      this.eventsHistory.push({
        timestamp: Math.floor(timestamp),
        type: eventType,
        streamer,
        message
      });
      
      eventsCount++;
      
      // Если событие связано с баллами, добавляем в историю баллов
      if (eventType === 'points-earned' || eventType === 'claim-earned' || eventType === 'streak-earned') {
        const points = Math.floor(Math.random() * 1000) + 10;
        const streamerInfo = this.streamers.get(streamer);
        if (streamerInfo) {
          // Обновляем баллы стримера
          streamerInfo.channelPoints = (streamerInfo.channelPoints || 0) + points;
          
          // Сохраняем в базу данных
          if (this.databaseStorage) {
            this.databaseStorage.addDailyPoints(streamer, points);
            this.databaseStorage.addTotalPoints(streamer, points);
          }
          
          // Добавляем в историю баллов
          const stats = this.getStatistics();
          const totalPoints = stats.reduce((sum, stat) => sum + stat.pointsEarned, 0);
          this.addPointsHistory(streamer, points, totalPoints + points);
        }
      }
    }
    
    // Ограничиваем размер истории событий
    if (this.eventsHistory.length > this.maxEventsHistory) {
      this.eventsHistory = this.eventsHistory.slice(-this.maxEventsHistory);
    }
    
    // Сортируем события по времени
    this.eventsHistory.sort((a, b) => a.timestamp - b.timestamp);
    
    // Сохраняем состояние
    this.savePointsState(true);
    
    logger.info(`✅  Test data generated: ${eventsCount} events, ${streamersCount} streamers`);
    
    return { eventsCount, streamersCount };
  }

  /**
   * Сохраняет текущее состояние баллов с троттлингом
   */
  private savePointsState(force: boolean = false): void {
    if (!this.pointsStatePath) return;
    const now = Date.now();
    if (!force && now - this.lastPointsStateSave < this.pointsStateSaveIntervalMs) {
      return;
    }

    try {
      const state: typeof this.pointsState = {};
      for (const [username, info] of this.streamers.entries()) {
        state[username] = {
          channelPoints: info.channelPoints ?? 0,
          initialChannelPoints: info.initialChannelPoints,
          lastChannelPoints: info.lastChannelPoints,
          streamPointsEarned: info.streamPointsEarned ?? 0,
          isOnline: info.isOnline,
          startTime: info.isOnline && info.startTime > 0 ? info.startTime : 0,
          broadcastId: info.isOnline ? info.broadcastId : null,
          updatedAt: now,
        };
      }

      fs.mkdirSync(path.dirname(this.pointsStatePath), { recursive: true });
      fs.writeFileSync(this.pointsStatePath, JSON.stringify(state, null, 2), 'utf8');
      this.pointsState = state;
      this.lastPointsStateSave = now;
    } catch (error: any) {
      logger.warn(`⚠️  Failed to save points state: ${error.message || error}`);
    }
  }
}

