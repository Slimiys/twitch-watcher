import { describe, it, expect, afterEach } from 'vitest';
import {
  clearIntegrityCaptureRequest,
  getIntegrityCaptureRequestSnapshot,
  requestIntegrityCaptureFromBridge,
  resetIntegrityCaptureRequestForTests,
} from '../integrityCaptureRequest';

describe('integrityCaptureRequest', () => {
  afterEach(() => {
    resetIntegrityCaptureRequestForTests();
  });

  it('регистрирует и сбрасывает запрос', () => {
    const { requestedAt } = requestIntegrityCaptureFromBridge(1000);
    expect(requestedAt).toBe(1000);
    expect(getIntegrityCaptureRequestSnapshot(1000).captureRequestPending).toBe(true);

    clearIntegrityCaptureRequest();
    expect(getIntegrityCaptureRequestSnapshot(1000).captureRequestPending).toBe(false);
  });

  it('истекает по TTL', () => {
    requestIntegrityCaptureFromBridge(0);
    const snap = getIntegrityCaptureRequestSnapshot(6 * 60 * 1000);
    expect(snap.captureRequestPending).toBe(false);
    expect(snap.captureRequestedAt).toBeNull();
  });
});
