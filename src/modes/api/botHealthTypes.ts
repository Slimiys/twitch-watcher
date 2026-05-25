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

/** Client-Integrity без раскрытия токена */
export interface IntegrityHealthSnapshot {
  source: 'manual' | 'api';
  configured: boolean;
  valid: boolean;
  expiresAtMs: number | null;
  expiresInMs: number | null;
  fallbackApiEnabled: boolean;
  deviceIdPrefix: string;
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
