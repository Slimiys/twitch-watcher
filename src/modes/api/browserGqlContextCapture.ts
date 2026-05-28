/**
 * Приём Client-Version, Client-Session-Id и X-Device-Id из браузерного расширения
 */

import { logger } from './logger';
import {
  getAppConfigPath,
  readAppConfigFile,
  writeAppConfigFile,
} from './appSettings';
import { shouldPersistIntegrityToConfig } from './integrityConfig';

/** Twilight build id (Client-Version) */
const CLIENT_VERSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Client-Session-Id из gql (hex) */
const CLIENT_SESSION_ID_PATTERN = /^[0-9a-f]{16,64}$/i;

/** X-Device-Id */
const DEVICE_ID_PATTERN = /^[a-z0-9]{16,64}$/i;

export interface BrowserGqlContextInput {
  clientVersion?: string;
  clientSessionId?: string;
  deviceId?: string;
}

/**
 * Нормализует Client-Version (twilight build id)
 */
export function normalizeClientVersion(raw: unknown): string | null {
  if (raw == null) {
    return null;
  }
  const value = String(raw).trim();
  if (!CLIENT_VERSION_PATTERN.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

/**
 * Нормализует Client-Session-Id
 */
export function normalizeClientSessionId(raw: unknown): string | null {
  if (raw == null) {
    return null;
  }
  const value = String(raw).trim();
  if (!CLIENT_SESSION_ID_PATTERN.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

/**
 * Нормализует X-Device-Id
 */
export function normalizeDeviceId(raw: unknown): string | null {
  if (raw == null) {
    return null;
  }
  const value = String(raw).trim();
  if (!DEVICE_ID_PATTERN.test(value)) {
    return null;
  }
  return value;
}

/**
 * Применяет заголовки gql из браузера в process.env (и config при включённом persist)
 */
export function applyBrowserGqlContext(input: BrowserGqlContextInput): boolean {
  const clientVersion = normalizeClientVersion(input.clientVersion);
  const clientSessionId = normalizeClientSessionId(input.clientSessionId);
  const deviceId = normalizeDeviceId(input.deviceId);

  let changed = false;

  if (clientVersion && process.env.TWITCH_CLIENT_VERSION?.trim() !== clientVersion) {
    process.env.TWITCH_CLIENT_VERSION = clientVersion;
    changed = true;
  }
  if (clientSessionId && process.env.TWITCH_CLIENT_SESSION_ID?.trim() !== clientSessionId) {
    process.env.TWITCH_CLIENT_SESSION_ID = clientSessionId;
    changed = true;
  }
  if (deviceId && process.env.TWITCH_DEVICE_ID?.trim() !== deviceId) {
    process.env.TWITCH_DEVICE_ID = deviceId;
    changed = true;
  }

  if (!changed) {
    return false;
  }

  const parts: string[] = [];
  if (clientVersion) {
    parts.push(`Client-Version ${clientVersion.slice(0, 8)}…`);
  }
  if (clientSessionId) {
    parts.push(`Client-Session-Id ${clientSessionId.slice(0, 8)}…`);
  }
  if (deviceId) {
    parts.push(`X-Device-Id ${deviceId.slice(0, 8)}…`);
  }
  logger.info(`🌐  GQL-контекст из браузера: ${parts.join(', ')}`);

  if (!shouldPersistIntegrityToConfig()) {
    return true;
  }

  try {
    const configPath = getAppConfigPath();
    const config = readAppConfigFile(configPath);
    if (!config.app) {
      config.app = {};
    }
    if (clientVersion) {
      config.app.TWITCH_CLIENT_VERSION = clientVersion;
    }
    if (clientSessionId) {
      config.app.TWITCH_CLIENT_SESSION_ID = clientSessionId;
    }
    if (deviceId) {
      config.app.TWITCH_DEVICE_ID = deviceId;
    }
    writeAppConfigFile(config, configPath);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`⚠️  Не удалось сохранить GQL-контекст в config.json: ${message}`);
  }

  return true;
}
