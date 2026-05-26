import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../../../pidFile';
import { extractUniqueIdFromCookies, resolveStableDeviceId } from '../integrityDeviceId';

describe('integrityDeviceId', () => {
  const envBackup = { ...process.env };
  const deviceFile = path.join(getProjectRoot(), '.twitch-device-id');

  afterEach(() => {
    process.env = { ...envBackup };
    try {
      if (fs.existsSync(deviceFile)) {
        fs.unlinkSync(deviceFile);
      }
    } catch {
      // ignore
    }
  });

  it('извлекает unique_id из TWITCH_COOKIES', () => {
    expect(extractUniqueIdFromCookies('unique_id=abc123; api_token=x')).toBe('abc123');
  });

  it('resolveStableDeviceId использует TWITCH_DEVICE_ID', () => {
    process.env.TWITCH_DEVICE_ID = 'device-from-env';
    expect(resolveStableDeviceId()).toBe('device-from-env');
  });

  it('resolveStableDeviceId берёт unique_id из cookies', () => {
    delete process.env.TWITCH_DEVICE_ID;
    process.env.TWITCH_COOKIES = 'unique_id=cookie-device';
    expect(resolveStableDeviceId()).toBe('cookie-device');
    expect(process.env.TWITCH_DEVICE_ID).toBe('cookie-device');
  });
});
