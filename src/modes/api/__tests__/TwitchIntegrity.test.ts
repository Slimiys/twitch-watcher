import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TwitchIntegrityProvider } from '../TwitchIntegrity';

describe('TwitchIntegrityProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('кэширует integrity token до истечения срока', async () => {
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
        }),
      })
    );
  });

  it('invalidate сбрасывает кэш и запрашивает новый token', async () => {
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
