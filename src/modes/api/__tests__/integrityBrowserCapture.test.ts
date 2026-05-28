import { describe, it, expect, afterEach } from 'vitest';
import {
  applyBrowserIntegrityCapture,
  isIntegrityBridgeEnabled,
  normalizeClientIntegrityToken,
  resetIntegrityCaptureThrottleForTests,
} from '../integrityBrowserCapture';
import { resetIntegrityTokenDisplayForTests } from '../integrityTokenDisplay';

describe('integrityBrowserCapture', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    resetIntegrityCaptureThrottleForTests();
    resetIntegrityTokenDisplayForTests();
  });

  it('normalizeClientIntegrityToken отклоняет короткие значения', () => {
    expect(normalizeClientIntegrityToken('short')).toBeNull();
    expect(normalizeClientIntegrityToken('a'.repeat(20))).not.toBeNull();
  });

  it('applyBrowserIntegrityCapture сохраняет в env', () => {
    delete process.env.INTEGRITY_BRIDGE_ENABLED;
    process.env.TWITCH_INTEGRITY_AUTO_PERSIST = 'false';

    const token = 'x'.repeat(40);
    const result = applyBrowserIntegrityCapture({ clientIntegrity: token });

    expect(result.applied).toBe(true);
    expect(result.integrityApplied).toBe(true);
    expect(process.env.TWITCH_CLIENT_INTEGRITY).toBe(token);
    expect(process.env.TWITCH_INTEGRITY_SOURCE).toBe('manual');
  });

  it('applyBrowserIntegrityCapture применяет GQL-контекст вместе с integrity', () => {
    delete process.env.INTEGRITY_BRIDGE_ENABLED;
    process.env.TWITCH_INTEGRITY_AUTO_PERSIST = 'false';

    const token = 'z'.repeat(40);
    const version = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const session = 'd'.repeat(32);
    const device = 'e'.repeat(32);

    const result = applyBrowserIntegrityCapture({
      clientIntegrity: token,
      clientVersion: version,
      clientSessionId: session,
      deviceId: device,
    });

    expect(result.applied).toBe(true);
    expect(result.gqlContextApplied).toBe(true);
    expect(process.env.TWITCH_CLIENT_VERSION).toBe(version);
    expect(process.env.TWITCH_CLIENT_SESSION_ID).toBe(session);
    expect(process.env.TWITCH_DEVICE_ID).toBe(device);
  });

  it('троттлит повтор той же передачи', () => {
    const token = 'y'.repeat(40);
    applyBrowserIntegrityCapture({ clientIntegrity: token });
    const second = applyBrowserIntegrityCapture({ clientIntegrity: token });
    expect(second.skipped).toBe(true);
  });

  it('isIntegrityBridgeEnabled false при INTEGRITY_BRIDGE_ENABLED=false', () => {
    process.env.INTEGRITY_BRIDGE_ENABLED = 'false';
    expect(isIntegrityBridgeEnabled()).toBe(false);
  });
});
