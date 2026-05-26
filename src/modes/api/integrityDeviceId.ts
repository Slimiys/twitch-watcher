/**
 * Стабильный X-Device-Id для POST /integrity и GraphQL (совпадение с cookies браузера)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../../pidFile';

const DEVICE_ID_FILE = '.twitch-device-id';

/**
 * Извлекает unique_id из строки TWITCH_COOKIES
 */
export function extractUniqueIdFromCookies(cookies: string | undefined): string | undefined {
  if (!cookies?.trim()) {
    return undefined;
  }
  const match = cookies.match(/(?:^|;\s*)unique_id=([^;\s]+)/i);
  const value = match?.[1]?.trim();
  return value || undefined;
}

function readPersistedDeviceId(): string | undefined {
  const filePath = path.join(getProjectRoot(), DEVICE_ID_FILE);
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function writePersistedDeviceId(deviceId: string): void {
  const filePath = path.join(getProjectRoot(), DEVICE_ID_FILE);
  fs.writeFileSync(filePath, deviceId, 'utf8');
}

/**
 * Возвращает стабильный device id: env → unique_id в cookies → файл → новый UUID в файл
 */
export function resolveStableDeviceId(explicit?: string): string {
  const fromArg = explicit?.trim();
  if (fromArg) {
    return fromArg;
  }

  const fromEnv = process.env.TWITCH_DEVICE_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const fromCookies = extractUniqueIdFromCookies(process.env.TWITCH_COOKIES);
  if (fromCookies) {
    process.env.TWITCH_DEVICE_ID = fromCookies;
    return fromCookies;
  }

  const persisted = readPersistedDeviceId();
  if (persisted) {
    process.env.TWITCH_DEVICE_ID = persisted;
    return persisted;
  }

  const generated = crypto.randomUUID();
  try {
    writePersistedDeviceId(generated);
    process.env.TWITCH_DEVICE_ID = generated;
  } catch {
    // без файла — хотя бы в памяти на процесс
  }
  return generated;
}
