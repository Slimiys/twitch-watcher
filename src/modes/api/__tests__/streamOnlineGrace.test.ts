import { describe, it, expect, afterEach } from 'vitest';
import { StreamerInfo } from '../types';
import {
  applyBriefOfflineResume,
  beginTentativeOfflineState,
  canResumeFromBriefOffline,
  finalizeOfflineState,
  getDisplayStreamStatus,
  getEffectiveWatchStartTime,
  getOfflineResumeGraceMs,
  getWebSocketOnlineGraceMs,
  isEffectivelyOnline,
  isWithinOfflineResumeGrace,
  shouldFinalizeOffline,
} from '../streamOnlineGrace';

describe('streamOnlineGrace', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  const baseInfo = (): StreamerInfo => ({
    username: 'test',
    channelId: '1',
    channelPoints: 0,
    isOnline: false,
    broadcastId: null,
    game: null,
    title: null,
    tags: [],
    spadeUrl: null,
    startTime: 0,
    initialChannelPoints: null,
    lastChannelPoints: null,
    streamPointsEarned: 0,
  });

  it('isEffectivelyOnline true при isOnline', () => {
    const info = baseInfo();
    info.isOnline = true;
    expect(isEffectivelyOnline(info)).toBe(true);
  });

  it('isEffectivelyOnline true в grace после webSocketOnlineAt', () => {
    const now = Date.now();
    const info = baseInfo();
    info.webSocketOnlineAt = now - 10_000;
    expect(isEffectivelyOnline(info, now)).toBe(true);
  });

  it('isEffectivelyOnline true в grace краткого офлайна', () => {
    const now = Date.now();
    const info = baseInfo();
    info.offlineAt = now - 60_000;
    info.offlineWatchSnapshot = { startTime: now - 3_600_000 };
    expect(isEffectivelyOnline(info, now)).toBe(true);
    expect(getDisplayStreamStatus(info)).toBe('OFFLINE');
  });

  it('isEffectivelyOnline false после grace', () => {
    process.env.WS_ONLINE_GRACE_MS = '60000';
    const now = Date.now();
    const info = baseInfo();
    info.webSocketOnlineAt = now - 90_000;
    expect(isEffectivelyOnline(info, now)).toBe(false);
  });

  it('getEffectiveWatchStartTime использует snapshot при кратком офлайне', () => {
    const wsAt = Date.now() - 3_600_000;
    const info = baseInfo();
    info.offlineAt = Date.now() - 30_000;
    info.offlineWatchSnapshot = { startTime: wsAt };
    info.startTime = 0;
    expect(getEffectiveWatchStartTime(info)).toBe(wsAt);
  });

  it('краткий офлайн: begin → resume без потери startTime', () => {
    const now = Date.now();
    const info = baseInfo();
    info.isOnline = true;
    info.startTime = now - 600_000;
    info.webSocketOnlineAt = now - 600_000;

    expect(beginTentativeOfflineState(info, now)).toBe(true);
    expect(info.isOnline).toBe(false);
    expect(info.startTime).toBe(0);
    expect(canResumeFromBriefOffline(info, now + 120_000)).toBe(true);

    expect(applyBriefOfflineResume(info)).toBe(true);
    expect(info.isOnline).toBe(true);
    expect(info.startTime).toBe(now - 600_000);
    expect(info.offlineAt).toBeUndefined();
  });

  it('shouldFinalizeOffline после истечения grace', () => {
    const now = Date.now();
    const info = baseInfo();
    info.offlineAt = now - getOfflineResumeGraceMs() - 1;
    info.offlineWatchSnapshot = { startTime: now - 1_000 };
    expect(shouldFinalizeOffline(info, now)).toBe(true);
  });

  it('getWebSocketOnlineGraceMs по умолчанию 120000', () => {
    delete process.env.WS_ONLINE_GRACE_MS;
    expect(getWebSocketOnlineGraceMs()).toBe(120_000);
  });

  it('getOfflineResumeGraceMs по умолчанию 300000', () => {
    delete process.env.OFFLINE_RESUME_GRACE_MS;
    expect(getOfflineResumeGraceMs()).toBe(300_000);
  });

  it('finalizeOfflineState очищает grace', () => {
    const info = baseInfo();
    info.offlineAt = Date.now();
    info.offlineWatchSnapshot = { startTime: 1000 };
    finalizeOfflineState(info);
    expect(info.offlineAt).toBeUndefined();
    expect(info.offlineWatchSnapshot).toBeUndefined();
    expect(info.startTime).toBe(0);
  });
});
