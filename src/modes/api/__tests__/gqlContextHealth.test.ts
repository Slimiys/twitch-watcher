import { describe, it, expect, afterEach } from 'vitest';
import {
  applyBrowserGqlContext,
  getGqlContextHealthSnapshot,
  resetGqlContextHealthForTests,
} from '../browserGqlContextCapture';

describe('gqlContextHealth', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    resetGqlContextHealthForTests();
  });

  it('getGqlContextHealthSnapshot возвращает значения и время обновления', () => {
    process.env.TWITCH_INTEGRITY_AUTO_PERSIST = 'false';
    const version = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const session = 'b'.repeat(32);
    const device = 'c'.repeat(32);
    const now = 1_000_000;

    applyBrowserGqlContext({ clientVersion: version, clientSessionId: session, deviceId: device }, now);

    const snap = getGqlContextHealthSnapshot();
    expect(snap.clientVersion.value).toBe(version.slice(0, 32));
    expect(snap.clientVersion.lastUpdatedAtMs).toBe(now);
    expect(snap.clientSessionId.lastUpdatedAtMs).toBe(now);
    expect(snap.deviceId.lastUpdatedAtMs).toBe(now);
  });

  it('обновляет lastUpdatedAt при повторной передаче того же значения', () => {
    process.env.TWITCH_INTEGRITY_AUTO_PERSIST = 'false';
    const version = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    applyBrowserGqlContext({ clientVersion: version }, 1000);
    applyBrowserGqlContext({ clientVersion: version }, 2000);
    expect(getGqlContextHealthSnapshot().clientVersion.lastUpdatedAtMs).toBe(2000);
  });
});
