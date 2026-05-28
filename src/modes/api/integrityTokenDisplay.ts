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
 * Фиксирует смену токена (прошлый ← текущий, текущий ← новый)
 */
export function recordIntegrityTokenForDisplay(token: string): void {
  const prefix = integrityTokenPrefix(token);
  if (!prefix) {
    return;
  }
  ensureInitializedFromEnv();
  if (currentTokenPrefix && currentTokenPrefix !== prefix) {
    previousTokenPrefix = currentTokenPrefix;
  }
  currentTokenPrefix = prefix;
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
