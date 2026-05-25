/**
 * API настроек minute-watched для dashboard
 */

import * as path from 'path';
import { getProjectRoot } from '../pidFile';
import { upsertEnvFileKeys } from '../envFile';
import {
  applyWatchSettingsOverrides,
  clampWatchCycleIntervalMs,
  getWatchCycleIntervalMaxMs,
  getWatchCycleIntervalMinMs,
  getWatchSettings,
  parseWatchModeFromEnv,
  WatchMode,
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
 * Снимок настроек с бота или из env
 */
export function readWatchSettingsForApi(
  provider: StatisticsProvider | null
): WatchSettingsApiResponse {
  const base =
    provider && typeof (provider as any).getWatchSettingsSnapshot === 'function'
      ? ((provider as any).getWatchSettingsSnapshot() as WatchSettingsSnapshot)
      : buildEnvOnlySnapshot();

  return {
    ...base,
    minCycleIntervalSec: Math.round(getWatchCycleIntervalMinMs() / 1000),
    maxCycleIntervalSec: Math.round(getWatchCycleIntervalMaxMs() / 1000),
    persisted: true,
  };
}

function buildEnvOnlySnapshot(): WatchSettingsSnapshot {
  const settings = getWatchSettings();
  return {
    ...settings,
    cycleIntervalSec: Math.round(settings.cycleIntervalMs / 1000),
    lastSequentialStreamer: null,
    onlineCount: 0,
  };
}

/**
 * Применяет настройки: runtime + запись в .env
 */
export function applyWatchSettingsFromApi(
  provider: StatisticsProvider | null,
  body: { cycleIntervalSec?: number; mode?: WatchMode }
): WatchSettingsApiResponse {
  const cycleIntervalSec = body.cycleIntervalSec;
  const mode = body.mode;

  if (cycleIntervalSec !== undefined) {
    const sec = Number(cycleIntervalSec);
    if (!Number.isFinite(sec)) {
      throw new Error('cycleIntervalSec must be a number');
    }
    const ms = clampWatchCycleIntervalMs(sec * 1000);
    applyWatchSettingsOverrides({ cycleIntervalMs: ms });
  }

  if (mode !== undefined) {
    if (!['sequential', 'per-channel', 'batch'].includes(mode)) {
      throw new Error('Invalid watch mode');
    }
    applyWatchSettingsOverrides({ mode });
  }

  const settings = getWatchSettings();
  upsertEnvFileKeys(path.join(getProjectRoot(), '.env'), {
    WATCH_MODE: settings.mode,
    WATCH_CYCLE_INTERVAL_MS: String(settings.cycleIntervalMs),
  });

  if (provider && typeof (provider as any).applyWatchSettings === 'function') {
    (provider as any).applyWatchSettings({
      cycleIntervalMs: settings.cycleIntervalMs,
      mode: settings.mode,
    });
  }

  return {
    ...readWatchSettingsForApi(provider),
    message: 'Настройки применены',
  };
}
