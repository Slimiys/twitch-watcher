/**
 * Менеджер WebSocket соединений для Twitch PubSub
 */

import WebSocket from 'ws';
import { StreamerInfo, PointsEarnedMessage, ClaimAvailableMessage, VideoPlaybackMessage, RaidMessage } from './types';
import { WEBSOCKET_URL, PUBSUB_TOPICS } from './constants';
import { GraphQLClient } from './GraphQLClient';
import { logger } from './logger';
import { loadRetryConfig } from './configLoader';
import { isNetworkError } from './errorUtils';
import { WebSocketHealthSnapshot } from './botHealthTypes';

/**
 * Обработчик событий WebSocket
 */
export interface WebSocketEventHandler {
  onPointsEarned?: (streamerInfo: StreamerInfo, points: number, reason: string) => void;
  onClaimAvailable?: (streamerInfo: StreamerInfo, claimId: string) => void;
  onStreamUp?: (streamerInfo: StreamerInfo) => void;
  onStreamDown?: (streamerInfo: StreamerInfo) => void;
  onRaidAvailable?: (streamerInfo: StreamerInfo, raidId: string, targetLogin: string) => void;
}

/**
 * Менеджер WebSocket соединений
 */
export class WebSocketManager {
  private ws: WebSocket | null = null;
  private authToken: string;
  private userId: string;
  private graphqlClient: GraphQLClient;
  private streamers: Map<string, StreamerInfo> = new Map();
  private eventHandlers: WebSocketEventHandler;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private initialReconnectDelay: number;
  private maxReconnectDelay: number;
  /** Пауза перед новым циклом reconnect (мс) */
  private reconnectCyclePauseMs: number;
  private reconnectMultiplier: number;
  private isRunning = false;
  private subscribedTopics: Set<string> = new Set(); // Отслеживание подписанных топиков
  private isFirstConnection = true; // Флаг первого подключения
  private processedResponses?: Set<string>; // Отслеживание обработанных ответов по nonce
  private maxProcessedResponses = 500; // Лимит nonce в памяти при долгой работе
  private criticalErrors: Array<{ timestamp: number; error: string; code?: string }> = []; // Отслеживание критических ошибок
  private maxCriticalErrorsHistory = 10; // Максимальное количество сохраняемых критических ошибок
  private pingInterval: NodeJS.Timeout | null = null;
  
  /**
   * Получает валидированный user_id
   * @returns user_id пользователя
   */
  getValidatedUserId(): string {
    return this.userId;
  }

  /**
   * Проверяет состояние WebSocket соединения
   * @returns true если соединение активно, false в противном случае
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Активен ли менеджер (ожидает или восстанавливает соединение)
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Получает состояние WebSocket соединения
   * @returns Состояние соединения (OPEN, CONNECTING, CLOSING, CLOSED)
   */
  getConnectionState(): string {
    if (!this.ws) {
      return 'CLOSED';
    }
    const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    return states[this.ws.readyState] || 'UNKNOWN';
  }

  /**
   * Проверяет наличие критических ошибок (DNS и т.д.)
   * @returns true если есть критические ошибки, false в противном случае
   */
  hasCriticalErrors(): boolean {
    // Проверяем наличие критических ошибок за последние 5 минут
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    return this.criticalErrors.some(err => err.timestamp > fiveMinutesAgo);
  }

  /**
   * Получает информацию о критических ошибках
   * @returns Массив критических ошибок
   */
  getCriticalErrors(): Array<{ timestamp: number; error: string; code?: string }> {
    // Возвращаем только ошибки за последние 5 минут
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    return this.criticalErrors.filter(err => err.timestamp > fiveMinutesAgo);
  }

  /**
   * Получает последнюю критическую ошибку
   * @returns Последняя критическая ошибка или null
   */
  getLastCriticalError(): { timestamp: number; error: string; code?: string } | null {
    if (this.criticalErrors.length === 0) {
      return null;
    }
    return this.criticalErrors[this.criticalErrors.length - 1];
  }

