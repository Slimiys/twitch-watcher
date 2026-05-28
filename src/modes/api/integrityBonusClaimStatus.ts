/**
 * Статус сбора бонусов относительно Client-Integrity
 */

import {
  IntegrityBonusClaimSnapshot,
  IntegrityHealthSnapshot,
  StreamerClaimHealth,
} from './botHealthTypes';

/** Срок токена из браузера по умолчанию (4 ч) — для оценки времени обновления */
const DEFAULT_INTEGRITY_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Время последнего обновления integrity (из bridge или оценка по expires)
 */
export function resolveLastIntegrityUpdatedAt(
  lastCaptureAtMs: number,
  expiresAtMs: number | null,
  now = Date.now()
): { atMs: number | null; estimated: boolean } {
  if (lastCaptureAtMs > 0) {
    return { atMs: lastCaptureAtMs, estimated: false };
  }
  if (expiresAtMs != null && expiresAtMs > now) {
    const estimated = expiresAtMs - DEFAULT_INTEGRITY_TTL_MS;
    if (estimated > 0) {
      return { atMs: estimated, estimated: true };
    }
  }
  return { atMs: null, estimated: false };
}

/**
 * Оценивает, удаётся ли собирать бонусы с текущим integrity
 */
export function deriveIntegrityBonusClaimStatus(
  integrity: Pick<IntegrityHealthSnapshot, 'configured' | 'valid'>,
  claims: StreamerClaimHealth[],
  lastIntegrityFailure: { timestamp: number; streamer: string } | null
): IntegrityBonusClaimSnapshot {
  if (!integrity.configured) {
    return {
      status: 'token_invalid',
      message: 'Токен Client-Integrity не задан',
    };
  }
  if (!integrity.valid) {
    return {
      status: 'token_invalid',
      message: 'Токен истёк или недействителен — обновите Client-Integrity',
    };
  }

  const lastClaim = claims[0];
  if (!lastClaim) {
    return {
      status: 'no_attempts',
      message: 'В этой сессии попыток сбора бонусов ещё не было',
    };
  }

  const lastSuccess = claims.find((c) => c.outcome === 'success');

  if (lastClaim.outcome === 'success') {
    return {
      status: 'ok',
      message: 'Бонусы собираются успешно',
      lastClaimAtMs: lastClaim.timestamp,
      lastClaimStreamer: lastClaim.streamer,
    };
  }

  if (lastClaim.failureKind === 'integrity') {
    return {
      status: 'integrity_blocked',
      message: `Сбор заблокирован: ошибка integrity (${lastClaim.streamer})`,
      lastClaimAtMs: lastClaim.timestamp,
      lastClaimStreamer: lastClaim.streamer,
    };
  }

  if (
    lastIntegrityFailure &&
    (!lastSuccess || lastIntegrityFailure.timestamp > lastSuccess.timestamp)
  ) {
    return {
      status: 'integrity_blocked',
      message: `Сбор заблокирован: integrity (${lastIntegrityFailure.streamer})`,
      lastClaimAtMs: lastIntegrityFailure.timestamp,
      lastClaimStreamer: lastIntegrityFailure.streamer,
    };
  }

  return {
    status: 'claim_failed',
    message: `Последний claim неудачен (${lastClaim.streamer})`,
    lastClaimAtMs: lastClaim.timestamp,
    lastClaimStreamer: lastClaim.streamer,
  };
}
