import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createContext, runInContext } from 'vm';
import { describe, expect, it, vi } from 'vitest';

function harness(initial: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = { streamNotificationsEnabled: true, ...initial };
  const create = vi.fn().mockResolvedValue('notification');
  const context = createContext({
    console: { warn: vi.fn() }, URL,
    fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [] }) }),
    chrome: {
      runtime: { getURL: (p: string) => p },
      storage: { local: {
        get: async () => ({ ...stored }),
        set: async (value: Record<string, unknown>) => { Object.assign(stored, value); },
      } },
      notifications: { create },
    },
  });
  runInContext(readFileSync(resolve('extensions/edge-integrity-bridge/streamNotifications.js'), 'utf8'), context);
  return { stored, create, context, run: (code: string) => runInContext(code, context) };
}

describe('extension notifications (actual service-worker script)', () => {
  it('reports connection freshness, last delivery and a safe HTTP error', async () => {
    const h = harness();
    await h.run('loadStreamNotificationsState()');
    h.run("handleOffscreenMessage({type:'OFFSCREEN_KEEPALIVE', connected:true})");
    expect(h.run('getStreamNotificationDiagnostics().connection')).toBe('connected');
    await h.run("handleStreamHubEvent({type:'stream-up', streamer:'a', timestamp:100})");
    expect(h.run('getStreamNotificationDiagnostics().lastDeliveredAt')).toBeGreaterThan(0);
    expect(h.run('getStreamNotificationDiagnostics().lastEventStreamer')).toBe('a');
    h.context.fetch.mockResolvedValue({ ok: false, status: 401 });
    await h.run('pollRecentStreamEvents()');
    expect(h.run('getStreamNotificationDiagnostics().lastError.message')).toBe('Ошибка опроса: HTTP 401');
    h.run('streamNotifyDiagnostics.connectionCheckedAt = 1');
    expect(h.run('getStreamNotificationDiagnostics().connection')).toBe('reconnecting');
    h.run('streamNotificationsEnabled = false');
    expect(h.run('getStreamNotificationDiagnostics().connection')).toBe('disabled');
  });

  it('delivers different streamers and event types at the same millisecond, deduplicating concurrent copies', async () => {
    const h = harness();
    await h.run('loadStreamNotificationsState()');
    await h.run(`Promise.all([
      handleStreamHubEvent({ type: 'stream-up', streamer: 'a', timestamp: 100 }),
      handleStreamHubEvent({ type: 'stream-up', streamer: 'b', timestamp: 100 }),
      handleStreamHubEvent({ type: 'stream-up', streamer: 'a', timestamp: 100 }),
      handleStreamHubEvent({ type: 'stream-down', streamer: 'a', timestamp: 100 })
    ])`);
    expect(h.create).toHaveBeenCalledTimes(3);
    const restarted = harness(h.stored);
    await restarted.run('loadStreamNotificationsState()');
    await restarted.run("handleStreamHubEvent({type:'stream-up', streamer:'a', timestamp:100})");
    expect(restarted.create).not.toHaveBeenCalled();
  });

  it('retries failed delivery even after a newer event succeeds', async () => {
    const h = harness();
    await h.run('loadStreamNotificationsState()');
    h.create.mockRejectedValueOnce(new Error('notification unavailable'));
    await h.run("handleStreamHubEvent({type:'stream-up', streamer:'a', timestamp:100})");
    expect(h.stored.deliveredStreamEvents).toBeUndefined();
    await h.run("handleStreamHubEvent({type:'stream-up', streamer:'b', timestamp:200})");
    await h.run("handleStreamHubEvent({type:'stream-up', streamer:'a', timestamp:100})");
    expect(h.create).toHaveBeenCalledTimes(3);
    expect(h.stored.deliveredStreamEvents).toHaveLength(2);
  });

  it('polls the full retained history, not just the latest 20 unrelated events', async () => {
    const h = harness({ streamEventBaseline: 50 });
    h.context.fetch.mockResolvedValue({ ok: true, json: async () => ({ events: [
      ...Array.from({ length: 25 }, (_, i) => ({ type: 'points', timestamp: 200 + i })),
      { type: 'stream-up', streamer: 'a', timestamp: 100 },
      { type: 'stream-up', streamer: 'old', timestamp: 40 },
    ] }) });
    await h.run('loadStreamNotificationsState()');
    await h.run('pollRecentStreamEvents()');
    expect(h.context.fetch.mock.calls[0][0]).toContain('limit=1000');
    expect(h.create).toHaveBeenCalledTimes(1);
  });
});

describe('extension dashboard config sync', () => {
  async function sync(stored: Record<string, string>, botUrl: string, senderUrl: string, apiKey = '') {
    let listener: any;
    const context = createContext({ URL,
      chrome: {
        runtime: { onMessage: { addListener: (fn: any) => { listener = fn; } } },
        storage: { local: {
          get: async () => ({ ...stored }),
          set: async (value: Record<string, string>) => { Object.assign(stored, value); },
        } },
      },
    });
    const source = readFileSync(resolve('extensions/edge-integrity-bridge/background.js'), 'utf8');
    runInContext(source.slice(source.indexOf('chrome.runtime.onMessage.addListener')), context);
    return new Promise<any>(resolveResult => listener(
      { type: 'SYNC_BRIDGE_CONFIG', botUrl, apiKey }, { url: senderUrl }, resolveResult
    ));
  }

  it('preserves a saved key when dashboard sends an empty one', async () => {
    const stored = { botUrl: 'http://localhost:3001', apiKey: 'saved-key' };
    expect((await sync(stored, stored.botUrl, `${stored.botUrl}/dashboard`)).ok).toBe(true);
    expect(stored.apiKey).toBe('saved-key');
    await sync(stored, stored.botUrl, stored.botUrl, 'new-key');
    expect(stored.apiKey).toBe('new-key');
  });

  it('rejects another local origin changing the configured bot', async () => {
    const stored = { botUrl: 'http://localhost:3001', apiKey: 'saved-key' };
    expect((await sync(stored, 'http://localhost:8000', 'http://localhost:8000')).ok).toBe(false);
    expect((await sync(stored, stored.botUrl, 'http://localhost:8000')).ok).toBe(false);
    expect(stored.botUrl).toBe('http://localhost:3001');
  });
});
