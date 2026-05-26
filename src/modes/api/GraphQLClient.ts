/**
 * Клиент для работы с GraphQL API Twitch
 */

import { ClaimBonusResult, GraphQLOperation, GraphQLResponse } from './types';
import { GraphqlHealthSnapshot } from './botHealthTypes';
import { GQL_URL, CLIENT_ID, GQL_OPERATIONS } from './constants';
import { logger } from './logger';
import { retryWithExponentialBackoff, RetryConfig } from './retry';
import { CircuitBreaker } from './CircuitBreaker';
import { loadRetryConfig } from './configLoader';
import { shouldRetry, isNetworkError } from './errorUtils';
import { TwitchIntegrityProvider } from './TwitchIntegrity';
import { buildTwitchGqlHeaders } from './twitchGqlContext';
import { canRefreshIntegrityViaApi } from './integrityConfig';

/** Коды ClaimCommunityPoints, при которых повтор бесполезен */
const PERMANENT_CLAIM_ERROR_CODES = new Set([
  'FORBIDDEN',
  'CLAIM_ALREADY_CLAIMED',
  'UNAUTHORIZED',
  'NOT_FOUND',
]);

/**
 * Клиент для выполнения GraphQL запросов к Twitch
 */
export class GraphQLClient {
  private authToken: string;
  private userAgent: string;
  private circuitBreaker: CircuitBreaker;
  private retryConfig: RetryConfig;
  private integrityProvider: TwitchIntegrityProvider;
  /** Время последней сетевой ошибки (для защиты от ложного OFFLINE) */
  private lastNetworkFailureAt = 0;
  /** Не удалось надёжно определить статус стрима (сломанный persisted/full query) */
  private lastStreamInfoQueryFailureAt = 0;
  /** Некритичные операции — баллы/статус дублируются через WebSocket */
  private static readonly NON_CRITICAL_OPERATIONS = [
    'ChannelPointsContext',
    'VideoPlayerStreamInfoOverlayChannel',
  ];
  /** Троттлинг повторяющихся сетевых ошибок в логах (мс) */
  private lastNetworkErrorLogAt = new Map<string, number>();
  private static readonly NETWORK_ERROR_LOG_THROTTLE_MS = 120000;

  /**
   * Создает экземпляр GraphQL клиента
   * @param authToken Токен авторизации Twitch
   * @param userAgent User-Agent для запросов
   */
  constructor(authToken: string, userAgent: string) {
    this.authToken = authToken;
    this.userAgent = userAgent;
    
    // Загружаем конфигурацию retry
    const config = loadRetryConfig();
    this.retryConfig = config;
    
    // Создаем Circuit Breaker для защиты от каскадных сбоев
    const cbConfig = config.circuitBreaker || {
      failureThreshold: 5,
      resetTimeoutMs: 30000,
      halfOpenMaxAttempts: 1,
    };
    this.circuitBreaker = new CircuitBreaker('GraphQL', cbConfig);
    this.integrityProvider = new TwitchIntegrityProvider(authToken, userAgent);
  }

  /**
   * Получает состояние CircuitBreaker
   * @returns Состояние CircuitBreaker ('CLOSED', 'OPEN', 'HALF_OPEN')
   */
  getCircuitBreakerState(): 'CLOSED' | 'OPEN' | 'HALF_OPEN' {
    return this.circuitBreaker.getState();
  }

  /**
   * Снимок GraphQL для dashboard
   */
  getHealthSnapshot(): GraphqlHealthSnapshot {
    return {
      circuitBreaker: this.getCircuitBreakerState(),
      hadRecentNetworkFailure: this.hadRecentNetworkFailure(),
    };
  }

  /**
   * Провайдер Client-Integrity (для bot-health)
   */
  getIntegrityProvider(): TwitchIntegrityProvider {
    return this.integrityProvider;
  }

  /**
   * Была ли недавно сетевая ошибка при запросах к GraphQL
   * @param withinMs Окно в миллисекундах (по умолчанию 2 минуты)
   */
  hadRecentNetworkFailure(withinMs: number = 120000): boolean {
    return this.lastNetworkFailureAt > 0 && Date.now() - this.lastNetworkFailureAt < withinMs;
  }

