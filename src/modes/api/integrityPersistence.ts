/**
 * Сохранение Client-Integrity в config.json после автоматического обновления
 */

import { logger } from './logger';
import {
  getAppConfigPath,
  readAppConfigFile,
  writeAppConfigFile,
} from './appSettings';
import { shouldPersistIntegrityToConfig } from './integrityConfig';

/**
 * Записывает integrity и срок в config.app и process.env
 */
export function persistIntegrityToAppConfig(
  token: string,
  expiresAtMs: number,
  deviceId?: string
): void {
  const expiresSec = Math.floor(expiresAtMs / 1000);
  process.env.TWITCH_CLIENT_INTEGRITY = token;
  process.env.TWITCH_CLIENT_INTEGRITY_EXPIRES = String(expiresSec);

  if (deviceId?.trim()) {
    process.env.TWITCH_DEVICE_ID = deviceId.trim();
  }

  if (!shouldPersistIntegrityToConfig()) {
    return;
  }

  try {
    const configPath = getAppConfigPath();
    const config = readAppConfigFile(configPath);
    if (!config.app) {
      config.app = {};
    }
    config.app.TWITCH_CLIENT_INTEGRITY = token;
    config.app.TWITCH_CLIENT_INTEGRITY_EXPIRES = String(expiresSec);
    if (deviceId?.trim()) {
      config.app.TWITCH_DEVICE_ID = deviceId.trim();
    }
    writeAppConfigFile(config, configPath);
    logger.info(
      `🔐  Client-Integrity обновлён автоматически (сохранён в config.json, истекает через ${formatExpiresIn(
        expiresAtMs
      )})`
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`⚠️  Не удалось сохранить integrity в config.json: ${message}`);
  }
}

function formatExpiresIn(expiresAtMs: number): string {
  const min = Math.max(0, Math.round((expiresAtMs - Date.now()) / 60_000));
  if (min < 60) {
    return `~${min} мин`;
  }
  return `~${Math.round(min / 60)} ч`;
}
