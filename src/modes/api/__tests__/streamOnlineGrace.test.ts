import { describe, it, expect, afterEach } from 'vitest';
import { StreamerInfo } from '../types';
import {
  getWebSocketOnlineGraceMs,
  isEffectivelyOnline,
  getEffectiveWatchStartTime,
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

  it('isEffectivelyOnline false после grace', () => {
    process.env.WS_ONLINE_GRACE_MS = '60000';
    const now = Date.now();
    const info = baseInfo();
    info.webSocketOnlineAt = now - 90_000;
    expect(isEffectivelyOnline(info, now)).toBe(false);
  });

  it('getEffectiveWatchStartTime использует webSocketOnlineAt если startTime=0', () => {
    const wsAt = Date.now() - 30_000;
    const info = baseInfo();
    info.webSocketOnlineAt = wsAt;
    expect(getEffectiveWatchStartTime(info)).toBe(wsAt);
  });

  it('getWebSocketOnlineGraceMs по умолчанию 120000', () => {
    delete process.env.WS_ONLINE_GRACE_MS;
    expect(getWebSocketOnlineGraceMs()).toBe(120_000);
  });
});