  /**
   * Был ли недавно сбой определения статуса стрима через GraphQL (не подтверждённый OFFLINE)
   */
  hadRecentStreamInfoQueryFailure(withinMs: number = 120000): boolean {
    return (
      this.lastStreamInfoQueryFailureAt > 0 &&
      Date.now() - this.lastStreamInfoQueryFailureAt < withinMs
    );
  }

  private markStreamInfoQueryFailure(): void {
    this.lastStreamInfoQueryFailureAt = Date.now();
  }

  private clearStreamInfoQueryFailure(): void {
    this.lastStreamInfoQueryFailureAt = 0;
  }

  private static hasUnreliableGraphQLErrors(response: GraphQLResponse): boolean {
    return Boolean(
      response.errors?.some((e: { message?: string }) => {
        const msg = e.message ?? '';
        return (
          msg.includes('PersistedQueryNotFound') ||
          msg.includes('Cannot query field')
        );
      })
    );
  }

  /**
   * Минимальная информация о стриме по channelId (fallback WhenIsStreamLiveQuery)
   */
  private async getStreamInfoViaLiveQuery(channelId: string): Promise<{
    broadcastId: string;
    title: string;
    game: null;
    tags: [];
    viewersCount: number;
  } | null> {
    const liveId = await this.checkStreamerOnline(channelId);
    if (!liveId) {
      return null;
    }
    return {
      broadcastId: liveId,
      title: '',
      game: null,
      tags: [],
      viewersCount: 0,
    };
  }

  private markNetworkFailure(error: any): void {
    if (isNetworkError(error)) {
      this.lastNetworkFailureAt = Date.now();
    }
  }

  private clearNetworkFailure(): void {
    this.lastNetworkFailureAt = 0;
  }

  /**
   * Логирует ошибку GraphQL без спама (некритичные операции — кратко, с троттлингом)
   */
  private logGraphQLError(operationName: string, error: any): void {
    const isNonCritical = GraphQLClient.NON_CRITICAL_OPERATIONS.includes(operationName);
    const errorMessage = error.message || String(error);
    const now = Date.now();
    const lastLogged = this.lastNetworkErrorLogAt.get(operationName) || 0;
    const shouldLog = now - lastLogged >= GraphQLClient.NETWORK_ERROR_LOG_THROTTLE_MS;

    if (isNetworkError(error)) {
      if (isNonCritical) {
        if (shouldLog) {
          this.lastNetworkErrorLogAt.set(operationName, now);
          logger.verbose(
            `⚠️  [GraphQL:${operationName}] Кратковременный сбой gql.twitch.tv (${errorMessage}) — баллы/статус через WebSocket`
          );
        }
        return;
      }
      if (!shouldLog) {
        return;
      }
      this.lastNetworkErrorLogAt.set(operationName, now);
      logger.warn(`⚠️  [GraphQL:${operationName}] Сетевая ошибка gql.twitch.tv: ${errorMessage}`);
      if (error.code) {
        logger.verbose(`   Код ошибки: ${error.code}`);
      }
      return;
    }

    if (errorMessage.includes('timeout')) {
      if (isNonCritical) {
        if (shouldLog) {
          this.lastNetworkErrorLogAt.set(operationName, now);
          logger.verbose(`⚠️  [GraphQL:${operationName}] Таймаут gql.twitch.tv — не критично`);
        }
        return;
      }
      if (shouldLog) {
        this.lastNetworkErrorLogAt.set(operationName, now);
        logger.warn(`⚠️  [GraphQL:${operationName}] Таймаут при запросе к gql.twitch.tv`);
      }
      return;
    }

    if (isNonCritical) {
      logger.verbose(`⚠️  [GraphQL:${operationName}] ${errorMessage}`);
      return;
    }
    logger.error(`Error with GraphQL operation (${operationName}):`, errorMessage);
  }

