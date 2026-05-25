/**
 * Интервал между отправками minute-watched (ротация по очереди)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../../pidFile';
import { AppConfig } from '../../types';

export interface WatchSettingsSnapshot {
  cycleIntervalMs: number;
  cycleIntervalSec: number;
  /** Последний стример в очереди ротации (если есть) */
  lastSequentialStreamer: string | null;
  onlineCount: number;
}

const DEFAULT_CYCLE_MS = 60_000;
const MIN_CYCLE_MS = 15_000;
const MAX_CYCLE_MS = 600_000;

let runtimeCycleIntervalMs: number | undefined;

/**
 * Сбрасывает runtime-переопределение (тесты)
 */
export function resetWatchSettingsOverrides(): void {
  runtimeCycleIntervalMs = undefined;
}

/**
 * Путь к config.json в корне проекта
 */
export function getWatchConfigPath(): string {
  return path.join(getProjectRoot(), 'config.json');
}

/**
 * Ограничивает интервал допустимым диапазоном
 */
export function clampWatchCycleIntervalMs(ms: number): number {
  return Math.min(MAX_CYCLE_MS, Math.max(MIN_CYCLE_MS, Math.round(ms)));
}

/**
 * Читает интервал из config.json
 */
export function loadWatchCycleIntervalFromConfig(configPath: string = getWatchConfigPath()): number {
  if (!fs.existsSync(configPath)) {
    return DEFAULT_CYCLE_MS;
  }
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as AppConfig;
    const raw = config.watch?.cycleIntervalMs;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return DEFAULT_CYCLE_MS;
    }
    return clampWatchCycleIntervalMs(raw);
  } catch {
    return DEFAULT_CYCLE_MS;
  }
}

/**
 * Сохраняет интервал в config.json (остальные поля не трогает)
 */
export function saveWatchCycleIntervalToConfig(
  cycleIntervalMs: number,
  configPath: string = getWatchConfigPath()
): void {
  const ms = clampWatchCycleIntervalMs(cycleIntervalMs);
  let config: AppConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as AppConfig;
    } catch {
      config = {};
    }
  }
  config.watch = { ...config.watch, cycleIntervalMs: ms };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Текущий интервал (config.json + runtime override)
 */
export function getWatchCycleIntervalMs(): number {
  if (runtimeCycleIntervalMs !== undefined) {
    return runtimeCycleIntervalMs;
  }
  return loadWatchCycleIntervalFromConfig();
}

/**
 * Обновляет runtime-интервал (без записи в config)
 */
export function applyWatchCycleIntervalOverride(cycleIntervalMs: number): number {
  runtimeCycleIntervalMs = clampWatchCycleIntervalMs(cycleIntervalMs);
  return runtimeCycleIntervalMs;
}

/**
 * Минимальный интервал (мс)
 */
export function getWatchCycleIntervalMinMs(): number {
  return MIN_CYCLE_MS;
}

/**
 * Максимальный интервал (мс)
 */
export function getWatchCycleIntervalMaxMs(): number {
  return MAX_CYCLE_MS;
}
