import { describe, it, expect, afterEach } from 'vitest';
import {
  applyBrowserGqlContext,
  normalizeClientSessionId,
  normalizeClientVersion,
  normalizeDeviceId,
  resetGqlContextHealthForTests,
} from '../browserGqlContextCapture';

describe('browserGqlContextCapture', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    resetGqlContextHealthForTests();
  });

  it('normalizeClientVersion принимает twilight build id', () => {
    const id = '23bea896-7d7b-8021-3976-9e75396668f1';
    expect(normalizeClientVersion(id)).toBe(id.toLowerCase());
  });

  it('normalizeClientSessionId принимает hex', () => {
    expect(normalizeClientSessionId('a'.repeat(32))).not.toBeNull();
  });

  it('applyBrowserGqlContext записывает в env', () => {
    process.env.TWITCH_INTEGRITY_AUTO_PERSIST = 'false';
    const version = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const session = 'b'.repeat(32);
    const device = 'c'.repeat(32);

    const changed = applyBrowserGqlContext({
      clientVersion: version,
      clientSessionId: session,
      deviceId: device,
    });

    expect(changed).toBe(true);
    expect(process.env.TWITCH_CLIENT_VERSION).toBe(version);
    expect(process.env.TWITCH_CLIENT_SESSION_ID).toBe(session);
    expect(process.env.TWITCH_DEVICE_ID).toBe(device);
  });

  it('normalizeDeviceId отклоняет короткие значения', () => {
    expect(normalizeDeviceId('short')).toBeNull();
    expect(normalizeDeviceId('a'.repeat(32))).not.toBeNull();
  });
});
