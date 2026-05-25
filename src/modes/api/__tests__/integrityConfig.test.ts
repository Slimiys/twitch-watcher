import { describe, it, expect, afterEach } from 'vitest';
import {
  integrityExpirationToMs,
  resolveIntegritySource,
  getManualIntegrityFromEnv,
  allowApiIntegrityFallback,
} from '../integrityConfig';

describe('integrityConfig', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  const now = 1_700_000_000_000;

  it('без expiration — +4 часа от now', () => {
    expect(integrityExpirationToMs(undefined, now)).toBe(now + 4 * 60 * 60 * 1000);
  });

  it('expiration в секундах умножается на 1000', () => {
    expect(integrityExpirationToMs(1_700_000_100, now)).toBe(1_700_000_100_000);
  });

  it('expiration в миллисекундах возвращается как есть', () => {
    expect(integrityExpirationToMs(1_700_000_100_000, now)).toBe(1_700_000_100_000);
  });

  it('auto выбирает manual при TWITCH_CLIENT_INTEGRITY', () => {
    process.env.TWITCH_INTEGRITY_SOURCE = 'auto';
    process.env.TWITCH_CLIENT_INTEGRITY = 'manual-token-xyz';
    expect(resolveIntegritySource()).toBe('manual');
    expect(getManualIntegrityFromEnv(now)?.token).toBe('manual-token-xyz');
  });

  it('auto выбирает api без manual-токена', () => {
    process.env.TWITCH_INTEGRITY_SOURCE = 'auto';
    delete process.env.TWITCH_CLIENT_INTEGRITY;
    expect(resolveIntegritySource()).toBe('api');
  });

  it('fallback API только при TWITCH_INTEGRITY_FALLBACK_API=true', () => {
    delete process.env.TWITCH_INTEGRITY_FALLBACK_API;
    expect(allowApiIntegrityFallback()).toBe(false);
    process.env.TWITCH_INTEGRITY_FALLBACK_API = 'true';
    expect(allowApiIntegrityFallback()).toBe(true);
  });
});
