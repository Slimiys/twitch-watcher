/**
 * Утилиты Client-Integrity (manual из DevTools и POST /integrity)
 */

export type ResolvedIntegritySource = 'manual' | 'api';

/**
 * Парсит expiration (unix sec или ms) из ответа Twitch integrity
 */
export function integrityExpirationToMs(expiration: number | undefined, now = Date.now()): number {
  if (expiration == null || expiration <= 0) {
    return now + 4 * 60 * 60 * 1000;
  }
  return expiration > 1_000_000_000_000 ? expiration : expiration * 1000;
}

/**
 * Токен и срок действия из TWITCH_CLIENT_INTEGRITY (+ опционально EXPIRES)
 */
export function getManualIntegrityFromEnv(now = Date.now()): { token: string; expiresAtMs: number } | null {
  const token = process.env.TWITCH_CLIENT_INTEGRITY?.trim();
  if (!token) {
    return null;
  }

  const expRaw = process.env.TWITCH_CLIENT_INTEGRITY_EXPIRES?.trim();
  let expiresAtMs = now + 4 * 60 * 60 * 1000;
  if (expRaw) {
    const parsed = Number(expRaw);
    if (!Number.isNaN(parsed) && parsed > 0) {
      expiresAtMs = integrityExpirationToMs(parsed, now);
    }
  }

  return { token, expiresAtMs };
}

/**
 * Разрешён ли fallback на POST /integrity при manual-режиме
 */
export function allowApiIntegrityFallback(): boolean {
  return process.env.TWITCH_INTEGRITY_FALLBACK_API === 'true';
}

/**
 * manual — только DevTools; api — POST /integrity; auto — manual если задан TWITCH_CLIENT_INTEGRITY
 */
export function resolveIntegritySource(): ResolvedIntegritySource {
  const raw = (process.env.TWITCH_INTEGRITY_SOURCE || 'auto').trim().toLowerCase();
  if (raw === 'manual') {
    return 'manual';
  }
  if (raw === 'api') {
    return 'api';
  }
  return getManualIntegrityFromEnv() ? 'manual' : 'api';
}
