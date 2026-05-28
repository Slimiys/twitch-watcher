/**
 * Приём Client-Integrity из браузерного расширения (DevTools / gql)
 */

import { logger } from './logger';
import { persistIntegrityToAppConfig } from './integrityPersistence';
import { integrityExpirationToMs } from './integrityConfig';

/** Срок действия токена из браузера по умолчанию (4 ч) */
const DEFAULT_BROWSER_INTEGRITY_TTL_MS = 4 * 60 * 60 * 1000;

/** Минимальный интервал между одинаковыми токенами (мс) */
const DUPLICATE_CAPTURE_INTERVAL_MS = 15_000;

export interface BrowserIntegrityCaptureInput {
  clientIntegrity: string;
  deviceId?: string;
  /** Unix sec или ms; если не задан — +4 ч */
  expiresAt?: number;
  source?: string;
}

export interface BrowserIntegrityCaptureResult {
  applied: boolean;
  skipped: boolean;
  message: string;
  expiresAtMs: number;
  deviceIdPrefix: string | null;
  capturedAt: number;
}

let lastCaptureToken = '';
let lastCaptureAt = 0;

/**
 * Включён ли приём integrity от расширения
 */
export function isIntegrityBridgeEnabled(): boolean {
  const raw = process.env.INTEGRITY_BRIDGE_ENABLED?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0';
}

/**
 * Нормализует и проверяет токен Client-Integrity
 */
export function normalizeClientIntegrityToken(raw: unknown): string | null {
  if (raw == null) {
    return null;
  }
  const token = String(raw).trim();
  if (token.length < 16 || token.length > 8192) {
    return null;
  }
  return token;
}

/**
 * Применяет Client-Integrity из браузера (config + process.env)
 */
export function applyBrowserIntegrityCapture(
  input: BrowserIntegrityCaptureInput,
  now = Date.now()
): BrowserIntegrityCaptureResult {
  if (!isIntegrityBridgeEnabled()) {
    return {
      applied: false,
      skipped: true,
      message: 'Приём integrity от расширения отключён (INTEGRITY_BRIDGE_ENABLED=false)',
      expiresAtMs: 0,
      deviceIdPrefix: null,
      capturedAt: now,
    };
  }

  const token = normalizeClientIntegrityToken(input.clientIntegrity);
  if (!token) {
    return {
      applied: false,
      skipped: true,
      message: 'Некорректный Client-Integrity',
      expiresAtMs: 0,
      deviceIdPrefix: null,
      capturedAt: now,
    };
  }

  if (
    token === lastCaptureToken &&
    now - lastCaptureAt < DUPLICATE_CAPTURE_INTERVAL_MS
  ) {
    const manualExpires = process.env.TWITCH_CLIENT_INTEGRITY_EXPIRES?.trim();
    const expiresAtMs = manualExpires
      ? integrityExpirationToMs(Number(manualExpires), now)
      : now + DEFAULT_BROWSER_INTEGRITY_TTL_MS;
    return {
      applied: false,
      skipped: true,
      message: 'Тот же токен недавно уже применён',
      expiresAtMs,
      deviceIdPrefix: input.deviceId?.trim().slice(0, 8) ?? null,
      capturedAt: now,
    };
  }

  const expiresAtMs =
    input.expiresAt != null && Number.isFinite(Number(input.expiresAt))
      ? integrityExpirationToMs(Number(input.expiresAt), now)
      : now + DEFAULT_BROWSER_INTEGRITY_TTL_MS;

  const deviceId = input.deviceId?.trim() || undefined;

  process.env.TWITCH_INTEGRITY_SOURCE = 'manual';
  persistIntegrityToAppConfig(token, expiresAtMs, deviceId);

  lastCaptureToken = token;
  lastCaptureAt = now;

  const sourceLabel = input.source?.trim() || 'browser-extension';
  logger.info(
    `🔐  Client-Integrity обновлён из ${sourceLabel} (истекает через ${formatExpiresIn(expiresAtMs, now)})`
  );

  return {
    applied: true,
    skipped: false,
    message: 'Client-Integrity применён',
    expiresAtMs,
    deviceIdPrefix: deviceId ? deviceId.slice(0, 8) : null,
    capturedAt: now,
  };
}

/**
 * Сброс троттлинга (тесты)
 */
export function resetIntegrityCaptureThrottleForTests(): void {
  lastCaptureToken = '';
  lastCaptureAt = 0;
}

function formatExpiresIn(expiresAtMs: number, now: number): string {
  const min = Math.max(0, Math.round((expiresAtMs - now) / 60_000));
  if (min < 60) {
    return `~${min} мин`;
  }
  return `~${Math.round(min / 60)} ч`;
}
