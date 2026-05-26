/**
 * Grace-период после WebSocket stream-up: GraphQL может отставать
 */

import { StreamerInfo } from './types';

/**
 * Длительность grace (мс) — не переводить в OFFLINE по GraphQL сразу после stream-up
 */
export function getWebSocketOnlineGraceMs(): number {
  const parsed = parseInt(process.env.WS_ONLINE_GRACE_MS || '120000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

/**
 * Время последнего stream-up по WebSocket (мс)
 */
export function getWebSocketOnlineAt(info: StreamerInfo): number {
  return info.webSocketOnlineAt ?? 0;
}

/**
 * Стример считается онлайн для dashboard / Active Watches (WebSocket важнее кратковременного GraphQL OFFLINE)
 */
export function isEffectivelyOnline(info: StreamerInfo, now = Date.now()): boolean {
  if (info.isOnline) {
    return true;
  }
  const wsAt = getWebSocketOnlineAt(info);
  if (wsAt > 0 && now - wsAt < getWebSocketOnlineGraceMs()) {
    return true;
  }
  return false;
}

/**
 * Начало отсчёта watch time для UI
 */
export function getEffectiveWatchStartTime(info: StreamerInfo): number {
  if (info.startTime > 0) {
    return info.startTime;
  }
  return getWebSocketOnlineAt(info);
}
