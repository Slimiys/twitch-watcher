/**
 * Префиксы Client-Integrity для dashboard (без полного токена)
 */

/** Длина отображаемого префикса токена */
export const INTEGRITY_TOKEN_PREFIX_LEN = 32;

/**
 * Первые 32 символа токена для UI
 */
export function integrityTokenPrefix(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.slice(0, INTEGRITY_TOKEN_PREFIX_LEN);
}

let previousTokenPrefix: string | null = null;
let currentTokenPrefix: string | null = null;
let initializedFromEnv = false;

function ensureInitializedFromEnv(): void {
  if (initializedFromEnv) {
    return;
  }
  initializedFromEnv = true;
  const token = process.env.TWITCH_CLIENT_INTEGRITY?.trim();
  if (token) {
    currentTokenPrefix = integrityTokenPrefix(token);
  }
}

/**
 * Фиксирует смену токена для dashboard (только если префикс изменился)
 */
export function recordIntegrityTokenForDisplay(token: string): boolean {
  const prefix = integrityTokenPrefix(token);
  if (!prefix) {
    return false;
  }
  ensureInitializedFromEnv();
  if (currentTokenPrefix === prefix) {
    return false;
  }
  if (currentTokenPrefix) {
    previousTokenPrefix = currentTokenPrefix;
  }
  currentTokenPrefix = prefix;
  return true;
}

/**
 * Префиксы для /api/bot-health и dashboard
 */
export function getIntegrityTokenDisplay(): {
  previousPrefix: string | null;
  currentPrefix: string | null;
} {
  ensureInitializedFromEnv();
  return {
    previousPrefix: previousTokenPrefix,
    currentPrefix: currentTokenPrefix,
  };
}

/**
 * Сброс (тесты)
 */
export function resetIntegrityTokenDisplayForTests(): void {
  previousTokenPrefix = null;
  currentTokenPrefix = null;
  initializedFromEnv = false;
}
