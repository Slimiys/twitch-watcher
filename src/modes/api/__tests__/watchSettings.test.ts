import { afterEach, describe, expect, it } from 'vitest';
import {
  applyWatchSettingsOverrides,
  clampWatchCycleIntervalMs,
  getWatchSettings,
  parseWatchCycleIntervalMsFromEnv,
  parseWatchModeFromEnv,
  resetWatchSettingsOverrides,
} from '../watchSettings';

describe('watchSettings', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    resetWatchSettingsOverrides();
  });

  it('defaults to sequential mode and 60s interval', () => {
    delete process.env.WATCH_MODE;
    delete process.env.WATCH_CYCLE_INTERVAL_MS;
    resetWatchSettingsOverrides();
    expect(parseWatchModeFromEnv()).toBe('sequential');
    expect(parseWatchCycleIntervalMsFromEnv()).toBe(60_000);
    expect(getWatchSettings().mode).toBe('sequential');
  });

  it('parses per-channel and batch modes', () => {
    process.env.WATCH_MODE = 'per-channel';
    expect(parseWatchModeFromEnv()).toBe('per-channel');
    process.env.WATCH_MODE = 'perchannel';
    expect(parseWatchModeFromEnv()).toBe('per-channel');
    process.env.WATCH_MODE = 'batch';
    expect(parseWatchModeFromEnv()).toBe('batch');
  });

  it('clamps cycle interval to 15s..600s', () => {
    expect(clampWatchCycleIntervalMs(1)).toBe(15_000);
    expect(clampWatchCycleIntervalMs(999_999)).toBe(600_000);
    expect(clampWatchCycleIntervalMs(45_000)).toBe(45_000);
  });

  it('runtime overrides take precedence over env', () => {
    process.env.WATCH_MODE = 'batch';
    process.env.WATCH_CYCLE_INTERVAL_MS = '120000';
    resetWatchSettingsOverrides();
    applyWatchSettingsOverrides({ mode: 'sequential', cycleIntervalMs: 30_000 });
    const settings = getWatchSettings();
    expect(settings.mode).toBe('sequential');
    expect(settings.cycleIntervalMs).toBe(30_000);
  });
});
