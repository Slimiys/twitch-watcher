/**
 * Типы для API-режима работы
 */

/**
 * Результат ClaimCommunityPoints
 */
export interface ClaimBonusResult {
  success: boolean;
  /** integrity — обновить TWITCH_CLIENT_INTEGRITY; permanent — не повторять claimId */
  failureKind?: 'integrity' | 'permanent';
}

/**
 * Информация о стримере
 */
export interface StreamerInfo {
  username: string;
  channelId: string;
  channelPoints: number;
  isOnline: boolean;
  broadcastId: string | null;
  game: string | null;
  title: string | null;
  tags: string[];
  spadeUrl: string | null;
  startTime: number; // Время начала просмотра (переход из офлайн в онлайн)
  initialChannelPoints: number | null; // Начальные баллы при старте просмотра
  lastChannelPoints: number | null; // Последние известные баллы
  streamPointsEarned: number; // Баллы, заработанные за текущий стрим (сбрасываются при stream-up)
  lastWatchPrepAt?: number; // Время последней подготовки перед minute-watched
}

/**
 * Payload для события minute-watched
 */
export interface MinuteWatchedPayload {
  event: 'minute-watched';
  properties: {
    channel_id: string;
    broadcast_id: string;
    player: 'site';
    user_id: string;
    game?: string; // Опционально, для дропов
  };
}

/**
 * WebSocket сообщение от Twitch
 */
export interface WebSocketMessage {
  type: string;
  data: any;
  topic: string;
  timestamp: string;
}

/**
 * Сообщение о начислении баллов
 */
export interface PointsEarnedMessage {
  type: 'points-earned';
  data: {
    balance: {
      balance: number;
      channel_id?: string; // ID канала, для которого начислены баллы
    };
    point_gain: {
      total_points: number;
      reason_code: string; // WATCH, WATCH_STREAK, CLAIM, RAID, PREDICTION
    };
    channel_id?: string; // Альтернативное расположение channel_id
  };
}

/**
 * Сообщение о доступности бонуса
 */
export interface ClaimAvailableMessage {
  type: 'claim-available';
  data: {
    claim: {
      id: string;
      channel_id?: string | number;
    };
  };
}

/**
 * Сообщение о событии видео
 */
export interface VideoPlaybackMessage {
  type: 'stream-up' | 'stream-down' | 'viewcount';
  data: any;
}

/**
 * Сообщение о рейде
 */
export interface RaidMessage {
  type: 'raid_update_v2';
  raid: {
    id: string;
    target_login: string;
  };
}

/**
 * GraphQL операция
 */
export interface GraphQLOperation {
  operationName: string;
  variables?: any;
  /** Полный GraphQL запрос, если не используется persisted query */
  query?: string;
  /** Доп. параметры для persisted query; может отсутствовать при полнотекстовом запросе */
  extensions?: {
    persistedQuery: {
      version: number;
      sha256Hash: string;
    };
  };
}

/**
 * GraphQL ответ
 */
export interface GraphQLResponse {
  data?: any;
  errors?: Array<{
    message: string;
    extensions?: any;
  }>;
}

/**
 * Статистика просмотра
 */
export interface WatchStatistics {
  streamerName: string;
  elapsedTime: number; // В миллисекундах
  pointsEarned: number; // Количество заработанных баллов за текущий стрим
  currentPoints: number;
  status: 'ONLINE' | 'OFFLINE';
  game: string | null; // Категория/игра, которую стримит стример
}

/**
 * Информация о токене из валидации Twitch API
 */
export interface TokenInfo {
  client_id: string;
  login?: string;
  scopes?: string[];
  user_id: string;
  expires_in?: number; // Время истечения в секундах (если указано)
}

/**
 * Причина неуспешной валидации токена
 * - invalid: токен отклонён Twitch (401 и т.д.)
 * - network: запрос не удался из-за сети/DNS
 */
export type TokenValidationErrorType = 'invalid' | 'network';

/**
 * Результат валидации токена
 */
export interface TokenValidationResult {
  isValid: boolean;
  tokenInfo?: TokenInfo;
  expiresAt?: number; // Timestamp когда токен истечет (если известен)
  /** Причина ошибки при isValid: false (чтобы не путать сетевые ошибки с невалидным токеном) */
  errorType?: TokenValidationErrorType;
}

/**
 * Конфигурация retry механизмов
 */
export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitter?: boolean;
  circuitBreaker?: {
    failureThreshold: number;
    resetTimeoutMs: number;
    halfOpenMaxAttempts: number;
  };
  websocket?: {
    maxReconnectAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    /** Пауза перед новым циклом reconnect после исчерпания попыток (мс) */
    reconnectCyclePauseMs?: number;
  };
}

/**
 * Сессия просмотра стримера
 */
export interface WatchSession {
  id: string; // Уникальный ID сессии
  streamerName: string; // Имя стримера
  startTime: number; // Время начала просмотра (timestamp)
  endTime: number | null; // Время окончания просмотра (timestamp, null если сессия активна)
  initialChannelPoints: number; // Начальные баллы канала
  finalChannelPoints: number | null; // Конечные баллы канала (null если сессия активна)
  pointsEarned: number; // Количество заработанных баллов
  duration: number; // Длительность просмотра в миллисекундах
  status: 'completed' | 'interrupted' | 'active'; // Статус сессии
  game?: string | null; // Игра стримера
  title?: string | null; // Название стрима
}

/**
 * Агрегированная статистика
 */
export interface AggregatedStatistics {
  period: 'day' | 'week' | 'month'; // Период агрегации
  startDate: number; // Начало периода (timestamp)
  endDate: number; // Конец периода (timestamp)
  totalSessions: number; // Общее количество сессий
  totalPointsEarned: number; // Общее количество заработанных баллов
  totalWatchTime: number; // Общее время просмотра в миллисекундах
  averagePointsPerSession: number; // Среднее количество баллов за сессию
  averageSessionDuration: number; // Средняя длительность сессии в миллисекундах
  streamers: Array<{
    streamerName: string;
    sessions: number;
    pointsEarned: number;
    watchTime: number;
  }>; // Статистика по стримерам
}

