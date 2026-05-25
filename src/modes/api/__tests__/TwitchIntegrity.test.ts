import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TwitchIntegrityProvider } from '../TwitchIntegrity';

describe('TwitchIntegrityProvider', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.TWITCH_CLIENT_VERSION = 'test-build-id-for-vitest';
    delete process.env.TWITCH_CLIENT_INTEGRITY;
    delete process.env.TWITCH_CLIENT_INTEGRITY_EXPIRES;
    delete process.env.TWITCH_INTEGRITY_SOURCE;
    delete process.env.TWITCH_INTEGRITY_FALLBACK_API;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('кэширует integrity token до истечения срока (api)', async () => {
    process.env.TWITCH_INTEGRITY_SOURCE = 'api';
    const provider = new TwitchIntegrityProvider('oauth-token', 'test-agent', 'device-123');

    (global.fetch as any) = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'cached-token',
        expiration: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    const first = await provider.getToken();
    const second = await provider.getToken();

    expect(first).toBe('cached-token');
    expect(second).toBe('cached-token');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://gql.twitch.tv/integrity',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'OAuth oauth-token',
          'X-Device-Id': 'device-123',
          'Client-Version': expect.any(String),
          'Client-Session-Id': expect.any(String),
        }),
      })
    );
  });

  it('manual возвращает TWITCH_CLIENT_INTEGRITY без fetch', async () => {
    process.env.TWITCH_INTEGRITY_SOURCE = 'manual';
    process.env.TWITCH_CLIENT_INTEGRITY = 'devtools-integrity-token';
    process.env.TWITCH_CLIENT_INTEGRITY_EXPIRES = String(Math.floor(Date.now() / 1000) + 7200);

    (global.fetch as any) = vi.fn();
    const provider = new TwitchIntegrityProvider('oauth-token', 'test-agent', 'device-123');

    const token = await provider.getToken();
    expect(token).toBe('devtools-integrity-token');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('invalidate сбрасывает кэш API и запрашивает новый token', async () => {
    process.env.TWITCH_INTEGRITY_SOURCE = 'api';
    const provider = new TwitchIntegrityProvider('oauth-token', 'test-agent', 'device-123');

    (global.fetch as any) = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          token: 'token-1',
          expiration: Math.floor(Date.now() / 1000) + 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          token: 'token-2',
          expiration: Math.floor(Date.now() / 1000) + 3600,
        }),
      });

    await provider.getToken();
    provider.invalidate();
    const refreshed = await provider.getToken();

    expect(refreshed).toBe('token-2');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