  /**
   * Снимок WebSocket для dashboard
   */
  getHealthSnapshot(): WebSocketHealthSnapshot {
    const connectionState = this.getConnectionState();
    let status: WebSocketHealthSnapshot['status'];

    if (!this.isRunning) {
      status = 'stopped';
    } else if (this.isConnected()) {
      status = 'connected';
    } else if (connectionState === 'CONNECTING' || this.reconnectAttempts > 0) {
      status = 'reconnecting';
    } else {
      status = 'disconnected';
    }

    return {
      status,
      connectionState,
      reconnectAttempt: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      hasCriticalErrors: this.hasCriticalErrors(),
      lastCriticalError: this.getLastCriticalError(),
    };
  }

  /**
   * Создает экземпляр WebSocket менеджера
   * @param authToken Токен авторизации
   * @param userId ID пользователя
   * @param graphqlClient GraphQL клиент
   * @param eventHandlers Обработчики событий
   */
  constructor(
    authToken: string,
    userId: string,
    graphqlClient: GraphQLClient,
    eventHandlers: WebSocketEventHandler
  ) {
    this.authToken = authToken;
    this.userId = userId;
    this.graphqlClient = graphqlClient;
    this.eventHandlers = eventHandlers;
    
    // Загружаем конфигурацию retry для WebSocket
    const retryConfig = loadRetryConfig();
    const wsConfig = retryConfig.websocket || {
      maxReconnectAttempts: 10,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
    };
    
    this.maxReconnectAttempts = wsConfig.maxReconnectAttempts;
    this.initialReconnectDelay = wsConfig.initialDelayMs;
    this.maxReconnectDelay = wsConfig.maxDelayMs;
    this.reconnectCyclePauseMs = wsConfig.reconnectCyclePauseMs ?? 120000;
    this.reconnectMultiplier = 2; // Экспоненциальный множитель
  }
  
  /**
   * Вычисляет задержку для переподключения с экспоненциальным backoff
   * @param attemptNumber Номер попытки (начиная с 1)
   * @returns Задержка в миллисекундах
   */
  private calculateReconnectDelay(attemptNumber: number): number {
    // Экспоненциальная задержка: initialDelay * (multiplier ^ (attemptNumber - 1))
    const exponentialDelay = this.initialReconnectDelay * Math.pow(this.reconnectMultiplier, attemptNumber - 1);
    
    // Ограничиваем максимальной задержкой
    const delay = Math.min(exponentialDelay, this.maxReconnectDelay);
    
    // Добавляем jitter (случайную задержку до 20% от основной задержки)
    const jitterAmount = delay * 0.2 * Math.random();
    
    return Math.floor(delay + jitterAmount);
  }

  /**
   * Валидирует токен через Twitch API и получает правильный user_id
   * @returns user_id из валидации токена или null
   */
  private async validateTokenAndGetUserId(): Promise<string | null> {
    try {
      const fetchTimeoutMs = parseInt(process.env.FETCH_TIMEOUT_MS || '20000', 10);
      const response = await fetch('https://id.twitch.tv/oauth2/validate', {
        method: 'GET',
        headers: {
          'Authorization': `OAuth ${this.authToken}`,
        },
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });

      if (response.status === 200) {
        const data = await response.json();
        const validatedUserId = data.user_id?.toString();
        logger.verbose(`✅  Token validated - user_id: ${validatedUserId}, client_id: ${data.client_id}`);
        
        // Если user_id из валидации отличается от переданного, используем валидированный
        // Это нормально, если переданный user_id был ID канала стримера, а не ID пользователя
        if (validatedUserId && validatedUserId !== this.userId) {
          logger.verbose(`ℹ️  Using validated user_id ${validatedUserId} for WebSocket subscription (was ${this.userId})`);
          this.userId = validatedUserId;
        }
        
        return validatedUserId;
      } else if (response.status === 401) {
        logger.warn(`⚠️  Токен отклонён Twitch (401) — обновите token в «Конфиг бота» или config.json`);
        return null;
      } else {
        logger.warn(`⚠️  Ответ валидации токена: ${response.status} ${response.statusText}`);
        return null;
      }
    } catch (error: any) {
      const errorMessage = error.message || String(error);
      if (isNetworkError(error)) {
        logger.warn(
          `⚠️  Сетевая ошибка при повторной проверке токена (id.twitch.tv): ${errorMessage} — токен не считается невалидным`
        );
        // При сетевой ошибке используем user_id, полученный при старте приложения
        return this.userId || null;
      }
      logger.warn(`⚠️  Token validation error: ${errorMessage}`);
      return this.userId || null;
    }
  }

