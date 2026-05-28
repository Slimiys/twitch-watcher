/**
 * API приёма Client-Integrity от браузерного расширения
 */

import { StreamWatcher } from '../modes/api/StreamWatcher';
import {
  applyBrowserIntegrityCapture,
  BrowserIntegrityCaptureInput,
  BrowserIntegrityCaptureResult,
  getLastIntegrityCaptureAt,
  isIntegrityBridgeEnabled,
} from '../modes/api/integrityBrowserCapture';
import { getDashboardApiKey } from './apiAuth';
import { getWebServerScheme } from './httpsCredentials';
import {
  clearIntegrityCaptureRequest,
  getIntegrityCaptureRequestSnapshot,
  requestIntegrityCaptureFromBridge,
} from './integrityCaptureRequest';

export interface IntegrityCaptureStatus {
  enabled: boolean;
  apiKeyRequired: boolean;
  suggestedBotUrl: string;
  lastCaptureAt: number | null;
  captureRequestedAt: number | null;
  captureRequestPending: boolean;
}

export interface IntegrityCaptureRequestResult {
  ok: boolean;
  requestedAt: number;
  message: string;
}

/**
 * GET /api/integrity/capture/status
 */
export function getIntegrityCaptureStatus(port: number): IntegrityCaptureStatus {
  const scheme = getWebServerScheme();
  const request = getIntegrityCaptureRequestSnapshot();
  const lastAt = getLastIntegrityCaptureAt();
  return {
    enabled: isIntegrityBridgeEnabled(),
    apiKeyRequired: Boolean(getDashboardApiKey()),
    suggestedBotUrl: `${scheme}://127.0.0.1:${port}`,
    lastCaptureAt: lastAt > 0 ? lastAt : null,
    captureRequestedAt: request.captureRequestedAt,
    captureRequestPending: request.captureRequestPending,
  };
}

/**
 * POST /api/integrity/capture/request — запрос токена от расширения (дашборд)
 */
export function postIntegrityCaptureRequest(): IntegrityCaptureRequestResult {
  if (!isIntegrityBridgeEnabled()) {
    return {
      ok: false,
      requestedAt: 0,
      message: 'Приём integrity от расширения отключён (INTEGRITY_BRIDGE_ENABLED=false)',
    };
  }

  const { requestedAt } = requestIntegrityCaptureFromBridge();
  return {
    ok: true,
    requestedAt,
    message: 'Запрос отправлен. Откройте twitch.tv в Edge с расширением Integrity Bridge.',
  };
}

/**
 * POST /api/integrity/capture
 */
export function postIntegrityCapture(
  body: Record<string, unknown>,
  statisticsProvider: StreamWatcher | null
): BrowserIntegrityCaptureResult {
  const input: BrowserIntegrityCaptureInput = {
    clientIntegrity: String(body.clientIntegrity ?? body.integrity ?? ''),
    deviceId: body.deviceId != null ? String(body.deviceId) : undefined,
    expiresAt:
      body.expiresAt != null
        ? Number(body.expiresAt)
        : body.expiresAtSec != null
          ? Number(body.expiresAtSec)
          : undefined,
    source: body.source != null ? String(body.source) : 'edge-extension',
  };

  const result = applyBrowserIntegrityCapture(input);

  if (result.applied) {
    clearIntegrityCaptureRequest();
    if (statisticsProvider) {
      statisticsProvider.invalidateIntegrityProviders();
    }
  }

  return result;
}
