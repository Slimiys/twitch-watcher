/**
 * Менеджер просмотра стримов в API-режиме
 */

import { TwitchAPI } from './TwitchAPI';
import { WebSocketManager, WebSocketEventHandler } from './WebSocketManager';
import { StreamerInfo, WatchStatistics } from './types';
import { GraphQLClient } from './GraphQLClient';
import { formatElapsedTime } from './utils';
import { logger } from './logger';
import dayjs from 'dayjs';
import { HealthCheckServer, ComponentStatus, ComponentHealth, HealthCheckProviders } from '../../health';
import { GQL_URL, CLIENT_ID } from './constants';
import { WebServer, StatisticsProvider } from '../../web';
import { TokenManager, TokenManagerConfig } from './TokenManager';
import { StatisticsStorage } from './StatisticsStorage';
import { loadStatisticsConfig } from './configLoader';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from '../../types';

/**
 * Менеджер просмотра стримов
 */
export class StreamWatcher {
  private twitchAPI: TwitchAPI;
  private wsManager: WebSocketManager | null = null;
  private streamers: Map<string, StreamerInfo> = new Map();
  private priorityChannels: string[];
  private isRunning = false;
  private watchInterval: NodeJS.Timeout | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private healthCheckMonitorInterval: NodeJS.Timeout | null = null;
  private authToken: string;
  private userAgent: string;
  private validatedUserId: string | null = null;
  private maxSimultaneousChannels: number;
  private healthCheckServer: HealthCheckServer | null = null;
  private webServer: WebServer | null = null;
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
  private activeSessions: Map<string, string> = new Map(); // Map<streamerName, sessionId>
  private processedRaids: Map<string, number> = new Map(); // Map<raidId, timestamp> - отслеживание обработанных рейдов
  private raidCooldownMs: number = 30000; // 30 секунд между попытками присоединения к рейду
  private configPath: string = './config.json'; // Путь к файлу конфигурации
  // Персистентное состояние баллов между рестартами
  private pointsStatePath: string | null = null;
  private pointsState: Record<string, {
    channelPoints: number;
    initialChannelPoints: number | null;
    lastChannelPoints: number | null;
    isOnline: boolean;
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
   */
  constructor(authToken: string, userAgent: string, priorityChannels: string[], maxSimultaneousChannels?: number) {
    this.authToken = authToken;
    this.userAgent = userAgent;
    this.priorityChannels = priorityChannels;
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
    
    logger.verbose(`📊  Max simultaneous channels: ${this.maxSimultaneousChannels}`);
    
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
              'Your Twitch token has expired. Please update it in config.json or .env file to continue watching streams.'
            );
            this.addEvent('token-expired', 'system', 'Token has expired - please update it');
          },
          onTokenInvalid: () => {
            logger.error('❌  Token is invalid! Application may stop working.');
            this.addCriticalNotification(
              'error',
              'Token Invalid',
              'Your Twitch token is invalid. Please update it in config.json or .env file to continue watching streams.'
            );
            this.addEvent('token-invalid', 'system', 'Token is invalid - please update it');
            
            // Если включено автоматическое завершение при невалидном токене, завершаем процесс
            const autoExitOnInvalidToken = process.env.AUTO_EXIT_ON_INVALID_TOKEN !== 'false';
            if (autoExitOnInvalidToken) {
              logger.warn('⚠️  Auto-exit on invalid token is enabled. Shutting down in 2 seconds...');
              // Даем время на сохранение данных и логирование (уменьшено до 2 секунд для быстрого перезапуска)
              setTimeout(() => {
                logger.error('🛑  Shutting down due to invalid token (will be restarted by Docker)');
                this.stop();
                // Завершаем процесс с кодом ошибки, чтобы Docker перезапустил контейнер
                process.exit(1);
              }, 2000);
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

    // Инициализируем WebSocket
    try {
      logger.verbose('🔌  Initializing WebSocket connection...');
      
      // Всегда получаем user ID из валидации токена (это правильный способ)
      // User ID нужен для WebSocket подписки на события текущего пользователя
      logger.verbose('Getting user ID from token validation...');
      const tokenValidation = await this.twitchAPI.validateTokenWithInfo();
      if (!tokenValidation.isValid || !tokenValidation.tokenInfo?.user_id) {
        logger.error('❌  Token validation failed or user_id not found');
        logger.error(`   Token valid: ${tokenValidation.isValid}`);
        logger.error(`   Token info: ${JSON.stringify(tokenValidation.tokenInfo || {})}`);
        throw new Error('Token is invalid or user_id not found in token validation');
      }
      const userId = tokenValidation.tokenInfo.user_id;
      this.twitchAPI.setValidatedUserId(userId);
      logger.info(`✅  User ID obtained from token validation: ${userId}`);
      
      const graphqlClient = new GraphQLClient(this.authToken, this.userAgent);
      
      const eventHandlers: WebSocketEventHandler = {
        onPointsEarned: (streamerInfo, points, reason) => {
          logger.info(`🚀  +${points} → ${streamerInfo.username} - Reason: ${reason}`);
          
          // Используем разные типы событий в зависимости от причины
          // CLAIM должен иметь свой тег, остальные - points-earned
          const eventType = reason === 'CLAIM' ? 'claim-earned' : 'points-earned';
          this.addEvent(eventType, streamerInfo.username, `Earned ${points} points (${reason})`);
          
          // Если сессия еще не создана, но initialChannelPoints установлен через WebSocket, создаем сессию
          // Это важно для случаев, когда GraphQL запрос не удался при инициализации
          if (!this.activeSessions.has(streamerInfo.username) && 
              streamerInfo.initialChannelPoints !== null && 
              streamerInfo.isOnline &&
              this.statisticsStorage) {
            // Создаем сессию с начальными баллами, которые были установлены через WebSocket
            const sessionId = this.statisticsStorage.createSession(
              streamerInfo.username,
              streamerInfo.initialChannelPoints,
              streamerInfo.game,
              streamerInfo.title
            );
            this.activeSessions.set(streamerInfo.username, sessionId);
            logger.verbose(`📊  [${streamerInfo.username}] Session created from WebSocket points update`);
          }
          
          // Обновляем активную сессию
          const sessionId = this.activeSessions.get(streamerInfo.username);
          if (this.statisticsStorage && sessionId && streamerInfo.channelPoints !== null) {
            this.statisticsStorage.updateSession(sessionId, streamerInfo.channelPoints);
          }
          
          // Добавляем в историю баллов
          const stats = this.getStatistics();
          const totalPoints = stats.reduce((sum, stat) => sum + stat.pointsEarned, 0);
          this.addPointsHistory(streamerInfo.username, points, totalPoints);
        this.savePointsState();
        },
        onClaimAvailable: async (streamerInfo, claimId) => {
          // Проверяем, доступен ли бонус для этого стримера перед попыткой собрать
          // Это предотвращает попытки собрать бонус для всех стримеров, когда он доступен только для одного
          try {
            const pointsInfo = await graphqlClient.getChannelPoints(streamerInfo.username);
            if (pointsInfo?.availableClaim?.id === claimId) {
              // Бонус действительно доступен для этого стримера
              logger.info(`🎁  [${streamerInfo.username}] Получено уведомление о доступном бонусе через WebSocket`);
              const success = await graphqlClient.claimBonus(streamerInfo.channelId, claimId);
              if (success) {
                logger.info(`✅  [${streamerInfo.username}] Бонус успешно собран через WebSocket!`);
                this.addEvent('claim-success', streamerInfo.username, 'Bonus chest claimed');
              } else {
                logger.verbose(`⚠️  [${streamerInfo.username}] Не удалось собрать бонус через WebSocket (возможно, уже собран)`);
                this.addEvent('claim-failed', streamerInfo.username, 'Failed to claim bonus');
              }
            } else {
              // Бонус не доступен для этого стримера - это нормально, просто пропускаем
              logger.verbose(`ℹ️  [${streamerInfo.username}] Бонус ${claimId} не доступен для этого стримера (доступен: ${pointsInfo?.availableClaim?.id || 'none'})`);
            }
          } catch (error: any) {
            // При ошибке проверки пробуем собрать бонус (fallback поведение)
            logger.verbose(`⚠️  [${streamerInfo.username}] Ошибка проверки доступности бонуса, пробуем собрать: ${error.message || error}`);
            const success = await graphqlClient.claimBonus(streamerInfo.channelId, claimId);
            if (success) {
              logger.info(`✅  [${streamerInfo.username}] Бонус успешно собран через WebSocket!`);
              this.addEvent('claim-success', streamerInfo.username, 'Bonus chest claimed');
            } else {
              logger.verbose(`⚠️  [${streamerInfo.username}] Не удалось собрать бонус через WebSocket`);
            }
          }
        },
        onStreamUp: async (streamerInfo) => {
          logger.info(`🥳  [${streamerInfo.username}] Stream went ONLINE`);
          streamerInfo.startTime = Date.now();
          this.addEvent('stream-up', streamerInfo.username, 'Stream went online');
          
          // Получаем начальные баллы
          await this.updateInitialPoints(streamerInfo);
          
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
          this.savePointsState();
        },
        onStreamDown: (streamerInfo) => {
          logger.info(`😴  [${streamerInfo.username}] Stream went OFFLINE`);
          this.addEvent('stream-down', streamerInfo.username, 'Stream went offline');
          
          // Завершаем сессию просмотра
          const sessionId = this.activeSessions.get(streamerInfo.username);
          if (this.statisticsStorage && sessionId) {
            const finalPoints = streamerInfo.lastChannelPoints ?? streamerInfo.channelPoints;
            this.statisticsStorage.endSession(sessionId, finalPoints, 'completed');
            this.activeSessions.delete(streamerInfo.username);
          }
          this.savePointsState();
        },
        onRaidAvailable: async (streamerInfo, raidId, targetLogin) => {
          const now = Date.now();
          const lastAttempt = this.processedRaids.get(raidId);
          
          // Проверяем, не пытались ли мы уже присоединиться к этому рейду недавно
          if (lastAttempt && (now - lastAttempt) < this.raidCooldownMs) {
            logger.verbose(`⏭️  [${streamerInfo.username}] Raid ${raidId} already processed recently, skipping`);
            return;
          }
          
          // Отмечаем, что мы обрабатываем этот рейд
          this.processedRaids.set(raidId, now);
          
          // Очищаем старые записи (старше 5 минут)
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
            // После успешного присоединения не нужно больше пытаться
          } else {
            logger.verbose(`ℹ️  [${streamerInfo.username}] Не удалось присоединиться к рейду (возможно, уже присоединились)`);
            // Не добавляем событие raid-failed для каждого неудачного запроса, чтобы не засорять лог
            // this.addEvent('raid-failed', streamerInfo.username, `Failed to join raid to ${targetLogin}`);
          }
        },
      };

      this.wsManager = new WebSocketManager(this.authToken, userId, graphqlClient, eventHandlers);
      await this.wsManager.start();
      this.wsManager.startPingInterval();
      
      // Сохраняем валидированный user_id для использования в payload
      this.validatedUserId = this.wsManager.getValidatedUserId();
      // Передаем валидированный user_id в TwitchAPI
      this.twitchAPI.setValidatedUserId(this.validatedUserId);
      logger.verbose(`✅  WebSocket initialized successfully (validated user_id: ${this.validatedUserId})`);
    } catch (error: any) {
      logger.error('❌  Failed to initialize WebSocket:', error.message || error);
      logger.warn('⚠️  Continuing without WebSocket - events will be sent via API only');
    }

    // Инициализируем стримеров
    await this.initializeStreamers();

    // Запускаем отправку событий просмотра
    this.startWatching();

    // Запускаем периодическую статистику
    this.startStatistics();
    
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
    this.startHealthCheckServer();
    
    // Запускаем веб-сервер
    this.startWebServer();
  }

