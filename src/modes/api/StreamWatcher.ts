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
  private authToken: string;
  private userAgent: string;
  private validatedUserId: string | null = null;
  private maxSimultaneousChannels: number;

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
      // Получаем user ID, используя первый стример из списка
      if (this.priorityChannels.length === 0) {
        throw new Error('No priority channels configured, cannot get user ID');
      }
      
      const username = this.priorityChannels[0];
      logger.verbose(`Getting user ID using username: ${username}`);
      const userId = await this.twitchAPI.getUserId(username);
      const graphqlClient = new GraphQLClient(this.authToken, this.userAgent);
      
      const eventHandlers: WebSocketEventHandler = {
        onPointsEarned: (streamerInfo, points, reason) => {
          logger.info(`🚀  +${points} → ${streamerInfo.username} - Reason: ${reason}`);
        },
        onClaimAvailable: async (streamerInfo, claimId) => {
          logger.info(`🎁  [${streamerInfo.username}] Получено уведомление о доступном бонусе через WebSocket`);
          const success = await graphqlClient.claimBonus(streamerInfo.channelId, claimId);
          if (success) {
            logger.info(`✅  [${streamerInfo.username}] Бонус успешно собран через WebSocket!`);
          } else {
            logger.verbose(`⚠️  [${streamerInfo.username}] Не удалось собрать бонус через WebSocket`);
          }
        },
        onStreamUp: (streamerInfo) => {
          logger.info(`🥳  [${streamerInfo.username}] Stream went ONLINE`);
          streamerInfo.startTime = Date.now();
          
          // Получаем начальные баллы
          this.updateInitialPoints(streamerInfo);
        },
        onStreamDown: (streamerInfo) => {
          logger.info(`😴  [${streamerInfo.username}] Stream went OFFLINE`);
        },
        onRaidAvailable: async (streamerInfo, raidId, targetLogin) => {
          logger.info(`🎭  [${streamerInfo.username}] Обнаружен рейд на канал ${targetLogin}`);
          const success = await graphqlClient.joinRaid(raidId);
          if (success) {
            logger.info(`✅  [${streamerInfo.username}] Успешно присоединились к рейду на ${targetLogin}!`);
          } else {
            logger.verbose(`ℹ️  [${streamerInfo.username}] Не удалось присоединиться к рейду (возможно, уже присоединились)`);
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

    if (this.wsManager) {
      this.wsManager.stop();
      this.wsManager = null;
    }

    logger.info('🛑 API mode watcher stopped');
  }

  /**
   * Инициализирует стримеров
   */
  private async initializeStreamers(): Promise<void> {
    logger.verbose(`📋  Initializing ${this.priorityChannels.length} streamers...`);

    for (const username of this.priorityChannels) {
      const streamerInfo = await this.twitchAPI.initializeStreamer(username);
      
      if (streamerInfo) {
        this.streamers.set(username, streamerInfo);
        
        if (this.wsManager) {
          this.wsManager.addStreamer(streamerInfo);
        }

        if (streamerInfo.isOnline) {
          logger.info(`✅  [${username}] Initialized - ONLINE`);
        } else {
          logger.info(`😴  [${username}] Initialized - OFFLINE`);
        }
      } else {
        logger.error(`❌  [${username}] Failed to initialize`);
      }
    }
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

    // Обновляем информацию о стримерах перед отправкой
    for (const streamerInfo of onlineStreamers) {
      await this.twitchAPI.updateStreamerInfo(streamerInfo);
      
      // Если spade_url еще не получен, пытаемся получить его
      if (!streamerInfo.spadeUrl && streamerInfo.isOnline) {
        logger.verbose(`🔄  [${streamerInfo.username}] Attempting to get spade_url...`);
        streamerInfo.spadeUrl = await this.twitchAPI.getSpadeUrl(streamerInfo.username);
        if (streamerInfo.spadeUrl) {
          logger.verbose(`✅  [${streamerInfo.username}] Spade URL obtained`);
        }
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
        continue;
      }
      
      const success = await this.twitchAPI.sendMinuteWatched(streamerInfo);
      
      if (success) {
        logger.info(`✅  [${streamerInfo.username}] Minute watched event sent`);
      } else {
        // Если не удалось отправить, возможно стример ушел офлайн
        // Проверяем статус еще раз
        if (!streamerInfo.isOnline) {
          logger.verbose(`ℹ️  [${streamerInfo.username}] Стример ушел офлайн, событие не отправлено`);
        } else {
          logger.error(`❌  [${streamerInfo.username}] Failed to send minute watched event`);
        }
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
    const onlineStreamers = Array.from(this.streamers.values()).filter(s => s.isOnline);
    for (const streamerInfo of onlineStreamers) {
      await this.twitchAPI.updateStreamerInfo(streamerInfo);
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
   * @returns Массив статистики
   */
  private getStatistics(): WatchStatistics[] {
    const stats: WatchStatistics[] = [];

    for (const streamerInfo of this.streamers.values()) {
      if (!streamerInfo.isOnline || streamerInfo.startTime === 0) {
        continue;
      }

      const elapsed = Date.now() - streamerInfo.startTime;
      let pointsEarned = 0;

      if (streamerInfo.initialChannelPoints !== null && streamerInfo.lastChannelPoints !== null) {
        pointsEarned = streamerInfo.lastChannelPoints - streamerInfo.initialChannelPoints;
      }

      stats.push({
        streamerName: streamerInfo.username,
        elapsedTime: elapsed,
        pointsEarned,
        currentPoints: streamerInfo.channelPoints,
        status: streamerInfo.isOnline ? 'ONLINE' : 'OFFLINE',
      });
    }

    return stats;
  }

  /**
   * Обновляет начальные баллы стримера
   * @param streamerInfo Информация о стримере
   */
  private async updateInitialPoints(streamerInfo: StreamerInfo): Promise<void> {
    const graphqlClient = new GraphQLClient(this.authToken, this.userAgent);
    const pointsInfo = await graphqlClient.getChannelPoints(streamerInfo.username);
    
    if (pointsInfo && streamerInfo.initialChannelPoints === null) {
      streamerInfo.initialChannelPoints = pointsInfo.balance;
      streamerInfo.lastChannelPoints = pointsInfo.balance;
      streamerInfo.channelPoints = pointsInfo.balance;
    }
  }

  /**
   * Периодически проверяет статус стримеров
   */
  startStatusCheck(): void {
    setInterval(async () => {
      await this.checkStreamersStatus();
    }, 60000); // Каждую минуту
  }

  /**
   * Проверяет статус всех стримеров
   */
  private async checkStreamersStatus(): Promise<void> {
    for (const streamerInfo of this.streamers.values()) {
      const wasOnline = streamerInfo.isOnline;
      await this.twitchAPI.updateStreamerInfo(streamerInfo);

      if (!wasOnline && streamerInfo.isOnline) {
        // Стример перешел из офлайн в онлайн
        logger.info(`🥳  [${streamerInfo.username}] is now ONLINE - starting watch`);
        streamerInfo.startTime = Date.now();
        await this.updateInitialPoints(streamerInfo);
      } else if (wasOnline && !streamerInfo.isOnline) {
        // Стример перешел из онлайн в офлайн
        logger.info(`😴  [${streamerInfo.username}] is now OFFLINE - stopping watch`);
      }
    }
  }
}

