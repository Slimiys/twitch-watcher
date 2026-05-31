/**
 * Grace-периоды онлайн/офлайн: GraphQL может отставать; краткий офлайн не рвёт сессию
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
 * Макс. длительность кратковременного офлайна (мс), после которого сессия завершается
 */
export function getOfflineResumeGraceMs(): number {
  const parsed = parseInt(process.env.OFFLINE_RESUME_GRACE_MS || '300000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
}

/**
 * Время последнего stream-up по WebSocket (мс)
 */
export function getWebSocketOnlineAt(info: StreamerInfo): number {
  return info.webSocketOnlineAt ?? 0;
}

/**
 * Кратковременный офлайн (ещё можно восстановить сессию)
 */
export function isWithinOfflineResumeGrace(info: StreamerInfo, now = Date.now()): boolean {
  const at = info.offlineAt ?? 0;
  return at > 0 && now - at < getOfflineResumeGraceMs();
}

/**
 * Grace истёк — нужно окончательно завершить офлайн
 */
export function shouldFinalizeOffline(info: StreamerInfo, now = Date.now()): boolean {
  const at = info.offlineAt ?? 0;
  if (at <= 0 || info.isOnline) {
    return false;
  }
  return now - at >= getOfflineResumeGraceMs();
}

/**
 * Можно восстановить watch без новой сессии
 */
export function canResumeFromBriefOffline(info: StreamerInfo, now = Date.now()): boolean {
  return isWithinOfflineResumeGrace(info, now) && info.offlineWatchSnapshot != null;
}

/**
 * Переход в офлайн с сохранением watch-снимка (сессия не сбрасывается сразу)
 * @returns true если состояние изменено
 */
export function beginTentativeOfflineState(info: StreamerInfo, now = Date.now()): boolean {
  if (!info.isOnline) {
    return false;
  }

  const startTime =
    info.startTime > 0 ? info.startTime : info.webSocketOnlineAt ?? 0;
  if (startTime > 0) {
    info.offlineWatchSnapshot = {
      startTime,
      webSocketOnlineAt: info.webSocketOnlineAt,
    };
    info.startTime = 0;
  }

  info.isOnline = false;
  info.offlineAt = now;
  info.webSocketOnlineAt = undefined;
  return true;
}

/**
 * Окончательный сброс после истечения grace
 */
export function finalizeOfflineState(info: StreamerInfo): void {
  info.isOnline = false;
  info.startTime = 0;
  info.webSocketOnlineAt = undefined;
  info.offlineAt = undefined;
  info.offlineWatchSnapshot = undefined;
  info.broadcastId = null;
}

/**
 * Восстановление после краткого офлайна (< grace)
 * @returns true если восстановлено
 */
export function applyBriefOfflineResume(info: StreamerInfo): boolean {
  const snap = info.offlineWatchSnapshot;
  if (!snap) {
    return false;
  }
  info.isOnline = true;
  info.startTime = snap.startTime;
  info.webSocketOnlineAt = snap.webSocketOnlineAt ?? snap.startTime;
  info.offlineAt = undefined;
  info.offlineWatchSnapshot = undefined;
  return true;
}

/**
 * Стример считается онлайн для dashboard / Active Watches / watch time
 */
export function isEffectivelyOnline(info: StreamerInfo, now = Date.now()): boolean {
  if (info.isOnline) {
    return true;
  }
  if (isWithinOfflineResumeGrace(info, now) && info.offlineWatchSnapshot) {
    return true;
  }
  const wsAt = getWebSocketOnlineAt(info);
  if (wsAt > 0 && now - wsAt < getWebSocketOnlineGraceMs()) {
    return true;
  }
  return false;
}

/**
 * Статус для UI: OFFLINE при isOnline=false, даже в grace watch продолжается
 */
export function getDisplayStreamStatus(info: StreamerInfo): 'ONLINE' | 'OFFLINE' {
  return info.isOnline ? 'ONLINE' : 'OFFLINE';
}

/**
 * Начало отсчёта watch time для UI
 */
export function getEffectiveWatchStartTime(info: StreamerInfo): number {
  if (info.startTime > 0) {
    return info.startTime;
  }
  const snap = info.offlineWatchSnapshot;
  if (snap && snap.startTime > 0) {
    return snap.startTime;
  }
  return getWebSocketOnlineAt(info);
}
