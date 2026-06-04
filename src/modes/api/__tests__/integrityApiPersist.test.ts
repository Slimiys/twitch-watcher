import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  persistApiIntegrityToken,
  shouldPersistApiIntegrityToManualSlot,
} from '../integrityApiPersist';

describe('integrityApiPersist', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    delete process.env.INTEGRITY_BRIDGE_ENABLED;
    delete process.env.TWITCH_INTEGRITY_API_OVERWRITE_MANUAL;
    delete process.env.TWITCH_CLIENT_INTEGRITY;
    delete process.env.TWITCH_CLIENT_INTEGRITY_EXPIRES;
    process.env.TWITCH_INTEGRITY_AUTO_PERSIST = 'false';
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('не перезаписывает manual при включённом bridge', () => {
    process.env.INTEGRITY_BRIDGE_ENABLED = 'true';
    process.env.TWITCH_CLIENT_INTEGRITY = 'browser-token';
    process.env.TWITCH_CLIENT_INTEGRITY_EXPIRES = String(Math.floor(Date.now() / 1000) + 3600);

    expect(shouldPersistApiIntegrityToManualSlot()).toBe(false);

    persistApiIntegrityToken('api-token', Date.now() + 3_600_000);

    expect(process.env.TWITCH_CLIENT_INTEGRITY).toBe('browser-token');
  });

  it('перезаписывает manual без bridge', () => {
    process.env.INTEGRITY_BRIDGE_ENABLED = 'false';
    expect(shouldPersistApiIntegrityToManualSlot()).toBe(true);

    persistApiIntegrityToken('api-token', Date.now() + 3_600_000);

    expect(process.env.TWITCH_CLIENT_INTEGRITY).toBe('api-token');
  });
});
