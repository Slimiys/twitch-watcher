/**
 * API интервала minute-watched для dashboard
 */

import {
  applyWatchCycleIntervalOverride,
  clampWatchCycleIntervalMs,
  getWatchCycleIntervalMaxMs,
  getWatchCycleIntervalMinMs,
  getWatchCycleIntervalMs,
  saveWatchCycleIntervalToConfig,
  WatchSettingsSnapshot,
} from '../modes/api/watchSettings';
import type { StatisticsProvider } from './WebServer';

export interface WatchSettingsApiResponse extends WatchSettingsSnapshot {
  minCycleIntervalSec: number;
  maxCycleIntervalSec: number;
  persisted: boolean;
  message?: string;
}

/**
 * Снимок настроек с бота или из config.json
 */
export function readWatchSettingsForApi(
  provider: StatisticsProvider | null
): WatchSettingsApiResponse {
  const base =
    provider && typeof provider.getWatchSettingsSnapshot === 'function'
      ? provider.getWatchSettingsSnapshot()
      : buildConfigOnlySnapshot();

  return {
    ...base,
    minCycleIntervalSec: Math.round(getWatchCycleIntervalMinMs() / 1000),
    maxCycleIntervalSec: Math.round(getWatchCycleIntervalMaxMs() / 1000),
    persisted: true,
  };
}

function buildConfigOnlySnapshot(): WatchSettingsSnapshot {
  const cycleIntervalMs = getWatchCycleIntervalMs();
  return {
    cycleIntervalMs,
    cycleIntervalSec: Math.round(cycleIntervalMs / 1000),
    lastSequentialStreamer: null,
    onlineCount: 0,
  };
}

/**
 * Применяет интервал: runtime + запись в config.json
 */
export function applyWatchSettingsFromApi(
  provider: StatisticsProvider | null,
  body: { cycleIntervalSec?: number }
): WatchSettingsApiResponse {
  const cycleIntervalSec = body.cycleIntervalSec;

  if (cycleIntervalSec !== undefined) {
    const sec = Number(cycleIntervalSec);
    if (!Number.isFinite(sec)) {
      throw new Error('cycleIntervalSec must be a number');
    }
    const ms = clampWatchCycleIntervalMs(sec * 1000);
    applyWatchCycleIntervalOverride(ms);
    saveWatchCycleIntervalToConfig(ms);
  }

  const cycleIntervalMs = getWatchCycleIntervalMs();

  if (provider && typeof provider.applyWatchSettings === 'function') {
    provider.applyWatchSettings({ cycleIntervalMs });
  }

  return {
    ...readWatchSettingsForApi(provider),
    message: 'Интервал сохранён в config.json',
  };
}
