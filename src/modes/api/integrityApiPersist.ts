/**
 * Политика сохранения API integrity: не затирать токен браузера при включённом bridge
 */

import { isIntegrityBridgeEnabled } from './integrityBrowserCapture';
import { logger } from './logger';
import { persistIntegrityToAppConfig } from './integrityPersistence';
import { recordIntegrityTokenForDisplay } from './integrityTokenDisplay';

/**
 * Можно ли записывать POST /integrity в TWITCH_CLIENT_INTEGRITY (затирает токен расширения)
 */
export function shouldPersistApiIntegrityToManualSlot(): boolean {
  if (!isIntegrityBridgeEnabled()) {
    return true;
  }
  return process.env.TWITCH_INTEGRITY_API_OVERWRITE_MANUAL === 'true';
}

/**
 * Сохраняет API-токен: в manual-слот только если разрешено, иначе только display-кэш
 */
export function persistApiIntegrityToken(
  token: string,
  expiresAtMs: number,
  deviceId?: string
): void {
  if (shouldPersistApiIntegrityToManualSlot()) {
    persistIntegrityToAppConfig(token, expiresAtMs, deviceId);
    return;
  }

  recordIntegrityTokenForDisplay(token);
  logger.verbose(
    '🔐  API integrity в кэше (manual не перезаписан — для claim нужен edge-extension)'
  );
}
