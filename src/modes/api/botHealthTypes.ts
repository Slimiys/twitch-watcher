/**
 * Снимок состояния бота для dashboard API
 */

/** Результат последней попытки сбора бонуса по стримеру */
export interface StreamerClaimHealth {
  streamer: string;
  outcome: 'success' | 'failed';
  failureKind?: 'integrity' | 'permanent' | 'unknown';
  timestamp: number;
  message: string;
}

/** Состояние WebSocket PubSub */
export interface WebSocketHealthSnapshot {
  status: 'connected' | 'reconnecting' | 'disconnected' | 'stopped';
  connectionState: string;
  reconnectAttempt: number;
  maxReconnectAttempts: number;
  hasCriticalErrors: boolean;
  lastCriticalError: { timestamp: number; error: string; code?: string } | null;
}

/** Статус сбора бонусов (claim) относительно integrity */
export type IntegrityBonusClaimStatusKind =
  | 'ok'
  | 'integrity_blocked'
  | 'claim_failed'
  | 'no_attempts'
  | 'token_invalid';

export interface IntegrityBonusClaimSnapshot {
  status: IntegrityBonusClaimStatusKind;
  message: string;
  lastClaimAtMs?: number;
  lastClaimStreamer?: string;
}

/** Client-Integrity без раскрытия токена */
export interface IntegrityHealthSnapshot {
  source: 'manual' | 'api';
  configured: boolean;
  valid: boolean;
  expiresAtMs: number | null;
  expiresInMs: number | null;
  fallbackApiEnabled: boolean;
  deviceIdPrefix: string;
  /** Когда токен последний раз обновлялся (bridge или оценка); заполняется в getBotHealth */
  lastUpdatedAtMs?: number | null;
  /** true — время оценено по сроку действия, а не зафиксировано bridge */
  lastUpdatedAtEstimated?: boolean;
  /** Удаётся ли собирать бонусы с текущим токеном; заполняется в getBotHealth */
  bonusClaim?: IntegrityBonusClaimSnapshot;
  /** Первые 32 символа предыдущего токена (после последней смены) */
  tokenPreviousPrefix?: string | null;
  /** Первые 32 символа текущего токена */
  tokenCurrentPrefix?: string | null;
}

/** GraphQL / Circuit Breaker */
export interface GraphqlHealthSnapshot {
  circuitBreaker: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  hadRecentNetworkFailure: boolean;
}

/** Полный ответ /api/bot-health */
export interface BotHealthSnapshot {
  timestamp: number;
  appVersion: string;
  appSemver: string;
  gitRevision: string;
  watcherRunning: boolean;
  websocket: WebSocketHealthSnapshot;
  integrity: IntegrityHealthSnapshot;
  graphql: GraphqlHealthSnapshot;
  lastIntegrityFailure: { timestamp: number; streamer: string } | null;
  /** Последние попытки claim (до 5, по убыванию времени) */
  claimByStreamer: StreamerClaimHealth[];
}