  /**
   * Запускает WebSocket соединение
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    
    // user_id уже получен при старте StreamWatcher — повторная проверка только при необходимости
    if (this.userId) {
      logger.verbose(`ℹ️  WebSocket: используем user_id ${this.userId} (уже проверен при старте)`);
    } else {
      const validatedUserId = await this.validateTokenAndGetUserId();
      if (!validatedUserId) {
        logger.warn(`⚠️  Не удалось получить user_id для WebSocket, продолжаем подключение...`);
      }
    }
    
    await this.connect();
  }

  /**
   * Останавливает WebSocket соединение
   */
  stop(): void {
    this.isRunning = false;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Подключается к WebSocket
   */
  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let hasOpened = false;

      const settleOnce = (action: 'resolve' | 'reject', error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectionTimeoutId);
        if (action === 'resolve') {
          resolve();
        } else {
          reject(error ?? new Error('WebSocket connection failed'));
        }
      };

      const scheduleReconnect = () => {
        if (!this.isRunning) {
          return;
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = this.calculateReconnectDelay(this.reconnectAttempts);
          logger.info(
            `🔄  Reconnecting WebSocket (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}) через ${Math.floor(delay)}ms...`
          );
          setTimeout(() => {
            this.connect().catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              logger.verbose(`⚠️  WebSocket reconnect attempt failed: ${message}`);
            });
          }, delay);
          return;
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          const errorMessage = `Достигнуто максимальное количество попыток переподключения (${this.maxReconnectAttempts})`;
          logger.warn(
            `⚠️  ${errorMessage} — пауза ${Math.round(this.reconnectCyclePauseMs / 1000)}с, затем новый цикл`
          );

          this.criticalErrors.push({
            timestamp: Date.now(),
            error: errorMessage,
            code: 'MAX_RECONNECT_ATTEMPTS',
          });
          if (this.criticalErrors.length > this.maxCriticalErrorsHistory) {
            this.criticalErrors.shift();
          }

