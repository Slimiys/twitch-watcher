/**
 * API клиент для работы с Twitch
 */

import { GraphQLClient } from './GraphQLClient';
import { StreamerInfo, MinuteWatchedPayload, TokenValidationResult, TokenInfo } from './types';
import { extractSpadeUrl, extractSettingsUrl, encodePayload } from './utils';
import { logger } from './logger';
import { fetchWithRetry, RetryConfig } from './retry';
import { loadRetryConfig } from './configLoader';

/**
 * API клиент для работы с Twitch
 */
export class TwitchAPI {
  private graphqlClient: GraphQLClient;
  private userAgent: string;
  private userId: string | null = null;
  private authToken: string;
  private validatedUserId: string | null = null; // User ID из валидации токена (правильный ID пользователя)
  private retryConfig: RetryConfig;

  /**
   * Создает экземпляр Twitch API клиента
   * @param authToken Токен авторизации
   * @param userAgent User-Agent для запросов
   * @param validatedUserId User ID из валидации токена (опционально)
   */
  constructor(authToken: string, userAgent: string, validatedUserId?: string | null) {
    this.authToken = authToken;
    this.graphqlClient = new GraphQLClient(authToken, userAgent);
    this.userAgent = userAgent;
    this.retryConfig = loadRetryConfig();
    if (validatedUserId) {
      this.validatedUserId = validatedUserId;
    }
  }
  
  /**
   * Устанавливает валидированный user_id
   * @param userId User ID из валидации токена
   */
  setValidatedUserId(userId: string): void {
    this.validatedUserId = userId;
  }

  /**
   * Проверяет валидность токена через Twitch API с retry
   * @returns true если токен валиден, false в противном случае
   */
  async validateToken(): Promise<boolean> {
    const result = await this.validateTokenWithInfo();
    return result.isValid;
  }

  /**
   * Проверяет валидность токена и получает информацию о нем
   * @returns Результат валидации с информацией о токене
   */
  async validateTokenWithInfo(): Promise<TokenValidationResult> {
    try {
      // Используем обычный fetch, так как нам нужно обработать 401 как нормальный случай
      const response = await fetch('https://id.twitch.tv/oauth2/validate', {
        method: 'GET',
        headers: {
          'Authorization': `OAuth ${this.authToken}`,
        },
      });

      if (response.status === 200) {
        const tokenInfo: TokenInfo = await response.json();
        const now = Date.now();
        let expiresAt: number | undefined;

        // Если Twitch вернул expires_in, вычисляем точное время истечения
        if (tokenInfo.expires_in) {
          expiresAt = now + (tokenInfo.expires_in * 1000);
        }

        return {
          isValid: true,
          tokenInfo,
          expiresAt,
        };
      } else {
        // Токен невалиден (401) или другая ошибка
        return {
          isValid: false,
        };
      }
    } catch (error: any) {
      logger.verbose(`⚠️  Token validation error: ${error.message || error}`);
      return {
        isValid: false,
      };
    }
  }

