/**
 * Клиент для работы с GraphQL API Twitch
 */

import { GraphQLOperation, GraphQLResponse } from './types';
import { GQL_URL, CLIENT_ID } from './constants';
import { logger } from './logger';

/**
 * Клиент для выполнения GraphQL запросов к Twitch
 */
export class GraphQLClient {
  private authToken: string;
  private userAgent: string;

  /**
   * Создает экземпляр GraphQL клиента
   * @param authToken Токен авторизации Twitch
   * @param userAgent User-Agent для запросов
   */
  constructor(authToken: string, userAgent: string) {
    this.authToken = authToken;
    this.userAgent = userAgent;
  }

  /**
   * Выполняет GraphQL запрос
   * @param operation GraphQL операция
   * @returns Ответ от сервера
   */
  async postRequest(operation: GraphQLOperation): Promise<GraphQLResponse> {
    try {
      const response = await fetch(GQL_URL, {
        method: 'POST',
        headers: {
          'Authorization': `OAuth ${this.authToken}`,
          'Client-Id': CLIENT_ID,
          'User-Agent': this.userAgent,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(operation),
      });

      if (!response.ok) {
        throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
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
    } catch (error: any) {
      logger.error(`Error with GraphQL operation (${operation.operationName}):`, error.message || error);
      return {};
    }
  }

  /**
   * Получает ID канала по имени пользователя
   * @param username Имя пользователя
   * @returns ID канала или null
   */
  async getChannelId(username: string): Promise<string | null> {
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

    const response = await this.postRequest(operation);
    
    if (response.data?.user?.id) {
      return response.data.user.id;
    }
    
    return null;
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
   * @returns Информация о стриме или null
   */
  async getStreamInfo(username: string): Promise<{
    broadcastId: string;
    title: string;
    game: any;
    tags: any[];
    viewersCount: number;
  } | null> {
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
      const response = await this.postRequest(operation);
      
      if (response.data?.user?.stream) {
        const stream = response.data.user.stream;
        return {
          broadcastId: stream.id,
          title: response.data.user.broadcastSettings?.title || '',
          game: response.data.user.broadcastSettings?.game || null,
          tags: stream.tags || [],
          viewersCount: stream.viewersCount || 0,
        };
      }
      
      return null;
    } catch (error: any) {
      // Обрабатываем ошибки GraphQL (например, service timeout)
      // При ошибках считаем, что стример офлайн или информация недоступна
      if (error.message && (error.message.includes('timeout') || error.message.includes('service timeout'))) {
        return null;
      }
      // Для других ошибок пробрасываем дальше
      throw error;
    }
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
    const operation = {
      operationName: 'ChannelPointsContext',
      variables: { channelLogin: username },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: '9988086babc615a918a1e9a722ff41d98847acac822645209ac7379eecb27152',
        },
      },
    };

    const response = await this.postRequest(operation);
    
    // Пробуем стандартный путь: community.channel.self.communityPoints
    if (response.data?.community?.channel?.self?.communityPoints) {
      const points = response.data.community.channel.self.communityPoints;
      return {
        balance: points.balance || 0,
        availableClaim: points.availableClaim || null,
      };
    }
    
    // Пробуем альтернативный путь: currentUser.communityPoints (для некоторых случаев)
    if (response.data?.currentUser?.communityPoints) {
      const points = response.data.currentUser.communityPoints;
      return {
        balance: points.balance || 0,
        availableClaim: points.availableClaim || null,
      };
    }
    
    // Логируем, если структура ответа неожиданная (только в verbose, так как баллы обновляются через WebSocket)
    if (response.data) {
      logger.verbose(`⚠️  Unexpected response structure for getChannelPoints(${username}):`, JSON.stringify(response.data).substring(0, 200));
    } else if (response.errors) {
      logger.warn(`⚠️  GraphQL errors for getChannelPoints(${username}):`, response.errors.map((e: any) => e.message).join(', '));
    }
    
    return null;
  }

  /**
   * Получает бонусные баллы
   * @param channelId ID канала
   * @param claimId ID бонуса
   * @returns true если успешно
   */
  async claimBonus(channelId: string, claimId: string): Promise<boolean> {
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

    const response = await this.postRequest(operation);
    
    // Проверяем, что запрос выполнен успешно
    // Если есть ошибка "failed integrity check", это означает, что бонус уже собран или недоступен
    if (response.errors && response.errors.length > 0) {
      const hasIntegrityError = response.errors.some((e: any) => e.message === 'failed integrity check');
      if (hasIntegrityError) {
        // Бонус уже собран или недоступен - это нормально
        // API может показывать availableClaim, но бонус уже был собран между проверкой и попыткой
        return false;
      }
    }
    
    // Проверяем результат операции
    const claimResult = response.data?.claimCommunityPoints;
    
    // Если claimResult не null и не undefined, значит операция выполнена
    // В Channel Points Miner они просто отправляют запрос и не проверяют результат
    // Но мы проверяем, чтобы знать, успешно ли собрали
    if (claimResult !== null && claimResult !== undefined) {
      // Если есть поле status, проверяем его
      if (claimResult.status === 'SUCCESS') {
        return true;
      }
      // Если это объект с данными (не null), считаем успехом
      if (typeof claimResult === 'object' && Object.keys(claimResult).length > 0) {
        return true;
      }
    }
    
    // Если claimResult === null, значит операция не выполнена (бонус уже собран или недоступен)
    return false;
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

    const response = await this.postRequest(operation);
    
    // Проверяем успешность операции
    // В Channel Points Miner они просто отправляют запрос без проверки результата
    // Но мы проверяем, чтобы знать, успешно ли присоединились
    if (response.errors && response.errors.length > 0) {
      // Если есть ошибки, логируем их, но не считаем критичными
      const hasIntegrityError = response.errors.some((e: any) => e.message === 'failed integrity check');
      if (!hasIntegrityError) {
        // Для других ошибок логируем
        logger.error(`❌  Error joining raid ${raidId}:`, response.errors[0].message);
      }
      return false;
    }
    
    // Если нет ошибок, считаем успехом
    return true;
  }
}