  /**
   * Останавливает просмотр
   */
  stop(): void {
    this.isRunning = false;

    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    // Завершаем все активные сессии как прерванные
    if (this.statisticsStorage) {
      for (const [streamerName, sessionId] of this.activeSessions.entries()) {
        const streamerInfo = this.streamers.get(streamerName);
        if (streamerInfo) {
          const finalPoints = streamerInfo.lastChannelPoints ?? streamerInfo.channelPoints;
          this.statisticsStorage.endSession(sessionId, finalPoints, 'interrupted');
        }
      }
      this.activeSessions.clear();
      this.statisticsStorage.save();
      logger.verbose(`💾  All active sessions saved`);
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

    // Сохраняем текущее состояние баллов при остановке
    this.savePointsState(true);

    logger.info('🛑 API mode watcher stopped');
  }

  /**
   * Инициализирует стримеров с graceful degradation
   */
  private async initializeStreamers(): Promise<void> {
    logger.verbose(`📋  Initializing ${this.priorityChannels.length} streamers...`);

    for (const username of this.priorityChannels) {
      try {
        const streamerInfo = await this.twitchAPI.initializeStreamer(username);
        
        if (streamerInfo) {
          this.applyPersistedPoints(streamerInfo);
          this.streamers.set(username, streamerInfo);
          
          if (this.wsManager) {
            this.wsManager.addStreamer(streamerInfo);
          }

          if (streamerInfo.isOnline) {
            logger.info(`✅  [${username}] Initialized - ONLINE`);
            
            // Создаем сессию для стримера, который уже онлайн при инициализации
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
          // Graceful degradation: создаем базовую запись для стримера, даже если инициализация не удалась
          logger.warn(`⚠️  [${username}] Failed to initialize, creating fallback entry`);
          const fallbackStreamerInfo: StreamerInfo = {
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
          };
          this.streamers.set(username, fallbackStreamerInfo);
        }
      } catch (error: any) {
        // Graceful degradation: при ошибке инициализации создаем базовую запись
        logger.error(`❌  [${username}] Error during initialization: ${error.message || error}`);
        logger.warn(`⚠️  [${username}] Creating fallback entry, will retry later`);
        const fallbackStreamerInfo: StreamerInfo = {
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
        };
        this.applyPersistedPoints(fallbackStreamerInfo);
        this.streamers.set(username, fallbackStreamerInfo);
      }
    }

    // Сохраняем актуальное состояние после инициализации
    this.savePointsState(true);
  }

  /**
   * Запускает отправку событий просмотра
   */
  private startWatching(): void {
    // Отправляем события каждую минуту
    this.watchInterval = setInterval(async () => {
      await this.sendWatchEvents();
    }, 60000); // 60 секунд

    // Отправляем сразу
    this.sendWatchEvents();
  }

  /**
   * Отправляет события просмотра для онлайн стримеров
   */
  private async sendWatchEvents(): Promise<void> {
    const allOnlineStreamers = Array.from(this.streamers.values())
      .filter(s => s.isOnline);

    if (allOnlineStreamers.length === 0) {
      return;
    }

    // Используем настраиваемое ограничение на количество одновременно просматриваемых каналов
    // Если каналов больше лимита, используем ротацию - каждый цикл выбираем разных стримеров
    let onlineStreamers: StreamerInfo[];
    
    if (allOnlineStreamers.length <= this.maxSimultaneousChannels) {
      // Если каналов меньше или равно лимиту, используем все
      onlineStreamers = allOnlineStreamers;
    } else {
      // Если каналов больше лимита, используем ротацию
      // Используем индекс на основе текущего времени для равномерного распределения
      const rotationIndex = Math.floor(Date.now() / 60000) % allOnlineStreamers.length;
      onlineStreamers = [];
      for (let i = 0; i < this.maxSimultaneousChannels; i++) {
        onlineStreamers.push(allOnlineStreamers[(rotationIndex + i) % allOnlineStreamers.length]);
      }
      logger.verbose(`🔄  Rotating channels (${allOnlineStreamers.length} online, showing ${this.maxSimultaneousChannels}): ${onlineStreamers.map(s => s.username).join(', ')}`);
    }

    logger.verbose(`📺  Sending minute-watched events for ${onlineStreamers.length} streamer(s): ${onlineStreamers.map(s => s.username).join(', ')}`);

    // Обновляем информацию о стримерах перед отправкой с graceful degradation
    for (const streamerInfo of onlineStreamers) {
      try {
        await this.twitchAPI.updateStreamerInfo(streamerInfo);
        
        // Если spade_url еще не получен, пытаемся получить его
        if (!streamerInfo.spadeUrl && streamerInfo.isOnline) {
          logger.verbose(`🔄  [${streamerInfo.username}] Attempting to get spade_url...`);
          try {
            streamerInfo.spadeUrl = await this.twitchAPI.getSpadeUrl(streamerInfo.username);
            if (streamerInfo.spadeUrl) {
              logger.verbose(`✅  [${streamerInfo.username}] Spade URL obtained`);
            }
          } catch (error: any) {
            // Graceful degradation: если не удалось получить spade_url, продолжаем с остальными стримерами
            logger.warn(`⚠️  [${streamerInfo.username}] Failed to get spade_url: ${error.message || error}`);
          }
        }
      } catch (error: any) {
        // Graceful degradation: при ошибке обновления информации продолжаем с последними известными данными
        logger.warn(`⚠️  [${streamerInfo.username}] Failed to update streamer info: ${error.message || error}`);
        logger.verbose(`ℹ️  [${streamerInfo.username}] Continuing with last known data`);
      }
    }

    // Отправляем события последовательно с динамическим интервалом
    // Распределяем 60 секунд между всеми каналами для равномерного распределения
    const totalInterval = 60000; // 60 секунд
    const interval = Math.floor(totalInterval / onlineStreamers.length);

    // Вспомогательная функция для задержки
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    for (let i = 0; i < onlineStreamers.length; i++) {
      // Добавляем задержку перед отправкой (кроме первого стримера)
      if (i > 0) {
        await delay(interval);
      }

      const streamerInfo = onlineStreamers[i];
      
      // Проверяем, что стример все еще онлайн (мог уйти офлайн во время обновления)
      if (!streamerInfo.isOnline) {
        logger.verbose(`ℹ️  [${streamerInfo.username}] Стример ушел офлайн, пропускаем отправку события`);
        continue;
      }
      
      // Проверяем, что spade_url есть перед отправкой
      if (!streamerInfo.spadeUrl) {
        logger.warn(`⚠️  [${streamerInfo.username}] Spade URL not available, skipping event`);
        // Graceful degradation: продолжаем с остальными стримерами
        continue;
      }
      
      try {
        const success = await this.twitchAPI.sendMinuteWatched(streamerInfo);
        
        if (success) {
          logger.info(`✅  [${streamerInfo.username}] Minute watched event sent`);
          // Не добавляем событие minute-watched в историю событий веб-интерфейса
          // Это техническое событие, которое не нужно пользователю
        } else {
          // Если не удалось отправить, возможно стример ушел офлайн
          // Проверяем статус еще раз
          if (!streamerInfo.isOnline) {
            logger.verbose(`ℹ️  [${streamerInfo.username}] Стример ушел офлайн, событие не отправлено`);
          } else {
            logger.warn(`⚠️  [${streamerInfo.username}] Failed to send minute watched event (will retry next cycle)`);
            // Graceful degradation: продолжаем с остальными стримерами
          }
        }
      } catch (error: any) {
        // Graceful degradation: при ошибке отправки изолируем этого стримера и продолжаем с остальными
        logger.error(`❌  [${streamerInfo.username}] Error sending minute watched event: ${error.message || error}`);
        logger.verbose(`ℹ️  [${streamerInfo.username}] Isolated due to error, continuing with other streamers`);
      }
    }
  }

  /**
   * Запускает периодический вывод статистики
   */
  private startStatistics(): void {
    // Выводим статистику каждые 30 секунд
    this.statsInterval = setInterval(async () => {
      await this.printStatistics();
    }, 30000);

    // Выводим сразу
    this.printStatistics();
  }

  /**
   * Выводит статистику просмотра
   */
  private async printStatistics(): Promise<void> {
    // Обновляем статус стримеров перед выводом статистики для актуальности данных
    // Проверяем только онлайн стримеров для оптимизации (офлайн стримеры не нужны в статистике)
    // Graceful degradation: при ошибках обновления используем последние известные данные
    const onlineStreamers = Array.from(this.streamers.values()).filter(s => s.isOnline);
    for (const streamerInfo of onlineStreamers) {
      try {
        await this.twitchAPI.updateStreamerInfo(streamerInfo);
      } catch (error: any) {
        // Graceful degradation: при ошибке обновления используем последние известные данные
        logger.verbose(`⚠️  [${streamerInfo.username}] Failed to update for statistics: ${error.message || error}`);
      }
    }

    const stats = this.getStatistics();

    if (stats.length === 0) {
      logger.important('📊  Currently watching: none');
      return;
    }

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

  /**
   * Получает статистику просмотра
   * @param includeOffline Включать ли офлайн стримеров (по умолчанию false для обратной совместимости)
   * @returns Массив статистики
   */
  getStatistics(includeOffline: boolean = false): WatchStatistics[] {
    const stats: WatchStatistics[] = [];

    for (const streamerInfo of this.streamers.values()) {
      // Если не включаем офлайн, пропускаем офлайн стримеров
      if (!includeOffline && (!streamerInfo.isOnline || streamerInfo.startTime === 0)) {
        continue;
      }

      // Для офлайн стримеров используем 0 для elapsedTime и pointsEarned
      const elapsed = streamerInfo.isOnline && streamerInfo.startTime > 0 
        ? Date.now() - streamerInfo.startTime 
        : 0;
      
      let pointsEarned = 0;
      let currentPoints = streamerInfo.channelPoints ?? 0;
      
      // Используем channelPoints (текущий баланс) вместо lastChannelPoints
      // чтобы учитывать все начисленные баллы, включая те, что получены через просмотр
      // даже если не пришло событие points-earned через WebSocket
      if (streamerInfo.isOnline) {
        // Если channelPoints не установлен, пробуем использовать lastChannelPoints
        if (currentPoints === 0 && streamerInfo.lastChannelPoints !== null) {
          currentPoints = streamerInfo.lastChannelPoints;
        }
        
        // Вычисляем заработанные баллы
        if (streamerInfo.initialChannelPoints !== null) {
          // Если начальные баллы установлены, вычисляем разницу
          pointsEarned = currentPoints - streamerInfo.initialChannelPoints;
        } else if (currentPoints > 0) {
          // Если начальные баллы не установлены, но есть текущие баллы,
          // устанавливаем начальные баллы равными текущим (для первого обновления)
          // и pointsEarned будет 0, пока не установятся начальные баллы
          // Это предотвратит неправильное отображение заработанных баллов
          pointsEarned = 0;
        }
      }

      stats.push({
        streamerName: streamerInfo.username,
        elapsedTime: elapsed,
        pointsEarned,
        currentPoints,
        status: streamerInfo.isOnline ? 'ONLINE' : 'OFFLINE',
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
    // Проверяем статус каждые 2 минуты как fallback для WebSocket событий
    // WebSocket события stream-up/stream-down являются основным источником статуса
    // GraphQL проверка нужна для случаев, когда WebSocket события не приходят
    setInterval(async () => {
      await this.checkStreamersStatus();
    }, 120000); // Каждые 2 минуты
  }

  /**
   * Проверяет статус всех стримеров с graceful degradation
   */
  private async checkStreamersStatus(): Promise<void> {
    for (const streamerInfo of this.streamers.values()) {
      try {
        const wasOnline = streamerInfo.isOnline;
        await this.twitchAPI.updateStreamerInfo(streamerInfo);

        if (!wasOnline && streamerInfo.isOnline) {
          // Стример перешел из офлайн в онлайн
          logger.info(`🥳  [${streamerInfo.username}] is now ONLINE - starting watch`);
          streamerInfo.startTime = Date.now();
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
        } else if (wasOnline && !streamerInfo.isOnline) {
          // Стример перешел из онлайн в офлайн
          logger.info(`😴  [${streamerInfo.username}] is now OFFLINE - stopping watch`);
          
          // Завершаем сессию просмотра
          const sessionId = this.activeSessions.get(streamerInfo.username);
          if (this.statisticsStorage && sessionId) {
            const finalPoints = streamerInfo.lastChannelPoints ?? streamerInfo.channelPoints;
            this.statisticsStorage.endSession(sessionId, finalPoints, 'completed');
            this.activeSessions.delete(streamerInfo.username);
          }
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

        return {
          status: isConnected ? ComponentStatus.HEALTHY : ComponentStatus.UNHEALTHY,
          message: `WebSocket state: ${state}`,
          lastCheck: Date.now(),
          details: {
            state,
            isConnected
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

          // Если последний результат валиден или отсутствует, делаем реальную проверку
          const isValid = await this.twitchAPI.validateToken();
          return {
            status: isValid ? ComponentStatus.HEALTHY : ComponentStatus.UNHEALTHY,
            message: isValid ? 'Token is valid' : 'Token validation failed',
            lastCheck: Date.now()
          };
        } catch (error: any) {
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
        const stats = this.getStatistics();
        const totalPointsEarned = stats.reduce((sum, stat) => sum + stat.pointsEarned, 0);
        const lastActivity = stats.length > 0 
          ? Math.max(...stats.map(s => s.elapsedTime))
          : 0;

        return {
          activeWatches: stats.length,
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
    const autoExitOnInvalidToken = process.env.AUTO_EXIT_ON_INVALID_TOKEN !== 'false';
    if (!autoExitOnInvalidToken) {
      logger.verbose(`ℹ️  Health check monitoring disabled (AUTO_EXIT_ON_INVALID_TOKEN=false)`);
      return;
    }

    const checkInterval = 10000; // Проверяем каждые 10 секунд
    let consecutiveUnhealthyCount = 0;
    const maxUnhealthyCount = 3; // Завершаем после 3 неудачных проверок подряд

    this.healthCheckMonitorInterval = setInterval(async () => {
      try {
        const port = process.env.HEALTH_CHECK_PORT ? parseInt(process.env.HEALTH_CHECK_PORT, 10) : 3000;
        // Используем таймаут для fetch (совместимо с Node.js 18+)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(`http://localhost:${port}/health`, {
          method: 'GET',
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) {
          // HTTP статус не 200 (может быть 503 при unhealthy)
          consecutiveUnhealthyCount++;
          logger.warn(`⚠️  Health check returned status ${response.status} (unhealthy count: ${consecutiveUnhealthyCount})`);
          
          if (consecutiveUnhealthyCount >= maxUnhealthyCount) {
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
          
          if (consecutiveUnhealthyCount >= maxUnhealthyCount) {
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
        // Ошибка при проверке healthcheck (сервер недоступен)
        consecutiveUnhealthyCount++;
        logger.warn(`⚠️  Health check monitoring error: ${error.message || error} (unhealthy count: ${consecutiveUnhealthyCount})`);
        
        if (consecutiveUnhealthyCount >= maxUnhealthyCount) {
          logger.error('🛑  Health check server is unavailable. Shutting down...');
          this.stop();
          process.exit(1);
        }
      }
    }, checkInterval);

    logger.verbose(`🔍  Health check monitoring started (interval: ${checkInterval}ms, max unhealthy: ${maxUnhealthyCount})`);
  }

  /**
   * Запускает веб-сервер для dashboard
   */
  private startWebServer(): void {
    const port = process.env.WEB_SERVER_PORT ? parseInt(process.env.WEB_SERVER_PORT, 10) : 3001;
    
    this.webServer = new WebServer(port);
    this.webServer.setStatisticsProvider(this);
    this.webServer.start();
  }

  /**
   * Добавляет событие в историю
   * @param type Тип события
   * @param streamer Имя стримера
   * @param message Сообщение
   */
  private addEvent(type: string, streamer: string, message: string): void {
    this.eventsHistory.push({
      timestamp: Date.now(),
      type,
      streamer,
      message
    });

    // Ограничиваем размер истории
    if (this.eventsHistory.length > this.maxEventsHistory) {
      this.eventsHistory.shift();
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
    streamersCount: number;
  } {
    // Для общей статистики используем только активные просмотры
    const stats = this.getStatistics(false);
    const totalPointsEarned = stats.reduce((sum, stat) => sum + stat.pointsEarned, 0);
    const lastActivity = stats.length > 0 
      ? Math.max(...stats.map(s => s.elapsedTime))
      : 0;

    return {
      activeWatches: stats.length,
      totalPointsEarned,
      lastActivity,
      streamersCount: this.streamers.size
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
<<<<<<< HEAD
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
      return {
        isValid: false,
        status: 'unknown'
      };
    }

    if (!validationResult.isValid) {
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
          isOnline: info.isOnline,
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