          this.reconnectAttempts = 0;
          setTimeout(() => {
            if (!this.isRunning) {
              return;
            }
            logger.info('🔄  WebSocket: новый цикл переподключения после паузы');
            this.connect().catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              logger.verbose(`⚠️  WebSocket reconnect cycle failed: ${message}`);
            });
          }, this.reconnectCyclePauseMs);
        }
      };

      const connectionTimeoutMs = parseInt(process.env.WS_CONNECT_TIMEOUT_MS || '45000', 10);
      const connectionTimeoutId = setTimeout(() => {
        logger.warn(`⚠️  WebSocket connect timeout (${connectionTimeoutMs}ms)`);
        try {
          this.ws?.terminate();
        } catch {
          // ignore
        }
        this.ws = null;
        settleOnce('reject', new Error(`WebSocket connection timeout after ${connectionTimeoutMs}ms`));
      }, connectionTimeoutMs);

      try {
        const wsOptions: any = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
          },
        };

        this.ws = new WebSocket(WEBSOCKET_URL, wsOptions);

        this.ws.on('open', () => {
          hasOpened = true;
          logger.info('🔌  WebSocket connected');
          this.reconnectAttempts = 0;
          this.criticalErrors = [];

          if (this.isFirstConnection) {
            this.isFirstConnection = false;
            this.processedResponses = new Set<string>();
            this.subscribe();
          } else {
            this.subscribedTopics.clear();
            this.processedResponses = new Set<string>();
            this.subscribe();
            for (const streamerInfo of this.streamers.values()) {
              this.addStreamer(streamerInfo, true);
            }
          }
          settleOnce('resolve');
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('error', (error: any) => {
          if (error.code === 'EAI_AGAIN' || error.code === 'ENOTFOUND' || error.syscall === 'getaddrinfo') {
            const errorMessage = `DNS ошибка: не удается разрешить домен ${error.hostname || 'pubsub-edge.twitch.tv'}`;
            logger.error(`❌  ${errorMessage}`);
            logger.error(`   Код ошибки: ${error.code || 'unknown'}`);
            logger.error(`   Возможные причины:`);
            logger.error(`   - Проблемы с DNS сервером`);
            logger.error(`   - Проблемы с интернет-соединением`);
            logger.error(`   - Блокировка доступа к Twitch`);
            logger.error(`   Решение: проверьте DNS и доступность gql.twitch.tv`);

            this.criticalErrors.push({
              timestamp: Date.now(),
              error: errorMessage,
              code: error.code || 'UNKNOWN',
            });

            if (this.criticalErrors.length > this.maxCriticalErrorsHistory) {
              this.criticalErrors.shift();
            }
          } else {
            logger.error('❌  WebSocket error:', error);
          }
        });

        this.ws.on('close', () => {
          logger.verbose('🔌  WebSocket closed');
          const wasOpened = hasOpened;
          this.ws = null;

          if (!wasOpened) {
            settleOnce('reject', new Error('WebSocket closed before connection established'));
          }

          scheduleReconnect();
        });
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        settleOnce('reject', err);
      }
    });
  }

  /**
   * Запоминает nonce ответа подписки (с ограничением размера Set)
   */
  private rememberProcessedResponse(nonce: string): boolean {
    if (!this.processedResponses) {
      this.processedResponses = new Set<string>();
    }
    if (this.processedResponses.has(nonce)) {
      return false;
    }
    this.processedResponses.add(nonce);
    while (this.processedResponses.size > this.maxProcessedResponses) {
      const oldest = this.processedResponses.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.processedResponses.delete(oldest);
    }
    return true;
  }

  /**
   * Подписывается на темы
   */
  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Подписываемся на события баллов для пользователя
    // Формат топика: community-points-user-v1.{userId}
    // Для user топиков нужен auth_token в data
    // ВАЖНО: Если токен неверный, подписка не сработает, но это не критично -
    // баллы все равно будут обновляться через периодические GraphQL запросы
    if (this.authToken) {
      const userTopicName = `${PUBSUB_TOPICS.COMMUNITY_POINTS_USER}.${this.userId}`;
      
      // Проверяем, не подписаны ли уже на этот топик
      if (!this.subscribedTopics.has(userTopicName)) {
        const userTopic = {
          type: 'LISTEN',
          nonce: this.generateNonce(),
          data: {
            topics: [userTopicName],
            auth_token: this.authToken,
          },
        };

        // Логируем первые и последние символы токена для отладки (без полного значения)
        const tokenPreview = this.authToken ? `${this.authToken.substring(0, 10)}...${this.authToken.substring(this.authToken.length - 10)}` : 'empty';
        const tokenLength = this.authToken ? this.authToken.length : 0;
        logger.verbose(`📡  Subscribing to ${userTopicName} for user ${this.userId}`);
        logger.verbose(`   Token preview: ${tokenPreview} (length: ${tokenLength})`);
        this.ws.send(JSON.stringify(userTopic));
        this.subscribedTopics.add(userTopicName);
      } else {
        logger.verbose(`ℹ️  Already subscribed to ${userTopicName}`);
      }
    } else {
      logger.warn(`⚠️  No auth token available, skipping subscription to ${PUBSUB_TOPICS.COMMUNITY_POINTS_USER}`);
    }

    // НЕ подписываемся на стримеров здесь - они будут добавлены через addStreamer()
    // Это предотвращает дублирование подписок
  }

  /**
   * Добавляет стримера для отслеживания
   * @param streamerInfo Информация о стримере
   * @param forceResubscribe Принудительно переподписаться, даже если уже подписаны (для переподключений)
   */
  addStreamer(streamerInfo: StreamerInfo, forceResubscribe: boolean = false): void {
    const isNewStreamer = !this.streamers.has(streamerInfo.channelId);
    
    // Если стример уже добавлен и не требуется переподписка, пропускаем
    if (!isNewStreamer && !forceResubscribe) {
      logger.verbose(`ℹ️  [${streamerInfo.username}] Already added, skipping duplicate subscription`);
      return;
    }
    
    this.streamers.set(streamerInfo.channelId, streamerInfo);
    
    // Если WebSocket уже подключен, подписываемся на события видео и рейды
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Подписка на события видео
      const videoTopicName = `${PUBSUB_TOPICS.VIDEO_PLAYBACK}.${streamerInfo.channelId}`;
      
      // Проверяем, не подписаны ли уже на этот топик (если не принудительная переподписка)
      if (forceResubscribe || !this.subscribedTopics.has(videoTopicName)) {
        if (forceResubscribe && this.subscribedTopics.has(videoTopicName)) {
          // Удаляем из списка, чтобы переподписаться
          this.subscribedTopics.delete(videoTopicName);
        }
        
        const videoNonce = this.generateNonce();
        const videoTopic = {
          type: 'LISTEN',
          nonce: videoNonce,
          data: {
            topics: [videoTopicName],
            auth_token: this.authToken,
          },
        };

        logger.verbose(`📡  Subscribing to ${videoTopicName} for ${streamerInfo.username} (nonce: ${videoNonce.substring(0, 8)}...)`);
        this.ws.send(JSON.stringify(videoTopic));
        this.subscribedTopics.add(videoTopicName);
      } else {
        logger.verbose(`ℹ️  Already subscribed to ${videoTopicName} for ${streamerInfo.username}`);
      }

      // Подписка на события рейдов
      const raidTopicName = `${PUBSUB_TOPICS.RAID}.${streamerInfo.channelId}`;
      
      // Проверяем, не подписаны ли уже на этот топик (если не принудительная переподписка)
      if (forceResubscribe || !this.subscribedTopics.has(raidTopicName)) {
        if (forceResubscribe && this.subscribedTopics.has(raidTopicName)) {
          // Удаляем из списка, чтобы переподписаться
          this.subscribedTopics.delete(raidTopicName);
        }
        
        const raidNonce = this.generateNonce();
        const raidTopic = {
          type: 'LISTEN',
          nonce: raidNonce,
          data: {
            topics: [raidTopicName],
            auth_token: this.authToken,
          },
        };

        logger.verbose(`📡  Subscribing to ${raidTopicName} for ${streamerInfo.username} (nonce: ${raidNonce.substring(0, 8)}...)`);
        this.ws.send(JSON.stringify(raidTopic));
        this.subscribedTopics.add(raidTopicName);
      } else {
        logger.verbose(`ℹ️  Already subscribed to ${raidTopicName} for ${streamerInfo.username}`);
      }
    }
  }

  /**
   * Удаляет стримера из отслеживания
   * @param channelId ID канала
   */
  removeStreamer(channelId: string): void {
    this.streamers.delete(channelId);
  }

  /**
   * Обрабатывает входящие сообщения
   * @param message Сообщение в формате JSON
   */
  private handleMessage(message: string): void {
    try {
      const data = JSON.parse(message);

      // Логируем все входящие сообщения для отладки
      if (data.type === 'MESSAGE') {
        const topic = data.data.topic;
        const messageData = JSON.parse(data.data.message);
        
        logger.verbose(`📨  WebSocket MESSAGE received - topic: ${topic}, type: ${messageData.type || 'unknown'}`);

        if (topic.startsWith(PUBSUB_TOPICS.COMMUNITY_POINTS_USER)) {
          this.handleCommunityPointsMessage(messageData);
        } else if (topic.startsWith(PUBSUB_TOPICS.VIDEO_PLAYBACK)) {
          const channelId = topic.split('.')[1];
          this.handleVideoPlaybackMessage(channelId, messageData);
        } else if (topic.startsWith(PUBSUB_TOPICS.RAID)) {
          const channelId = topic.split('.')[1];
          this.handleRaidMessage(channelId, messageData);
        } else {
          logger.verbose(`⚠️  Unknown topic: ${topic}`);
        }
      } else if (data.type === 'PONG') {
        // Ответ на PING, ничего не делаем
        logger.verbose('🏓  WebSocket PONG received');
      } else if (data.type === 'RECONNECT') {
        logger.info('🔄  WebSocket reconnection requested');
        this.ws?.close();
      } else if (data.type === 'RESPONSE') {
        // Ответ на подписку
        if (data.error) {
          logger.error(`❌  WebSocket subscription error:`, data.error);
          logger.verbose(`   Full response:`, JSON.stringify(data, null, 2));
          
          // Если подписка не удалась, удаляем топик из списка подписанных
          // (но мы не знаем точно, какой топик, так как nonce не сохраняется)
        } else {
          // Успешная подписка - логируем с информацией о nonce, если доступен
          const nonce = data.nonce || 'unknown';
          if (this.rememberProcessedResponse(nonce)) {
            logger.verbose(`✅  WebSocket subscription successful (nonce: ${nonce.substring(0, 8)}...)`);
          }
        }
      } else {
        logger.verbose(`📥  WebSocket message type: ${data.type}`);
      }
    } catch (error: any) {
      logger.error('❌  Error handling WebSocket message:', error.message || error);
      logger.verbose('Raw message:', message.substring(0, 500));
    }
  }

  /**
   * Обрабатывает сообщения о баллах канала
   * @param messageData Данные сообщения
   */
  private handleCommunityPointsMessage(messageData: any): void {
    if (messageData.type === 'points-earned') {
      const pointsMessage = messageData as PointsEarnedMessage;
      const balance = pointsMessage.data.balance.balance;
      const earned = pointsMessage.data.point_gain.total_points;
      const reason = pointsMessage.data.point_gain.reason_code;

      // Извлекаем channel_id из сообщения
      // channel_id может быть в data.balance.channel_id или data.channel_id
      const channelIdRaw = pointsMessage.data.balance.channel_id || pointsMessage.data.channel_id;
      // Нормализуем channel_id к строке для корректного сравнения
      const channelId = channelIdRaw ? String(channelIdRaw) : null;

      logger.verbose(`💰  WebSocket: points-earned event - balance=${balance}, earned=${earned}, reason=${reason}, channel_id=${channelId || 'unknown'}`);

      // Пытаемся найти стримера по channel_id
      let streamerInfo: StreamerInfo | undefined;
      
      if (channelId) {
        // Сравниваем как строки, чтобы избежать проблем с типами
        streamerInfo = Array.from(this.streamers.values()).find(s => String(s.channelId) === channelId);
        
        // Если channel_id есть, но не найден в списке отслеживаемых - это событие для неотслеживаемого стримера
        // Игнорируем его, чтобы не приписывать баллы неправильному стримеру
        if (!streamerInfo) {
          logger.verbose(`⚠️  Received points-earned for unknown channel_id: ${channelId} (balance: ${balance}, earned: ${earned})`);
          logger.verbose(`   This channel is not in the tracking list. Ignoring event to prevent incorrect attribution.`);
          logger.verbose(`   Tracked channels: ${Array.from(this.streamers.values()).map(s => `${s.username} (channelId: ${s.channelId})`).join(', ')}`);
          return; // Игнорируем событие для неотслеживаемого канала
        }
      } else {
        // Если channel_id нет, пытаемся найти по точному совпадению баланса
        // Проверяем, что новый баланс точно соответствует: lastChannelPoints + earned = balance
        // Это безопасно, потому что баланс уникален для каждого канала
        streamerInfo = Array.from(this.streamers.values()).find(s => {
          if (s.lastChannelPoints !== null && s.isOnline) {
            // Проверяем точное совпадение: старый баланс + earned = новый баланс
            const expectedBalance = s.lastChannelPoints + earned;
            const diff = Math.abs(expectedBalance - balance);
            // Допускаем только небольшую погрешность округления (до 2 баллов)
            return diff <= 2;
          }
          return false;
        });
        
        // Если не нашли по lastChannelPoints, пробуем найти по текущему channelPoints
        // (для случаев, когда lastChannelPoints еще не обновлен, но earned = 0)
        if (!streamerInfo && earned === 0) {
          streamerInfo = Array.from(this.streamers.values()).find(s => {
            if (s.isOnline && s.channelPoints !== null) {
              // Для earned = 0 баланс должен точно совпадать
              return Math.abs(s.channelPoints - balance) <= 2;
            }
            return false;
          });
        }
        
        // Если не удалось найти по балансу, но это первое событие (earned = 0 или очень маленькое)
        // и есть только один онлайн стример без установленных баллов, приписываем ему
        if (!streamerInfo && earned <= 10) {
          const onlineStreamers = Array.from(this.streamers.values()).filter(s => s.isOnline && s.initialChannelPoints === null);
          if (onlineStreamers.length === 1) {
            // Если только один онлайн стример без начальных баллов, это скорее всего для него
            streamerInfo = onlineStreamers[0];
            logger.verbose(`💰  Assuming first points-earned event for ${streamerInfo.username} (only online streamer without initial points)`);
          }
        }
        
        // Если не удалось точно определить стримера - игнорируем событие
        // Это безопаснее, чем приписывать баллы неправильному стримеру
        if (!streamerInfo) {
          const onlineStreamers = Array.from(this.streamers.values()).filter(s => s.isOnline);
          logger.verbose(`⚠️  No channel_id in points-earned message, and cannot determine streamer by exact balance match`);
          logger.verbose(`   Event balance: ${balance}, earned: ${earned}`);
          if (onlineStreamers.length > 0) {
            logger.verbose(`   Online streamers: ${onlineStreamers.map(s => `${s.username} (balance: ${s.channelPoints}, last: ${s.lastChannelPoints}, initial: ${s.initialChannelPoints})`).join(', ')}`);
          }
          logger.verbose(`   Ignoring event to prevent incorrect attribution.`);
          return; // Игнорируем событие, если не можем точно определить стримера
        }
      }
      
      // Если мы дошли сюда, значит streamerInfo точно найден (иначе был бы return выше)
      // Обрабатываем событие для найденного стримера
      const oldBalance = streamerInfo.channelPoints;
      const wasInitialNull = streamerInfo.initialChannelPoints === null;
      
      streamerInfo.channelPoints = balance;
      streamerInfo.lastChannelPoints = balance;

      // Если initialChannelPoints еще не установлен, устанавливаем его
      // ВАЖНО: вычитаем earned из баланса, так как баланс уже включает заработанные баллы
      if (streamerInfo.initialChannelPoints === null) {
        // Если earned > 0, значит это событие начисления баллов, а не просто обновление баланса
        // Начальный баланс = текущий баланс - заработанные баллы
        const initialBalance = earned > 0 ? balance - earned : balance;
        streamerInfo.initialChannelPoints = initialBalance;
        logger.info(`💰  [${streamerInfo.username}] Initial balance set from WebSocket: ${initialBalance} (current: ${balance}, earned: ${earned})`);
      }

      if (streamerInfo.initialChannelPoints !== null) {
        streamerInfo.streamPointsEarned = balance - streamerInfo.initialChannelPoints;
      }

      // Логируем обновление баланса (включая первое установление)
      if (oldBalance !== balance || wasInitialNull) {
        logger.info(`📊  [${streamerInfo.username}] Balance updated: ${oldBalance} → ${balance} (earned: ${earned}, reason: ${reason})`);
      }

      if (this.eventHandlers.onPointsEarned) {
        this.eventHandlers.onPointsEarned(streamerInfo, earned, reason);
      }
    } else if (messageData.type === 'claim-available') {
      const claimMessage = messageData as ClaimAvailableMessage;
      const claimId = claimMessage.data.claim.id;
      const channelIdRaw = claimMessage.data.claim.channel_id;
      const channelId = channelIdRaw != null ? String(channelIdRaw) : null;

      logger.verbose(
        `🎁  WebSocket: claim-available - claimId=${claimId}, channel_id=${channelId || 'unknown'}`
      );

      if (!this.eventHandlers.onClaimAvailable) {
        return;
      }

      if (channelId) {
        const streamerInfo = Array.from(this.streamers.values()).find(
          (s) => String(s.channelId) === channelId
        );

        if (streamerInfo?.isOnline) {
          this.eventHandlers.onClaimAvailable(streamerInfo, claimId);
        } else if (streamerInfo) {
          logger.verbose(`ℹ️  claim-available для ${streamerInfo.username}, но стример офлайн`);
        } else {
          logger.verbose(`ℹ️  claim-available для неотслеживаемого channel_id: ${channelId}`);
        }
        return;
      }

      // Fallback: channel_id не указан — проверяем всех онлайн стримеров
      const onlineStreamers = Array.from(this.streamers.values()).filter((s) => s.isOnline);
      for (const streamerInfo of onlineStreamers) {
        this.eventHandlers.onClaimAvailable(streamerInfo, claimId);
      }
    }
  }

  /**
   * Обрабатывает сообщения о событиях видео
   * @param channelId ID канала
   * @param messageData Данные сообщения
   */
  private handleVideoPlaybackMessage(channelId: string, messageData: any): void {
    const streamerInfo = this.streamers.get(channelId);
    if (!streamerInfo) {
      return;
    }

    const videoMessage = messageData as VideoPlaybackMessage;

    if (videoMessage.type === 'stream-up') {
      const wasOnline = streamerInfo.isOnline;
      streamerInfo.isOnline = true;
      streamerInfo.webSocketOnlineAt = Date.now();
      if (!streamerInfo.startTime || streamerInfo.startTime <= 0) {
        streamerInfo.startTime = streamerInfo.webSocketOnlineAt;
      }
      if (!wasOnline && this.eventHandlers.onStreamUp) {
        this.eventHandlers.onStreamUp(streamerInfo);
      }
    } else if (videoMessage.type === 'stream-down') {
      if (streamerInfo.isOnline) {
        if (this.eventHandlers.onStreamDown) {
          this.eventHandlers.onStreamDown(streamerInfo);
        }
      }
    }
  }

  /**
   * Обрабатывает сообщения о рейдах
   * @param channelId ID канала
   * @param messageData Данные сообщения
   */
  private handleRaidMessage(channelId: string, messageData: any): void {
    const streamerInfo = this.streamers.get(channelId);
    if (!streamerInfo) {
      return;
    }

    const raidMessage = messageData as RaidMessage;

    if (raidMessage.type === 'raid_update_v2' && raidMessage.raid) {
      const raidId = raidMessage.raid.id;
      const targetLogin = raidMessage.raid.target_login;

      if (this.eventHandlers.onRaidAvailable) {
        this.eventHandlers.onRaidAvailable(streamerInfo, raidId, targetLogin);
      }
    }
  }

  /**
   * Генерирует уникальный nonce для запросов
   * @returns Случайная строка
   */
  private generateNonce(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }

  /**
   * Отправляет PING для поддержания соединения
   */
  startPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    this.pingInterval = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'PING' }));
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.verbose(`⚠️  WebSocket ping failed: ${message}`);
      }
    }, 240000);
  }
}

