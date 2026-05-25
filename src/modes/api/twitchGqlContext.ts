/**
 * Заголовки GraphQL как у веб-клиента Twitch (Client-Version, Session-Id, Cookie)
 */

import { randomBytes } from 'crypto';
import { logger } from './logger';

const TWITCH_HOME_URL = 'https://www.twitch.tv/';
const TWILIGHT_BUILD_ID_PATTERN =
  /window\.__twilightBuildID\s*=\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

/** Fallback, если не удалось скачать HTML twitch.tv */
const DEFAULT_CLIENT_VERSION =
  process.env.TWITCH_CLIENT_VERSION?.trim() ||
  '23bea8967d7b8021-39769e75396668f1d781832570020ea8f4de699d7fa8edbb554ca37939b7d5cde';

let cachedClientVersion = DEFAULT_CLIENT_VERSION;
let lastClientVersionFetchAt = 0;
let clientSessionId: string | null = null;

/**
 * Стабильный Client-Session-Id на процесс (или из TWITCH_CLIENT_SESSION_ID)
 */
export function getClientSessionId(): string {
  const fromEnv = process.env.TWITCH_CLIENT_SESSION_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (!clientSessionId) {
    clientSessionId = randomBytes(16).toString('hex');
  }
  return clientSessionId;
}

/**
 * Собирает заголовок Cookie: TWITCH_COOKIES + auth-token при отсутствии
 */
export function buildCookieHeader(authToken: string): string | undefined {
  const extra = process.env.TWITCH_COOKIES?.trim();
  if (!extra && !authToken) {
    return undefined;
  }

  const parts: string[] = [];
  if (extra) {
    parts.push(extra.replace(/;\s*$/, ''));
  }
  const combined = parts.join('; ');
  if (!/auth-token=/i.test(combined)) {
    parts.push(`auth-token=${authToken}`);
  }
  return parts.filter(Boolean).join('; ');
}

/**
 * Обновляет Client-Version с главной страницы Twitch (как Channel Points Miner)
 */
export async function refreshClientVersionIfStale(now = Date.now()): Promise<string> {
  const pinned = process.env.TWITCH_CLIENT_VERSION?.trim();
  if (pinned) {
    cachedClientVersion = pinned;
    return cachedClientVersion;
  }

  const refreshMs = parseInt(process.env.TWITCH_CLIENT_VERSION_REFRESH_MS || '21600000', 10);
  if (now - lastClientVersionFetchAt < refreshMs) {
    return cachedClientVersion;
  }

  const fetchTimeoutMs = parseInt(process.env.FETCH_TIMEOUT_MS || '20000', 10);
  try {
    const response = await fetch(TWITCH_HOME_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
    if (!response.ok) {
      return cachedClientVersion;
    }
    const html = await response.text();
    const match = TWILIGHT_BUILD_ID_PATTERN.exec(html);
    if (match?.[1]) {
      cachedClientVersion = match[1];
      lastClientVersionFetchAt = now;
      logger.verbose(`🌐  Client-Version обновлён: ${cachedClientVersion.slice(0, 8)}...`);
    }
  } catch (error: any) {
    logger.verbose(`⚠️  Client-Version: ${error.message || error}`);
  }

  return cachedClientVersion;
}

/**
 * Базовые заголовки для gql.twitch.tv и /integrity
 */
export async function buildTwitchGqlHeaders(params: {
  authToken: string;
  userAgent: string;
  clientId: string;
  deviceId?: string;
  integrityToken?: string;
}): Promise<Record<string, string>> {
  const clientVersion = await refreshClientVersionIfStale();
  const headers: Record<string, string> = {
    Authorization: `OAuth ${params.authToken}`,
    'Client-Id': params.clientId,
    'Client-Version': clientVersion,
    'Client-Session-Id': getClientSessionId(),
    'User-Agent': params.userAgent,
    'Content-Type': 'application/json',
  };

  if (params.deviceId) {
    headers['X-Device-Id'] = params.deviceId;
  }
  if (params.integrityToken) {
    headers['Client-Integrity'] = params.integrityToken;
  }

  const cookie = buildCookieHeader(params.authToken);
  if (cookie) {
    headers['Cookie'] = cookie;
  }

  return headers;
}
