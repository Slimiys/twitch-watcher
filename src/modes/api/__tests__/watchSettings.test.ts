import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyWatchCycleIntervalOverride,
  clampWatchCycleIntervalMs,
  getWatchCycleIntervalMs,
  loadWatchCycleIntervalFromConfig,
  resetWatchSettingsOverrides,
  saveWatchCycleIntervalToConfig,
} from '../watchSettings';

describe('watchSettings', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-watch-settings-'));
    configPath = path.join(tmpDir, 'config.json');
    resetWatchSettingsOverrides();
  });

  afterEach(() => {
    resetWatchSettingsOverrides();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to 60s when config is missing', () => {
    expect(loadWatchCycleIntervalFromConfig(configPath)).toBe(60_000);
  });

  it('reads and saves interval in config.json', () => {
    saveWatchCycleIntervalToConfig(45_000, configPath);
    expect(loadWatchCycleIntervalFromConfig(configPath)).toBe(45_000);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.watch.cycleIntervalMs).toBe(45_000);
    expect(config.streamers).toBeUndefined();
  });

  it('clamps interval to 15s..600s', () => {
    expect(clampWatchCycleIntervalMs(1)).toBe(15_000);
    expect(clampWatchCycleIntervalMs(999_999)).toBe(600_000);
  });

  it('runtime override takes precedence until reset', () => {
    saveWatchCycleIntervalToConfig(120_000, configPath);
    applyWatchCycleIntervalOverride(30_000);
    expect(getWatchCycleIntervalMs()).toBe(30_000);
    resetWatchSettingsOverrides();
    expect(loadWatchCycleIntervalFromConfig(configPath)).toBe(120_000);
  });
});
