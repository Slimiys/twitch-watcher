/**
 * Утилиты Client-Integrity (POST /integrity)
 */

/**
 * Парсит expiration (unix sec или ms) из ответа Twitch integrity
 */
export function integrityExpirationToMs(expiration: number | undefined, now = Date.now()): number {
  if (expiration == null || expiration <= 0) {
    return now + 4 * 60 * 60 * 1000;
  }
  return expiration > 1_000_000_000_000 ? expiration : expiration * 1000;
}
