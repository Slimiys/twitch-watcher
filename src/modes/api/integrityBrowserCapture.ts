/**
 * Приём Client-Integrity из браузерного расширения (DevTools / gql)
 */

import { applyBrowserGqlContext, BrowserGqlContextInput } from './browserGqlContextCapture';
import { integrityExpirationToMs } from './integrityConfig';
import { recordIntegrityTokenForDisplay } from './integrityTokenDisplay';
import { logger } from './logger';
import { persistIntegrityToAppConfig } from './integrityPersistence';

/** Срок действия токена из браузера по умолчанию (4 ч) */
const DEFAULT_BROWSER_INTEGRITY_TTL_MS = 4 * 60 * 60 * 1000;

/** Минимальный интервал между одинаковыми токенами (мс) */
const DUPLICATE_CAPTURE_INTERVAL_MS = 15_000;

export interface BrowserIntegrityCaptureInput extends BrowserGqlContextInput {
  clientIntegrity: string;
  deviceId?: string;
  /** Unix sec или ms; если не задан — +4 ч */
  expiresAt?: number;
  source?: string;
}

export interface BrowserIntegrityCaptureResult {
  applied: boolean;
  skipped: boolean;
  integrityApplied: boolean;
  gqlContextApplied: boolean;
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
      integrityApplied: false,
      gqlContextApplied: false,
      message: 'Приём integrity от расширения отключён (INTEGRITY_BRIDGE_ENABLED=false)',
      expiresAtMs: 0,
      deviceIdPrefix: null,
      capturedAt: now,
    };
  }

  const gqlContextApplied = applyBrowserGqlContext({
    clientVersion: input.clientVersion,
    clientSessionId: input.clientSessionId,
    deviceId: input.deviceId,
  });

  const token = normalizeClientIntegrityToken(input.clientIntegrity);
  if (token) {
    recordIntegrityTokenForDisplay(token);
  }
  if (!token) {
    if (gqlContextApplied) {
      return {
        applied: true,
        skipped: false,
        integrityApplied: false,
        gqlContextApplied: true,
        message: 'GQL-контекст применён (Client-Integrity не передан или некорректен)',
        expiresAtMs: 0,
        deviceIdPrefix: input.deviceId?.trim().slice(0, 8) ?? null,
        capturedAt: now,
      };
    }
    return {
      applied: false,
      skipped: true,
      integrityApplied: false,
      gqlContextApplied: false,
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
    if (gqlContextApplied) {
      return {
        applied: true,
        skipped: false,
        integrityApplied: false,
        gqlContextApplied: true,
        message: 'GQL-контекст обновлён (тот же Client-Integrity недавно уже применён)',
        expiresAtMs,
        deviceIdPrefix: input.deviceId?.trim().slice(0, 8) ?? null,
        capturedAt: now,
      };
    }
    return {
      applied: false,
      skipped: true,
      integrityApplied: false,
      gqlContextApplied: false,
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

  process.env.TWITCH_INTEGRITY_SOURCE = 'manual';
  persistIntegrityToAppConfig(token, expiresAtMs);

  const deviceIdPrefix =
    process.env.TWITCH_DEVICE_ID?.trim().slice(0, 8) ??
    input.deviceId?.trim().slice(0, 8) ??
    null;

  lastCaptureToken = token;
  lastCaptureAt = now;

  const sourceLabel = input.source?.trim() || 'browser-extension';
  logger.info(
    `🔐  Client-Integrity обновлён из ${sourceLabel} (истекает через ${formatExpiresIn(expiresAtMs, now)})`
  );

  const message = gqlContextApplied
    ? 'Client-Integrity и GQL-контекст применены'
    : 'Client-Integrity применён';

  return {
    applied: true,
    skipped: false,
    integrityApplied: true,
    gqlContextApplied,
    message,
    expiresAtMs,
    deviceIdPrefix,
    capturedAt: now,
  };
}

/**
 * Время последнего успешного применения токена из браузера
 */
export function getLastIntegrityCaptureAt(): number {
  return lastCaptureAt;
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
