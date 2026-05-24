/**
 * Настройки источника Client-Integrity для claim/raid
 */

/** Источник integrity-токена */
export type IntegritySource = 'browser' | 'manual' | 'api';

/**
 * Читает TWITCH_INTEGRITY_SOURCE из окружения
 */
export function loadIntegritySource(): IntegritySource {
  const raw = process.env.TWITCH_INTEGRITY_SOURCE?.trim().toLowerCase();

  if (raw === 'browser' || raw === 'manual' || raw === 'api') {
    return raw;
  }

  // Быстрое отключение браузера: TWITCH_INTEGRITY_BROWSER=false → manual или api
  if (process.env.TWITCH_INTEGRITY_BROWSER === 'false') {
    return process.env.TWITCH_CLIENT_INTEGRITY?.trim() ? 'manual' : 'api';
  }

  return 'browser';
}

/**
 * Проверяет, задан ли ручной токен в окружении
 */
export function hasManualIntegrityToken(): boolean {
  return Boolean(process.env.TWITCH_CLIENT_INTEGRITY?.trim());
}

/**
 * Возвращает ручной токен из окружения
 */
export function getManualIntegrityToken(): string | null {
  const token = process.env.TWITCH_CLIENT_INTEGRITY?.trim();
  return token || null;
}

/**
 * Парсит expiration (unix sec или ms) из ответа Twitch integrity
 */
export function integrityExpirationToMs(expiration: number | undefined, now = Date.now()): number {
  if (expiration == null || expiration <= 0) {
    return now + 4 * 60 * 60 * 1000;
  }
  return expiration > 1_000_000_000_000 ? expiration : expiration * 1000;
}
