/**
 * API клиент для работы с Twitch
 */

import { GraphQLClient } from './GraphQLClient';
import { StreamerInfo, MinuteWatchedPayload, TokenValidationResult, TokenInfo } from './types';
import { extractSpadeUrl, extractSettingsUrl, encodePayload } from './utils';
import { logger } from './logger';
import { fetchWithRetry, RetryConfig } from './retry';
import { loadRetryConfig } from './configLoader';
import { CLIENT_ID } from './constants';
import { isNetworkError } from './errorUtils';
import { getWebSocketOnlineGraceMs } from './streamOnlineGrace';

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
  /** Троттлинг повторяющихся сетевых ошибок spade/minute-watched в логах */
  private lastSpadeErrorLogAt = new Map<string, number>();
  private static readonly SPADE_ERROR_LOG_THROTTLE_MS = 120000;

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
      const fetchTimeoutMs = parseInt(process.env.FETCH_TIMEOUT_MS || '20000', 10);
      const response = await fetch('https://id.twitch.tv/oauth2/validate', {
        method: 'GET',
        headers: {
          'Authorization': `OAuth ${this.authToken}`,
        },
        signal: AbortSignal.timeout(fetchTimeoutMs),
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
        // Токен невалиден (401) или другая ошибка от API
        return {
          isValid: false,
          errorType: 'invalid',
        };
      }
    } catch (error: any) {
      const msg = error.message || String(error);
      if (isNetworkError(error)) {
        logger.warn(`⚠️  Сетевая ошибка при валидации токена (id.twitch.tv): ${msg}`);
        if (error.code) {
          logger.warn(`   Код ошибки: ${error.code}`);
        }
        return {
          isValid: false,
          errorType: 'network',
        };
      }
      logger.verbose(`⚠️  Token validation error: ${msg}`);
      return {
        isValid: false,
        errorType: 'invalid',
      };
    }
  }

  /**
   * Получает ID пользователя через Helix API (REST)
   * @param username Имя пользователя
   * @returns ID пользователя или null
   */
  private async getUserIdViaHelix(username: string): Promise<string | null> {
    // Helix API требует параметр login в query string
    // Формат: GET https://api.twitch.tv/helix/users?login={username}
    const url = `https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`;
    logger.info(`🔍  [Helix API] Attempting to get user ID for ${username}`);
    logger.info(`🔍  [Helix API] Full URL: ${url}`);
    logger.info(`🔍  [Helix API] Client-ID: ${CLIENT_ID}`);
    logger.info(`🔍  [Helix API] Token present: ${this.authToken ? 'Yes (length: ' + this.authToken.length + ', starts with: ' + this.authToken.substring(0, 10) + '...)' : 'No'}`);
    
    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.authToken}`,
        'Client-Id': CLIENT_ID,
      };
      
      logger.verbose(`🔍  [Helix API] Request headers: ${JSON.stringify(headers).replace(this.authToken, '***TOKEN***')}`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers,
      });

      logger.info(`🔍  [Helix API] Response status: ${response.status} ${response.statusText}`);
      
      // Логируем заголовки ответа для отладки
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      logger.verbose(`🔍  [Helix API] Response headers: ${JSON.stringify(responseHeaders)}`);
      
      const responseText = await response.text();
      logger.info(`🔍  [Helix API] Response body: ${responseText.substring(0, 1000)}`);
      
      if (response.status === 200) {
        const data = JSON.parse(responseText);
        logger.verbose(`🔍  [Helix API] Parsed data: ${JSON.stringify(data).substring(0, 500)}`);
        
        if (data.data && Array.isArray(data.data) && data.data.length > 0) {
          const userId = data.data[0].id;
          logger.info(`✅  [Helix API] Successfully got user ID for ${username}: ${userId}`);
          return userId;
        } else {
          logger.warn(`⚠️  [Helix API] No data in response for ${username}. Response structure: ${JSON.stringify(data).substring(0, 200)}`);
        }
      } else if (response.status === 401) {
        logger.error(`❌  [Helix API] Unauthorized (401) - token may be invalid or expired`);
        logger.error(`❌  [Helix API] Response: ${responseText.substring(0, 500)}`);
      } else if (response.status === 403) {
        logger.error(`❌  [Helix API] Forbidden (403) - Client-ID may be invalid or token doesn't have required scopes`);
        logger.error(`❌  [Helix API] Response: ${responseText.substring(0, 500)}`);
      } else if (response.status === 404) {
        logger.error(`❌  [Helix API] Not Found (404) - user ${username} may not exist, or endpoint/format is incorrect`);
        logger.error(`❌  [Helix API] Response: ${responseText.substring(0, 500)}`);
        logger.error(`❌  [Helix API] This might indicate: 1) User doesn't exist, 2) Token doesn't have required scopes, 3) Client-ID is invalid`);
      } else {
        logger.error(`❌  [Helix API] Unexpected status ${response.status} for user ${username}`);
        logger.error(`❌  [Helix API] Response: ${responseText.substring(0, 500)}`);
      }
    } catch (error: any) {
      logger.error(`❌  [Helix API] Error getting user ID: ${error.message || error}`);
      logger.error(`❌  [Helix API] Error stack: ${error.stack || 'No stack trace'}`);
    }
    
    return null;
  }

  /**
   * Получает ID пользователя
   * Сначала пробует GraphQL, затем Helix API как fallback
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

    // Объявляем userId в начале функции для использования во всех блоках
    let userId: string | null = null;

    // Сначала пробуем GraphQL
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

    try {
      const response = await this.graphqlClient.postRequest(operation);
      
      // Пробуем получить user ID из разных мест в ответе
      if (response.data?.user?.id) {
        userId = response.data.user.id;
      } else if (response.data?.currentUser?.id) {
        userId = response.data.currentUser.id;
      } else if (response.data?.self?.id) {
        userId = response.data.self.id;
      }
      
      if (userId) {
        this.userId = userId;
        logger.verbose(`✅  User ID obtained via GraphQL: ${userId}`);
        return userId;
      }
      
      // Если GraphQL вернул ошибку PersistedQueryNotFound, используем Helix API
      if (response.errors && response.errors.some((e: any) => e.message === 'PersistedQueryNotFound')) {
        logger.info(`⚠️  GraphQL ReportMenuItem query not found, falling back to Helix API for ${username}`);
        userId = await this.getUserIdViaHelix(username);
        if (userId) {
          this.userId = userId;
          logger.info(`✅  User ID obtained via Helix API: ${userId}`);
          return userId;
        }
      }
    } catch (error: any) {
      // При ошибке GraphQL пробуем Helix API
      logger.info(`⚠️  GraphQL error for getUserId, falling back to Helix API: ${error.message || error}`);
      userId = await this.getUserIdViaHelix(username);
      if (userId) {
        this.userId = userId;
        logger.info(`✅  User ID obtained via Helix API: ${userId}`);
        return userId;
      }
    }
    
    // Если GraphQL не вернул данные, пробуем Helix API
    logger.info(`⚠️  GraphQL didn't return user ID, falling back to Helix API for ${username}`);
    userId = await this.getUserIdViaHelix(username);
    if (userId) {
      this.userId = userId;
      logger.info(`✅  User ID obtained via Helix API: ${userId}`);
      return userId;
    }

    logger.error(`❌  Failed to get user ID for ${username} via both GraphQL and Helix API`);
    throw new Error(`Failed to get user ID for ${username}`);
  }

  /** Быстрый retry для spade (кратковременные сбои сети) */
  private getSpadeRetryConfig(): Partial<RetryConfig> {
    return {
      maxAttempts: 4,
      initialDelayMs: 500,
      maxDelayMs: 8000,
      multiplier: 2,
      jitter: true,
    };
  }

  /**
   * Логирует сетевую ошибку spade без спама (не путаем с отсутствием интернета)
   */
  private logSpadeNetworkError(username: string, operation: string, error: any): void {
    const key = `${username}:${operation}`;
    const now = Date.now();
    const last = this.lastSpadeErrorLogAt.get(key) || 0;
    if (now - last < TwitchAPI.SPADE_ERROR_LOG_THROTTLE_MS) {
      return;
    }
    this.lastSpadeErrorLogAt.set(key, now);
    const msg = error.message || String(error);
    logger.warn(
      `⚠️  [${username}] ${operation}: кратковременный сбой сети (${msg}) — повтор на следующем цикле (~1 мин)`
    );
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
        this.getSpadeRetryConfig(),
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
        this.getSpadeRetryConfig(),
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
      if (isNetworkError(error)) {
        this.logSpadeNetworkError(username, 'получение spade_url', error);
      } else {
        logger.error(`❌  Error getting spade_url for ${username}:`, error.message || error);
      }
      return null;
    }
  }

  /**
   * Обновляет информацию о стримере
   * @param streamerInfo Информация о стримере
   * @param options allowOfflineDemotion=false — не сбрасывать ONLINE сразу после WebSocket stream-up
   * @returns Обновленная информация о стримере
   */
  async updateStreamerInfo(
    streamerInfo: StreamerInfo,
    options?: { allowOfflineDemotion?: boolean }
  ): Promise<StreamerInfo> {
    // Периодически проверяем статус через GraphQL как fallback
    // WebSocket события stream-up/stream-down являются основным источником статуса
    // но GraphQL проверка нужна для случаев, когда WebSocket события не приходят
    try {
      const streamInfo = await this.graphqlClient.getStreamInfo(
        streamerInfo.username,
        streamerInfo.channelId
      );

      if (streamInfo) {
        // Стример онлайн
        const wasOnline = streamerInfo.isOnline;
        streamerInfo.isOnline = true;
        streamerInfo.broadcastId = streamInfo.broadcastId;
        streamerInfo.title = streamInfo.title;
        streamerInfo.game = streamInfo.game?.name || null;
        streamerInfo.tags = streamInfo.tags.map((tag: any) => tag.localizedName || tag.name);
        
        // startTime: при переходе в онлайн или если уже онлайн, но время не задано (GraphQL при init)
        if (!wasOnline) {
          streamerInfo.startTime = Date.now();
        } else if (!streamerInfo.startTime || streamerInfo.startTime <= 0) {
          streamerInfo.startTime = Date.now();
        }

        // Получаем spade_url, если еще не получен
        if (!streamerInfo.spadeUrl) {
          streamerInfo.spadeUrl = await this.getSpadeUrl(streamerInfo.username);
        }

        // Пробуем получить баллы (опционально)
        // Обновляем channelPoints периодически для актуальности данных
        // даже если initialChannelPoints уже установлен
        try {
          const pointsInfo = await this.graphqlClient.getChannelPoints(streamerInfo.username);
          if (pointsInfo) {
            // Если начальные баллы еще не установлены, устанавливаем их
            if (streamerInfo.initialChannelPoints === null) {
              streamerInfo.initialChannelPoints = pointsInfo.balance;
              streamerInfo.lastChannelPoints = pointsInfo.balance;
              streamerInfo.channelPoints = pointsInfo.balance;
              logger.verbose(`💰  [${streamerInfo.username}] Initial points set via GraphQL: ${pointsInfo.balance}`);
            } else {
              // Обновляем текущие баллы для актуальности данных
              streamerInfo.channelPoints = pointsInfo.balance;
              streamerInfo.lastChannelPoints = pointsInfo.balance;
              if (streamerInfo.initialChannelPoints !== null) {
                streamerInfo.streamPointsEarned = pointsInfo.balance - streamerInfo.initialChannelPoints;
              }
            }
          }
        } catch (e: any) {
          // Не критично - баллы обновятся через WebSocket
          logger.verbose(`⚠️  [${streamerInfo.username}] Не удалось получить баллы через GraphQL (будут обновлены через WebSocket)`);
        }
      } else {
        // streamInfo null может означать, что стример офлайн ИЛИ GraphQL недоступен
        // Проверяем состояние CircuitBreaker перед установкой isOnline = false
        const circuitBreakerState = this.graphqlClient.getCircuitBreakerState?.();
        const isCircuitBreakerOpen = circuitBreakerState === 'OPEN' || circuitBreakerState === 'HALF_OPEN';
        
        // Устанавливаем isOnline = false только если:
        // 1. Стример был онлайн
        // 2. CircuitBreaker не открыт (GraphQL доступен)
        // Это предотвращает установку isOnline=false из-за недоступности GraphQL
        const graphqlUnavailable =
          isCircuitBreakerOpen ||
          this.graphqlClient.hadRecentNetworkFailure() ||
          this.graphqlClient.hadRecentStreamInfoQueryFailure();
        const allowOfflineDemotion = options?.allowOfflineDemotion !== false;
        if (streamerInfo.isOnline && !graphqlUnavailable && allowOfflineDemotion) {
          const wsAt = streamerInfo.webSocketOnlineAt ?? 0;
          const onlineAgeMs =
            wsAt > 0
              ? Date.now() - wsAt
              : streamerInfo.startTime > 0
                ? Date.now() - streamerInfo.startTime
                : Number.POSITIVE_INFINITY;
          if (onlineAgeMs < getWebSocketOnlineGraceMs()) {
            logger.verbose(
              `⚠️  [${streamerInfo.username}] GraphQL: стрим не найден (${Math.round(onlineAgeMs / 1000)}s после stream-up) — оставляем ONLINE (WebSocket)`
            );
          } else {
            logger.info(`📴  [${streamerInfo.username}] GraphQL check: streamer is OFFLINE`);
            streamerInfo.isOnline = false;
            streamerInfo.webSocketOnlineAt = undefined;
            streamerInfo.startTime = 0;
          }
        } else if (streamerInfo.isOnline && graphqlUnavailable) {
          // GraphQL недоступен — не помечаем офлайн, полагаемся на WebSocket
          logger.verbose(
            `⚠️  [${streamerInfo.username}] GraphQL unavailable (CB: ${circuitBreakerState ?? 'n/a'}, network), keeping current status`
          );
        }
      }
    } catch (error: any) {
      // Ошибки GraphQL не критичны - WebSocket события обновят статус
      // Но если стример был онлайн и произошла ошибка, не меняем статус
      // (предполагаем, что WebSocket события более надежны)
      logger.verbose(`⚠️  [${streamerInfo.username}] GraphQL update failed (non-critical): ${error.message || error}`);
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
        this.getSpadeRetryConfig(),
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
      if (isNetworkError(error)) {
        this.logSpadeNetworkError(streamerInfo.username, 'minute-watched', error);
      } else {
        logger.error(`❌  Error sending minute-watched for ${streamerInfo.username}:`, error.message || error);
      }
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
        streamPointsEarned: 0,
      };

      // Если онлайн, пробуем получить метаданные (опционально)
      // WebSocket события stream-up/stream-down более надежны для определения статуса
      if (streamerInfo.isOnline) {
        await this.updateStreamerInfo(streamerInfo);

        // startTime задаётся в StreamWatcher.restoreWatchSessionAfterRestart()
        try {
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
        } catch (error: any) {
          // Не критично - баллы будут установлены через WebSocket
          logger.verbose(`ℹ️  [${username}] Failed to get initial points via GraphQL (will be set from WebSocket): ${error.message || error}`);
        }
      }

      return streamerInfo;
    } catch (error: any) {
      logger.error(`❌  Error initializing streamer ${username}:`, error.message || error);
      return null;
    }
  }
}

