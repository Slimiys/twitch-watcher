/**
 * API приёма Client-Integrity от браузерного расширения
 */

import { StreamWatcher } from '../modes/api/StreamWatcher';
import {
  applyBrowserIntegrityCapture,
  BrowserIntegrityCaptureInput,
  BrowserIntegrityCaptureResult,
  isIntegrityBridgeEnabled,
} from '../modes/api/integrityBrowserCapture';
import { getDashboardApiKey } from './apiAuth';
import { getWebServerScheme } from './httpsCredentials';

export interface IntegrityCaptureStatus {
  enabled: boolean;
  apiKeyRequired: boolean;
  suggestedBotUrl: string;
  lastCaptureAt: number | null;
}

/**
 * GET /api/integrity/capture/status
 */
export function getIntegrityCaptureStatus(port: number): IntegrityCaptureStatus {
  const scheme = getWebServerScheme();
  return {
    enabled: isIntegrityBridgeEnabled(),
    apiKeyRequired: Boolean(getDashboardApiKey()),
    suggestedBotUrl: `${scheme}://127.0.0.1:${port}`,
    lastCaptureAt: null,
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

  if (result.applied && statisticsProvider) {
    statisticsProvider.invalidateIntegrityProviders();
  }

  return result;
}
