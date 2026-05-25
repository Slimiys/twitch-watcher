import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StreamWatcher } from '../StreamWatcher';

vi.mock('../TwitchAPI', () => ({
  TwitchAPI: vi.fn().mockImplementation(() => ({
    setValidatedUserId: vi.fn(),
  })),
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    important: vi.fn(),
  },
}));

vi.mock('../configLoader', () => ({
  loadStatisticsConfig: vi.fn(() => ({ storagePath: './statistics-test-claim-health' })),
  loadRetryConfig: vi.fn(() => ({})),
}));

describe('claimHealthRecent', () => {
  let watcher: StreamWatcher;

  beforeEach(() => {
    watcher = new StreamWatcher('token', 'ua', ['a']);
  });

  it('хранит не более 5 последних claim по времени', () => {
    let now = 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now++);

    for (let i = 0; i < 7; i++) {
      (watcher as any).recordClaimHealth(`s${i}`, {
        outcome: 'success',
        message: 'ok',
      });
    }

    nowSpy.mockRestore();

    const health = watcher.getBotHealth();
    expect(health.claimByStreamer).toHaveLength(5);
    expect(health.claimByStreamer[0].streamer).toBe('s6');
    expect(health.claimByStreamer[4].streamer).toBe('s2');
    expect(health.claimByStreamer.map((c) => c.streamer)).not.toContain('s0');
    expect(health.claimByStreamer.map((c) => c.streamer)).not.toContain('s1');
  });
});