  /**
   * Выполняет GraphQL запрос с retry и Circuit Breaker
   * @param operation GraphQL операция
   * @returns Ответ от сервера
   */
  async postRequest(
    operation: GraphQLOperation,
    options?: { requireIntegrity?: boolean }
  ): Promise<GraphQLResponse> {
    // Используем Circuit Breaker для защиты от каскадных сбоев
    return this.circuitBreaker.execute(async () => {
      // Используем retry с экспоненциальной задержкой
      return retryWithExponentialBackoff(
        async () => {
          const fetchTimeoutMs = parseInt(process.env.FETCH_TIMEOUT_MS || '20000', 10);
          let integrityToken: string | undefined;
          if (options?.requireIntegrity) {
            integrityToken = await this.integrityProvider.getToken();
          }

          const headers = await buildTwitchGqlHeaders({
            authToken: this.authToken,
            userAgent: this.userAgent,
            clientId: CLIENT_ID,
            deviceId: options?.requireIntegrity
              ? this.integrityProvider.getDeviceId()
              : undefined,
            integrityToken,
          });

          const response = await fetch(GQL_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(operation),
            signal: AbortSignal.timeout(fetchTimeoutMs),
          });

          // Проверяем статус ответа
          if (!response.ok) {
            const error: any = new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
            error.status = response.status;
            error.statusCode = response.status;
            error.response = response;
            
            // Если это не временная ошибка, не повторяем
            if (!shouldRetry(error, response.status)) {
              throw error;
            }
            
            throw error;
          }

          const data = await response.json();
          this.clearNetworkFailure();

          // Логируем ошибки из ответа
          if (data.errors && data.errors.length > 0) {
            for (const error of data.errors) {
              // Улучшаем читаемость для конкретных ошибок
              if (error.message === 'failed integrity check') {
                // Это нормальная ошибка - бонус уже собран или недоступен
                // Не логируем как ошибку, так как это обрабатывается в вызывающем коде
                // Можно логировать только в debug режиме, если нужно
              } else if (error.message && error.message.includes('service timeout')) {
                // Service timeout - это нормально при переходе стримера в офлайн, не логируем как ошибку
              } else if (error.message && error.message.includes('PersistedQueryNotFound')) {
                // PersistedQueryNotFound - это не критичная ошибка
                // Для ChannelPointsContext и VideoPlayerStreamInfoOverlayChannel логируем только в verbose,
                // так как эти данные обновляются через WebSocket в реальном времени
                if (GraphQLClient.NON_CRITICAL_OPERATIONS.includes(operation.operationName)) {
                  logger.verbose(`⚠️  PersistedQueryNotFound for ${operation.operationName} - данные обновляются через WebSocket`);
                } else {
                  logger.error(`❌  GraphQL error for ${operation.operationName}: ${error.message}`);
                }
              } else if (error.message && error.message.includes('Cannot query field')) {
                // Ошибка "Cannot query field" означает, что структура API изменилась
                // Это не критично для операций, которые имеют альтернативные источники данных
                if (GraphQLClient.NON_CRITICAL_OPERATIONS.includes(operation.operationName)) {
                  logger.verbose(`⚠️  GraphQL API changed for ${operation.operationName}: ${error.message} - используем альтернативные источники`);
                } else {
                  logger.error(`❌  GraphQL error for ${operation.operationName}: ${error.message}`);
                }
              } else {
                // Для других ошибок выводим полную информацию
                logger.error(`❌  GraphQL error for ${operation.operationName}: ${error.message}`);
                if (error.path && error.path.length > 0) {
                  logger.verbose(`   Path: ${error.path.join(' -> ')}`);
                }
              }
            }
          }
          
          // Логируем пустой ответ для отладки
          if (!data || Object.keys(data).length === 0) {
            logger.error(`Empty response for ${operation.operationName}. Status: ${response.status}`);
            const text = await response.text();
            logger.verbose(`Response text: ${text.substring(0, 500)}`);
          }
          
          return data;
        },
        {
          maxAttempts: this.retryConfig.maxAttempts,
          initialDelayMs: this.retryConfig.initialDelayMs,
          maxDelayMs: this.retryConfig.maxDelayMs,
          multiplier: this.retryConfig.multiplier,
          jitter: this.retryConfig.jitter,
        },
        `GraphQL:${operation.operationName}`
      );
    }).catch((error: any) => {
      this.markNetworkFailure(error);

      // Если Circuit Breaker открыт, логируем это
      if (error.circuitBreakerOpen) {
        logger.warn(`⚠️  [GraphQL:${operation.operationName}] Circuit Breaker OPEN, запрос заблокирован`);
        return { errors: [] };
      }
      
      const isNonCritical = GraphQLClient.NON_CRITICAL_OPERATIONS.includes(operation.operationName);
      const isNonCriticalError = error.message && (
        error.message.includes('PersistedQueryNotFound') ||
        error.message.includes('Cannot query field')
      );

      if (isNonCritical && isNonCriticalError) {
        logger.verbose(
          `⚠️  [GraphQL:${operation.operationName}] ${error.message} - данные обновляются через альтернативные источники`
        );
      } else {
        this.logGraphQLError(operation.operationName, error);
      }
      
      return { errors: [{ message: error.message || 'Unknown error' }] };
    });
  }


  /**
   * Получает ID канала по имени пользователя через Helix API (REST)
   * @param username Имя пользователя
   * @returns ID канала или null
   */
  private async getChannelIdViaHelix(username: string): Promise<string | null> {
    // Helix API требует параметр login в query string
    // Формат: GET https://api.twitch.tv/helix/users?login={username}
    const url = `https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`;
    logger.info(`🔍  [Helix API] Attempting to get channel ID for ${username}`);
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
          logger.info(`✅  [Helix API] Successfully got channel ID for ${username}: ${userId}`);
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
      const errorMessage = error.message || String(error);
      logger.error(`❌  [Helix API] Error getting channel ID: ${errorMessage}`);
      
      // Детальная диагностика сетевых ошибок
      if (isNetworkError(error)) {
        this.lastNetworkFailureAt = Date.now();
        logger.error(`❌  [Helix API] Сетевая ошибка при подключении к api.twitch.tv`);
        logger.error(`   Возможные причины:`);
        logger.error(`   - Проблемы с DNS (проверьте резолвинг gql.twitch.tv)`);
        logger.error(`   - Проблемы с интернет-соединением`);
        logger.error(`   - Блокировка доступа к Twitch (прокси, файрвол)`);
        logger.error(`   - Таймаут соединения`);
        if (error.code) {
          logger.error(`   Код ошибки: ${error.code}`);
        }
        if (error.syscall) {
          logger.error(`   Системный вызов: ${error.syscall}`);
        }
        if (error.hostname) {
          logger.error(`   Хост: ${error.hostname}`);
        }
        logger.error(`   Решение: проверьте сеть, прокси и файрвол`);
      } else if (errorMessage.includes('timeout')) {
        logger.error(`❌  [Helix API] Таймаут при запросе к api.twitch.tv`);
        logger.error(`   Возможные причины: медленное соединение или перегрузка сервера`);
      } else {
        logger.error(`❌  [Helix API] Error stack: ${error.stack || 'No stack trace'}`);
      }
    }
    
    return null;
  }

  /**
   * Получает ID канала по имени пользователя через VideoPlayerStreamInfoOverlayChannel
   * @param username Имя пользователя
   * @returns ID канала или null
   */
  private async getChannelIdViaVideoPlayer(username: string): Promise<string | null> {
    try {
      const operation = {
        operationName: 'VideoPlayerStreamInfoOverlayChannel',
        variables: { channel: username },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: 'a5f2e34d626a9f4f5c0204f910bab2194948a9502089be558bb6e779a9e1b3d2',
          },
        },
      };

      const response = await this.postRequest(operation);
      
      // Пробуем получить channel ID из ответа
      if (response.data?.user?.id) {
        logger.info(`✅  Got channel ID via VideoPlayerStreamInfoOverlayChannel for ${username}: ${response.data.user.id}`);
        return response.data.user.id;
      }
      
      // Если persisted query не работает, пробуем полный запрос
      if (response.errors && response.errors.some((e: any) => e.message && e.message.includes('PersistedQueryNotFound'))) {
        logger.verbose(`⚠️  PersistedQueryNotFound for VideoPlayerStreamInfoOverlayChannel, trying full query for ${username}`);
        const fullOperation = {
          operationName: 'VideoPlayerStreamInfoOverlayChannel',
          variables: { channel: username },
          query: `query VideoPlayerStreamInfoOverlayChannel($channel: String!) {
            user(login: $channel) {
              id
            }
          }`,
        };
        
        const fullResponse = await this.postRequest(fullOperation);
        if (fullResponse.data?.user?.id) {
          logger.info(`✅  Got channel ID via VideoPlayerStreamInfoOverlayChannel (full query) for ${username}: ${fullResponse.data.user.id}`);
          return fullResponse.data.user.id;
        }
      }
    } catch (error: any) {
      logger.verbose(`⚠️  Error getting channel ID via VideoPlayerStreamInfoOverlayChannel: ${error.message || error}`);
    }
    
    return null;
  }

  /**
   * Получает ID канала по имени пользователя
   * Пробует несколько способов: VideoPlayerStreamInfoOverlayChannel (основной), ReportMenuItem (fallback), Helix API (последний fallback)
   * @param username Имя пользователя
   * @returns ID канала или null
   */
  async getChannelId(username: string): Promise<string | null> {
    // Способ 1: VideoPlayerStreamInfoOverlayChannel (основной метод, так как ReportMenuItem устарел)
    const videoPlayerResult = await this.getChannelIdViaVideoPlayer(username);
    if (videoPlayerResult) {
      return videoPlayerResult;
    }
    
    // Способ 2: ReportMenuItem GraphQL запрос (fallback, но обычно не работает)
    logger.verbose(`⚠️  VideoPlayerStreamInfoOverlayChannel failed for ${username}, trying ReportMenuItem...`);
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
      const response = await this.postRequest(operation);
      
      if (response.data?.user?.id) {
        logger.info(`✅  Got channel ID via ReportMenuItem for ${username}: ${response.data.user.id}`);
        return response.data.user.id;
      }
      
      // Если GraphQL вернул ошибку PersistedQueryNotFound, это ожидаемо (запрос устарел)
      if (response.errors && response.errors.some((e: any) => e.message === 'PersistedQueryNotFound')) {
        logger.verbose(`⚠️  ReportMenuItem query not found for ${username} (expected, query is deprecated)`);
      }
    } catch (error: any) {
      // Ошибка ожидаема, так как ReportMenuItem устарел
      logger.verbose(`⚠️  ReportMenuItem error for ${username} (expected): ${error.message || error}`);
    }
    
    // Способ 3: Helix API (последний fallback, обычно не работает без правильных scopes)
    logger.verbose(`⚠️  Trying Helix API as last resort for ${username}...`);
    const helixResult = await this.getChannelIdViaHelix(username);
    if (!helixResult) {
      logger.error(`❌  Failed to get channel ID for ${username} via all methods (VideoPlayerStreamInfoOverlayChannel, ReportMenuItem, Helix API)`);
    }
    return helixResult;
  }

  /**
   * Проверяет, онлайн ли стример
   * @param channelId ID канала
   * @returns ID стрима, если онлайн, иначе null
   */
  async checkStreamerOnline(channelId: string): Promise<string | null> {
    const operation = {
      operationName: 'WithIsStreamLiveQuery',
      variables: { id: channelId },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: '04e46329a6786ff3a81c01c50bfa5d725902507a0deb83b0edbf7abe7a3716ea',
        },
      },
    };

    const response = await this.postRequest(operation);
    
    if (response.data?.user?.stream?.id) {
      return response.data.user.stream.id;
    }
    
    return null;
  }

  /**
   * Получает информацию о стриме
   * @param username Имя пользователя
   * @param channelId ID канала для fallback WithIsStreamLiveQuery
   * @returns Информация о стриме или null (null = офлайн или статус неизвестен)
   */
  async getStreamInfo(
    username: string,
    channelId?: string
  ): Promise<{
    broadcastId: string;
    title: string;
    game: any;
    tags: any[];
    viewersCount: number;
  } | null> {
    // Сначала пробуем с persisted query
    const operation = {
      operationName: 'VideoPlayerStreamInfoOverlayChannel',
      variables: { channel: username },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: 'a5f2e34d626a9f4f5c0204f910bab2194948a9502089be558bb6e779a9e1b3d2',
        },
      },
    };

    try {
      let response = await this.postRequest(operation);
      let needsFullQuery = false;
      let persistedQueryData = null;
      
      // Проверяем на ошибку PersistedQueryNotFound - пробуем отправить полный запрос
      if (response.errors && response.errors.length > 0) {
        const hasPersistedQueryError = response.errors.some((e: any) => 
          e.message && e.message.includes('PersistedQueryNotFound')
        );
        
        if (hasPersistedQueryError) {
          needsFullQuery = true;
        }
      }
      
      // Сохраняем данные из persisted query на случай, если полный запрос не сработает
      if (response.data?.user?.stream) {
        persistedQueryData = response.data;
      }
      
      if (needsFullQuery) {
        // Пробуем отправить полный GraphQL запрос без persisted query
        logger.verbose(`⚠️  Using full query for VideoPlayerStreamInfoOverlayChannel`);
        const fullOperation = {
          operationName: 'VideoPlayerStreamInfoOverlayChannel',
          variables: { channel: username },
          query: `query VideoPlayerStreamInfoOverlayChannel($channel: String!) {
            user(login: $channel) {
              id
              stream {
                id
                viewersCount
                tags {
                  id
                  localizedName
                }
              }
              broadcastSettings {
                title
                game {
                  id
                  name
                  displayName
                }
              }
            }
          }`,
        };
        
        try {
          const fullResponse = await this.postRequest(fullOperation);
          // Если полный запрос успешен, используем его данные
          if (fullResponse.data?.user?.stream) {
            response = fullResponse;
          } else if (persistedQueryData) {
            // Если полный запрос не вернул данные, но persisted query вернул, используем его
            logger.verbose(`⚠️  Full query didn't return stream data, using persisted query data for ${username}`);
            response = { ...response, data: persistedQueryData };
          }
        } catch (e: any) {
          // Если полный запрос не работает, используем данные из persisted query (если есть)
          if (persistedQueryData) {
            logger.verbose(`⚠️  Full query failed for getStreamInfo(${username}), using persisted query data: ${e.message || e}`);
            response = { ...response, data: persistedQueryData };
          } else {
            // Если и persisted query не вернул данных — пробуем live query
            if (channelId) {
              const viaLive = await this.getStreamInfoViaLiveQuery(channelId);
              if (viaLive) {
                this.clearStreamInfoQueryFailure();
                return viaLive;
              }
            }
            logger.verbose(`⚠️  Both queries failed for getStreamInfo(${username}): ${e.message || e}`);
            this.markStreamInfoQueryFailure();
            return null;
          }
        }
      }
      
      if (response.data?.user?.stream) {
        const stream = response.data.user.stream;
        this.clearStreamInfoQueryFailure();

        return {
          broadcastId: stream.id,
          title: response.data.user.broadcastSettings?.title || '',
          game: response.data.user.broadcastSettings?.game || null,
          tags: stream.tags || [],
          viewersCount: stream.viewersCount || 0,
        };
      }

      const user = response.data?.user;
      const explicitOffline =
        user != null &&
        user.stream == null &&
        !GraphQLClient.hasUnreliableGraphQLErrors(response);

      if (explicitOffline) {
        this.clearStreamInfoQueryFailure();
        return null;
      }

      if (channelId) {
        const viaLive = await this.getStreamInfoViaLiveQuery(channelId);
        if (viaLive) {
          this.clearStreamInfoQueryFailure();
          logger.verbose(
            `⚠️  getStreamInfo(${username}): overlay query failed, stream is LIVE via WithIsStreamLiveQuery`
          );
          return viaLive;
        }
      }

      this.markStreamInfoQueryFailure();
      return null;
    } catch (error: any) {
      // Обрабатываем ошибки GraphQL
      // При ошибках не можем определить статус стримера, возвращаем null
      // НО не помечаем стримера как офлайн - это сделает вызывающий код на основе других источников
      if (error.message && (error.message.includes('timeout') || error.message.includes('service timeout'))) {
        this.markStreamInfoQueryFailure();
        if (channelId) {
          const viaLive = await this.getStreamInfoViaLiveQuery(channelId);
          if (viaLive) {
            this.clearStreamInfoQueryFailure();
            return viaLive;
          }
        }
        return null;
      }
      
      // Для ошибок типа "Cannot query field" или "PersistedQueryNotFound" 
      // не пробрасываем исключение, а возвращаем null
      // Это позволяет системе использовать другие источники информации (WebSocket)
      if (error.message && (
        error.message.includes('Cannot query field') ||
        error.message.includes('PersistedQueryNotFound')
      )) {
        logger.verbose(`⚠️  GraphQL error for getStreamInfo(${username}): ${error.message} - используем альтернативные источники`);
        if (channelId) {
          const viaLive = await this.getStreamInfoViaLiveQuery(channelId);
          if (viaLive) {
            this.clearStreamInfoQueryFailure();
            return viaLive;
          }
        }
        this.markStreamInfoQueryFailure();
        return null;
      }
      
      // Для других ошибок пробрасываем дальше
      throw error;
    }
  }

  /**
   * Извлекает баланс и доступный бонус из ответа ChannelPointsContext
   */
  private static parseChannelPointsData(
    data: Record<string, unknown> | undefined
  ): { balance: number; availableClaim: { id: string } | null } | null {
    if (!data) {
      return null;
    }

    const communityPoints = (data as any).community?.channel?.self?.communityPoints;
    if (communityPoints != null && typeof communityPoints.balance === 'number') {
      return {
        balance: communityPoints.balance,
        availableClaim: communityPoints.availableClaim ?? null,
      };
    }

    const userChannelPoints =
      (data as any).user?.channel?.self?.communityPoints ??
      (data as any).user?.self?.communityPoints;
    if (userChannelPoints != null && typeof userChannelPoints.balance === 'number') {
      return {
        balance: userChannelPoints.balance,
        availableClaim: userChannelPoints.availableClaim ?? null,
      };
    }

    const currentUserPoints = (data as any).currentUser?.communityPoints;
    if (currentUserPoints != null && typeof currentUserPoints.balance === 'number') {
      return {
        balance: currentUserPoints.balance,
        availableClaim: currentUserPoints.availableClaim ?? null,
      };
    }

    return null;
  }

  private static hasPersistedQueryNotFound(response: GraphQLResponse): boolean {
    return Boolean(
      response.errors?.some(
        (e: { message?: string }) => e.message?.includes('PersistedQueryNotFound')
      )
    );
  }

  /**
   * Получает информацию о баллах канала
   * @param username Имя пользователя (channelLogin)
   * @returns Информация о баллах или null
   */
  async getChannelPoints(username: string): Promise<{
    balance: number;
    availableClaim: { id: string } | null;
  } | null> {
    const persistedVariants = [
      GQL_OPERATIONS.ChannelPointsContext,
      GQL_OPERATIONS.ChannelPointsContextLegacy,
    ];

    let lastResponse: GraphQLResponse | null = null;

    for (const template of persistedVariants) {
      const response = await this.postRequest({
        operationName: template.operationName,
        variables: { channelLogin: username },
        extensions: template.extensions,
      });
      lastResponse = response;

      if (response.data && (response.data as any).community === null) {
        return null;
      }

      const parsed = GraphQLClient.parseChannelPointsData(
        response.data as Record<string, unknown> | undefined
      );
      if (parsed) {
        return parsed;
      }

      if (!GraphQLClient.hasPersistedQueryNotFound(response)) {
        break;
      }

      logger.verbose(
        `⚠️  PersistedQueryNotFound for ChannelPointsContext, trying legacy persisted query`
      );
    }

    const response = lastResponse;
    if (!response) {
      return null;
    }

    if (response.data) {
      logger.verbose(
        `⚠️  Unexpected response structure for getChannelPoints(${username}):`,
        JSON.stringify(response.data).substring(0, 200)
      );
    } else if (response.errors && response.errors.length > 0) {
      const onlyPersistedNotFound = response.errors.every((e: any) =>
        e.message?.includes('PersistedQueryNotFound')
      );
      if (!onlyPersistedNotFound) {
        logger.verbose(
          `⚠️  GraphQL errors for getChannelPoints(${username}):`,
          response.errors.map((e: any) => e.message).join(', ')
        );
      }
    }

    return null;
  }

  /**
   * Получает бонусные баллы
   * @param channelId ID канала
   * @param claimId ID бонуса
   * @returns true если успешно
   */
  async claimBonus(channelId: string, claimId: string): Promise<ClaimBonusResult> {
    const operation = {
      operationName: 'ClaimCommunityPoints',
      variables: {
        input: {
          channelID: channelId,
          claimID: claimId,
        },
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0',
        },
      },
    };

    let response = await this.postRequest(operation, { requireIntegrity: true });

    if (GraphQLClient.hasIntegrityError(response)) {
      if (!canRefreshIntegrityViaApi()) {
        logger.warn(
          '🔐  Claim: failed integrity check — обновите Client-Integrity в «Конфиг бота» или включите TWITCH_INTEGRITY_AUTO_REFRESH'
        );
      } else {
        logger.verbose('🔐  ClaimCommunityPoints: integrity rejected, повтор с обновлением токена...');
        this.integrityProvider.invalidate();
        try {
          await this.integrityProvider.refreshApiTokenAndPersist();
        } catch (refreshError: unknown) {
          const message =
            refreshError instanceof Error ? refreshError.message : String(refreshError);
          logger.warn(`🔐  Не удалось обновить integrity автоматически: ${message}`);
        }
        response = await this.postRequest(operation, { requireIntegrity: true });
      }
    }

    return GraphQLClient.parseClaimBonusResult(response);
  }

  /**
   * @param response Ответ ClaimCommunityPoints
   */
  private static hasIntegrityError(response: GraphQLResponse): boolean {
    return Boolean(
      response.errors?.some((e: { message?: string }) => e.message === 'failed integrity check')
    );
  }

  private static parseClaimBonusResult(response: GraphQLResponse): ClaimBonusResult {
    if (GraphQLClient.hasIntegrityError(response)) {
      logger.verbose(
        '⚠️  ClaimCommunityPoints: failed integrity check — обновите TWITCH_CLIENT_INTEGRITY из DevTools'
      );
      return { success: false, failureKind: 'integrity' };
    }

    const claimResult = (response.data as any)?.claimCommunityPoints;
    const claimError = claimResult?.error;

    if (claimError?.code) {
      logger.verbose(`⚠️  ClaimCommunityPoints error: ${claimError.code}`);
      const failureKind = PERMANENT_CLAIM_ERROR_CODES.has(claimError.code)
        ? 'permanent'
        : undefined;
      return { success: false, failureKind };
    }

    if (claimResult?.status === 'SUCCESS') {
      return { success: true };
    }

    if (claimResult !== null && claimResult !== undefined) {
      if (typeof claimResult === 'object' && Object.keys(claimResult).length > 0) {
        return { success: true };
      }
    }

    if (response.errors?.length) {
      logger.verbose(
        `⚠️  ClaimCommunityPoints gql errors: ${response.errors.map((e: any) => e.message).join(', ')}`
      );
    }

    return { success: false };
  }

  /**
   * Присоединяется к рейду
   * @param raidId ID рейда
   * @returns true если успешно присоединились
   */
  async joinRaid(raidId: string): Promise<boolean> {
    const operation = {
      operationName: 'JoinRaid',
      variables: {
        input: {
          raidID: raidId,
        },
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: 'c6a332a86d1087fbbb1a8623aa01bd1313d2386e7c63be60fdb2d1901f01a4ae',
        },
      },
    };

    let response = await this.postRequest(operation, { requireIntegrity: true });

    if (GraphQLClient.hasIntegrityError(response)) {
      this.integrityProvider.invalidate();
      response = await this.postRequest(operation, { requireIntegrity: true });
    }

    if (response.errors && response.errors.length > 0) {
      if (!GraphQLClient.hasIntegrityError(response)) {
        logger.error(`❌  Error joining raid ${raidId}:`, response.errors[0].message);
      }
      return false;
    }

    return true;
  }
}

