import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadIntegritySource,
  hasManualIntegrityToken,
  getManualIntegrityToken,
} from '../integrityConfig';

describe('integrityConfig', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    delete process.env.TWITCH_INTEGRITY_SOURCE;
    delete process.env.TWITCH_INTEGRITY_BROWSER;
    delete process.env.TWITCH_CLIENT_INTEGRITY;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('по умолчанию browser', () => {
    expect(loadIntegritySource()).toBe('browser');
  });

  it('TWITCH_INTEGRITY_SOURCE=manual', () => {
    process.env.TWITCH_INTEGRITY_SOURCE = 'manual';
    expect(loadIntegritySource()).toBe('manual');
  });

  it('TWITCH_INTEGRITY_BROWSER=false с ручным токеном → manual', () => {
    process.env.TWITCH_INTEGRITY_BROWSER = 'false';
    process.env.TWITCH_CLIENT_INTEGRITY = 'v4.public.test';
    expect(loadIntegritySource()).toBe('manual');
  });

  it('TWITCH_INTEGRITY_BROWSER=false без токена → api', () => {
    process.env.TWITCH_INTEGRITY_BROWSER = 'false';
    expect(loadIntegritySource()).toBe('api');
  });

  it('hasManualIntegrityToken и getManualIntegrityToken', () => {
    process.env.TWITCH_CLIENT_INTEGRITY = '  token-abc  ';
    expect(hasManualIntegrityToken()).toBe(true);
    expect(getManualIntegrityToken()).toBe('token-abc');
  });
});