  /**
   * Получает ID пользователя
   * @param username Имя пользователя (обязательно для получения через GraphQL)
   * @returns ID пользователя
   */
  async getUserId(username: string): Promise<string> {
    if (this.userId) {
      return this.userId;
    }

    if (!username) {
      throw new Error('Username is required to get user ID');
    }

    // Получаем ID пользователя через GraphQL
    // Используем ReportMenuItem с указанием channelLogin
    const operation = {
      operationName: 'ReportMenuItem',
      variables: { channelLogin: username },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: '8f3628981255345ca5e5453dfd844efffb01d6413a9931498836e6268692a30c',
        },
      },
    };

    const response = await this.graphqlClient.postRequest(operation);
    
    // Логируем ответ для отладки
    if (!response.data) {
      logger.error('Failed to get user ID: No data in response', JSON.stringify(response, null, 2));
      throw new Error('Failed to get user ID: No data in response');
    }
    
    // Пробуем получить user ID из разных мест в ответе
    let userId: string | null = null;
    
    if (response.data?.user?.id) {
      userId = response.data.user.id;
    } else if (response.data?.currentUser?.id) {
      userId = response.data.currentUser.id;
    } else if (response.data?.self?.id) {
      userId = response.data.self.id;
    }
    
    if (userId) {
      this.userId = userId;
      logger.verbose(`✅  User ID obtained: ${userId}`);
      return userId;
    }

    logger.error('Failed to get user ID: User ID not found in response', JSON.stringify(response.data, null, 2));
    throw new Error('Failed to get user ID: User ID not found');
  }

  /**
   * Получает spade_url для стримера с retry
   * @param username Имя стримера
   * @returns Spade URL или null
   */
  async getSpadeUrl(username: string): Promise<string | null> {
    try {
      // Точно как в Channel Points Miner: get_spade_url
      // 1. Загружаем главную страницу стримера с retry
      const streamerUrl = `https://www.twitch.tv/${username}`;
      const pageResponse = await fetchWithRetry(
        streamerUrl,
        {
          headers: {
            'User-Agent': this.userAgent,
          },
        },
        {
          maxAttempts: this.retryConfig.maxAttempts,
          initialDelayMs: this.retryConfig.initialDelayMs,
          maxDelayMs: this.retryConfig.maxDelayMs,
          multiplier: this.retryConfig.multiplier,
          jitter: this.retryConfig.jitter,
        },
        `getSpadeUrl:${username}`
      );

      const pageContent = await pageResponse.text();

      // 2. Извлекаем URL конфигурационного файла (точно как в Channel Points Miner)
      // regex_settings = "(https://static.twitchcdn.net/config/settings.*?js)"
      let regexSettings = /(https:\/\/static\.twitchcdn\.net\/config\/settings.*?\.js)/;
      let settingsUrlMatch = pageContent.match(regexSettings);
      
      let settingsUrl: string | null = null;
      
      if (settingsUrlMatch && settingsUrlMatch[1]) {
        // Найден полный URL
        settingsUrl = settingsUrlMatch[1];
      } else {
        // Пробуем найти имя файла settings (новый формат Twitch)
        const settingsFileNameMatch = pageContent.match(/settings\.[a-f0-9]+\.js/);
        if (settingsFileNameMatch && settingsFileNameMatch[0]) {
          // Строим полный URL из имени файла
          settingsUrl = `https://static.twitchcdn.net/config/${settingsFileNameMatch[0]}`;
          logger.verbose(`🔍  Found settings filename, constructing URL: ${settingsUrl}`);
        } else {
          // Пробуем найти любые упоминания settings
          const allSettings = pageContent.match(/settings[^"'\s<>]*\.js/gi);
          if (allSettings && allSettings.length > 0) {
            logger.verbose(`Found settings mentions: ${allSettings.slice(0, 5).join(', ')}`);
            // Пробуем использовать первое найденное упоминание
            const firstSettings = allSettings[0];
            if (firstSettings.includes('settings') && firstSettings.endsWith('.js')) {
              // Если это полный путь или относительный, строим URL
              if (firstSettings.startsWith('http')) {
                settingsUrl = firstSettings;
              } else if (firstSettings.startsWith('/')) {
                settingsUrl = `https://static.twitchcdn.net${firstSettings}`;
              } else {
                settingsUrl = `https://static.twitchcdn.net/config/${firstSettings}`;
              }
              logger.verbose(`🔍  Constructed settings URL from mention: ${settingsUrl}`);
            }
          }
        }
      }
      
      if (!settingsUrl) {
        logger.error(`❌  Settings URL not found for ${username}. Page length: ${pageContent.length}`);
        return null;
      }
      logger.verbose(`✅  Found settings URL for ${username}: ${settingsUrl}`);

      // 3. Загружаем конфигурационный файл с retry
      const settingsResponse = await fetchWithRetry(
        settingsUrl,
        {
          headers: {
            'User-Agent': this.userAgent,
          },
        },
        {
          maxAttempts: this.retryConfig.maxAttempts,
          initialDelayMs: this.retryConfig.initialDelayMs,
          maxDelayMs: this.retryConfig.maxDelayMs,
          multiplier: this.retryConfig.multiplier,
          jitter: this.retryConfig.jitter,
        },
        `getSpadeUrl:settings:${username}`
      );

      const settingsContent = await settingsResponse.text();

      // 4. Извлекаем spade_url (точно как в Channel Points Miner)
      // regex_spade = '"spade_url":"(.*?)"'
      const regexSpade = /"spade_url":"(.*?)"/;
      const spadeUrlMatch = settingsContent.match(regexSpade);
      
      if (!spadeUrlMatch || !spadeUrlMatch[1]) {
        logger.error(`❌  Spade URL not found in settings for ${username}. Settings content length: ${settingsContent.length}`);
        // Пробуем найти любые упоминания spade
        const spadeMentions = settingsContent.match(/"spade[^"]*"/g);
        if (spadeMentions && spadeMentions.length > 0) {
          logger.verbose(`Found spade mentions: ${spadeMentions.slice(0, 3).join(', ')}`);
        }
        return null;
      }

      const spadeUrl = spadeUrlMatch[1];
      logger.verbose(`✅  Found spade_url for ${username}: ${spadeUrl.substring(0, 50)}...`);
      return spadeUrl;
    } catch (error: any) {
      logger.error(`❌  Error getting spade_url for ${username}:`, error.message || error);
      return null;
    }
  }

  /**
   * Обновляет информацию о стримере
   * @param streamerInfo Информация о стримере
   * @returns Обновленная информация о стримере
   */
  async updateStreamerInfo(streamerInfo: StreamerInfo): Promise<StreamerInfo> {
    try {
      // Получаем информацию о стриме
      const streamInfo = await this.graphqlClient.getStreamInfo(streamerInfo.username);

      if (streamInfo) {
        // Стример онлайн
        const wasOffline = !streamerInfo.isOnline;
        streamerInfo.isOnline = true;
        streamerInfo.broadcastId = streamInfo.broadcastId;
        streamerInfo.title = streamInfo.title;
        streamerInfo.game = streamInfo.game?.name || null;
        streamerInfo.tags = streamInfo.tags.map((tag: any) => tag.localizedName || tag.name);

        // Если стример только что перешел из офлайн в онлайн, сбрасываем startTime
        if (wasOffline) {
          streamerInfo.startTime = Date.now();
          logger.verbose(`🔄  [${streamerInfo.username}] Streamer came online, resetting watch time`);
        }

        // Получаем spade_url, если еще не получен
        if (!streamerInfo.spadeUrl) {
          streamerInfo.spadeUrl = await this.getSpadeUrl(streamerInfo.username);
        }

        // Получаем информацию о баллах
        const pointsInfo = await this.graphqlClient.getChannelPoints(streamerInfo.username);
        if (pointsInfo) {
          streamerInfo.channelPoints = pointsInfo.balance;
          // Обновляем lastChannelPoints для корректного расчета заработанных баллов
          streamerInfo.lastChannelPoints = pointsInfo.balance;
          
          // Если initialChannelPoints еще не установлен или стример только что вернулся онлайн, устанавливаем его
          if (streamerInfo.initialChannelPoints === null || wasOffline) {
            streamerInfo.initialChannelPoints = pointsInfo.balance;
          }
          
          // НЕ собираем бонус здесь - это делается через WebSocket событие claim-available
          // Это предотвращает дублирование попыток сбора бонуса
          // WebSocket более надежен и отправляет события в реальном времени
        } else {
          // Логируем, если не удалось получить баллы (только в verbose, так как баллы обновляются через WebSocket)
          logger.verbose(`⚠️  [${streamerInfo.username}] Не удалось получить информацию о баллах канала (баллы обновляются через WebSocket)`);
        }
      } else {
        // Стример офлайн
        const wasOnline = streamerInfo.isOnline;
        streamerInfo.isOnline = false;
        streamerInfo.broadcastId = null;
        // Очищаем spade_url для офлайн стримера
        streamerInfo.spadeUrl = null;
        
        // Если стример только что ушел офлайн, сбрасываем startTime
        if (wasOnline) {
          streamerInfo.startTime = 0;
          logger.verbose(`🔄  [${streamerInfo.username}] Streamer went offline, resetting watch time`);
        }
      }
    } catch (error: any) {
      // Обрабатываем ошибки GraphQL (например, service timeout)
      if (error.message && error.message.includes('timeout')) {
        logger.info(`⏱️  [${streamerInfo.username}] Timeout при обновлении информации (возможно, стример офлайн)`);
        // Помечаем стримера как офлайн при timeout
        const wasOnline = streamerInfo.isOnline;
        streamerInfo.isOnline = false;
        streamerInfo.broadcastId = null;
        streamerInfo.spadeUrl = null;
        
        // Если стример был онлайн, сбрасываем startTime
        if (wasOnline) {
          streamerInfo.startTime = 0;
          logger.verbose(`🔄  [${streamerInfo.username}] Streamer went offline (timeout), resetting watch time`);
        }
      } else {
        logger.error(`❌  Error updating streamer info for ${streamerInfo.username}:`, error.message || error);
      }
    }

    return streamerInfo;
  }

  /**
   * Создает payload для события minute-watched
   * @param streamerInfo Информация о стримере
   * @returns Payload для отправки
   */
  async createMinuteWatchedPayload(streamerInfo: StreamerInfo): Promise<{ data: string } | null> {
    if (!streamerInfo.isOnline || !streamerInfo.broadcastId) {
      logger.warn(`⚠️  [${streamerInfo.username}] Cannot create payload: isOnline=${streamerInfo.isOnline}, broadcastId=${streamerInfo.broadcastId}`);
      return null;
    }

    // ВАЖНО: user_id в payload должен быть ID пользователя (того, кто смотрит), а не ID канала стримера
    // Используем валидированный user_id (из валидации токена), если он доступен
    let userId: string;
    if (this.validatedUserId) {
      userId = this.validatedUserId;
    } else if (this.userId) {
      // Если валидированный user_id не установлен, используем кэшированный
      // Но это может быть ID канала стримера, что неправильно
      userId = this.userId;
      logger.warn(`⚠️  [${streamerInfo.username}] Using cached user_id (may be incorrect if it's channel ID)`);
    } else {
      // Пытаемся получить user_id через валидацию токена
      logger.verbose(`⚠️  [${streamerInfo.username}] User ID not cached, attempting to get from token validation...`);
      try {
        const response = await fetchWithRetry(
          'https://id.twitch.tv/oauth2/validate',
          {
            method: 'GET',
            headers: {
              'Authorization': `OAuth ${this.authToken}`,
            },
          },
          {
            maxAttempts: this.retryConfig.maxAttempts,
            initialDelayMs: this.retryConfig.initialDelayMs,
            maxDelayMs: this.retryConfig.maxDelayMs,
            multiplier: this.retryConfig.multiplier,
            jitter: this.retryConfig.jitter,
          },
          'getUserIdFromToken'
        );
        
        if (response.status === 200) {
          const data = await response.json();
          userId = data.user_id?.toString();
          if (userId) {
            this.validatedUserId = userId;
            logger.verbose(`✅  User ID obtained from token validation: ${userId}`);
          } else {
            throw new Error('No user_id in validation response');
          }
        } else {
          throw new Error(`Token validation failed: ${response.status}`);
        }
      } catch (error: any) {
        logger.error(`❌  Failed to get user ID from token validation: ${error.message || error}`);
        // В крайнем случае используем channelId, но это неправильно
        logger.warn(`⚠️  Using channelId as fallback (this may cause issues)`);
        userId = streamerInfo.channelId;
      }
    }

    const payload: MinuteWatchedPayload[] = [
      {
        event: 'minute-watched',
        properties: {
          channel_id: streamerInfo.channelId,
          broadcast_id: streamerInfo.broadcastId,
          player: 'site',
          user_id: userId,
          ...(streamerInfo.game ? { game: streamerInfo.game } : {}),
        },
      },
    ];

    // Логируем payload для отладки (только в verbose режиме)
    logger.verbose(`🔍  [${streamerInfo.username}] Payload:`, JSON.stringify(payload, null, 2));

    return encodePayload(payload);
  }

  /**
   * Отправляет событие minute-watched на spade_url
   * @param streamerInfo Информация о стримере
   * @returns true если успешно отправлено
   */
  async sendMinuteWatched(streamerInfo: StreamerInfo): Promise<boolean> {
    // Проверяем, что стример онлайн перед отправкой
    if (!streamerInfo.isOnline) {
      return false;
    }
    
    if (!streamerInfo.spadeUrl) {
      return false;
    }

    try {
      const payload = await this.createMinuteWatchedPayload(streamerInfo);
      if (!payload) {
        return false;
      }

      // Spade URL принимает данные в формате form-data
      const formData = new URLSearchParams();
      formData.append('data', payload.data);

      const response = await fetchWithRetry(
        streamerInfo.spadeUrl,
        {
          method: 'POST',
          headers: {
            'User-Agent': this.userAgent,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
        {
          maxAttempts: this.retryConfig.maxAttempts,
          initialDelayMs: this.retryConfig.initialDelayMs,
          maxDelayMs: this.retryConfig.maxDelayMs,
          multiplier: this.retryConfig.multiplier,
          jitter: this.retryConfig.jitter,
        },
        `sendMinuteWatched:${streamerInfo.username}`
      );

      const isSuccess = response.status === 204;
      
      if (isSuccess) {
        logger.verbose(`✅  [${streamerInfo.username}] Minute watched event accepted by Twitch (status: ${response.status})`);
      } else {
        const responseText = await response.text().catch(() => 'Unable to read response');
        logger.warn(`⚠️  [${streamerInfo.username}] Minute watched event returned status ${response.status}: ${responseText.substring(0, 200)}`);
      }
      
      return isSuccess;
    } catch (error: any) {
      logger.error(`❌  Error sending minute-watched for ${streamerInfo.username}:`, error.message || error);
      return false;
    }
  }

  /**
   * Инициализирует информацию о стримере
   * @param username Имя стримера
   * @returns Информация о стримере
   */
  async initializeStreamer(username: string): Promise<StreamerInfo | null> {
    try {
      // Получаем ID канала
      const channelId = await this.graphqlClient.getChannelId(username);
      if (!channelId) {
        logger.error(`❌  Failed to get channel ID for ${username}`);
        return null;
      }

      // Проверяем, онлайн ли стример
      const broadcastId = await this.graphqlClient.checkStreamerOnline(channelId);

      const streamerInfo: StreamerInfo = {
        username,
        channelId,
        channelPoints: 0,
        isOnline: broadcastId !== null,
        broadcastId,
        game: null,
        title: null,
        tags: [],
        spadeUrl: null,
        startTime: 0,
        initialChannelPoints: null,
        lastChannelPoints: null,
      };

      // Если онлайн, получаем полную информацию
      if (streamerInfo.isOnline) {
        await this.updateStreamerInfo(streamerInfo);
        streamerInfo.startTime = Date.now();
        
        // Получаем начальные баллы
        const pointsInfo = await this.graphqlClient.getChannelPoints(username);
        if (pointsInfo) {
          streamerInfo.initialChannelPoints = pointsInfo.balance;
          streamerInfo.lastChannelPoints = pointsInfo.balance;
          streamerInfo.channelPoints = pointsInfo.balance;
          logger.info(`💰  [${username}] Initial points: ${pointsInfo.balance}`);
        } else {
          // Это не критично - баллы обновятся через WebSocket при первом событии points-earned
          logger.verbose(`ℹ️  [${username}] Initial points not available via GraphQL, will be set from WebSocket`);
        }
      }

      return streamerInfo;
    } catch (error: any) {
      logger.error(`❌  Error initializing streamer ${username}:`, error.message || error);
      return null;
    }
  }
}

