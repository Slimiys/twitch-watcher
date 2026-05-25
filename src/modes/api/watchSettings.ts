/**
 * Настройки minute-watched (режим и интервал)
 */

/** Режим отправки minute-watched */
export type WatchMode = 'sequential' | 'per-channel' | 'batch';

export interface WatchSettings {
  mode: WatchMode;
  cycleIntervalMs: number;
}

export interface WatchSettingsSnapshot extends WatchSettings {
  cycleIntervalSec: number;
  /** Последний стример в sequential-очереди (если есть) */
  lastSequentialStreamer: string | null;
  onlineCount: number;
}

const MIN_CYCLE_MS = 15_000;
const MAX_CYCLE_MS = 600_000;

let runtimeOverrides: Partial<WatchSettings> = {};

/**
 * Сбрасывает runtime-переопределения (тесты)
 */
export function resetWatchSettingsOverrides(): void {
  runtimeOverrides = {};
}

/**
 * Парсит WATCH_MODE из env
 */
export function parseWatchModeFromEnv(): WatchMode {
  const raw = (process.env.WATCH_MODE || 'sequential').trim().toLowerCase();
  if (raw === 'batch') {
    return 'batch';
  }
  if (raw === 'per-channel' || raw === 'perchannel') {
    return 'per-channel';
  }
  return 'sequential';
}

/**
 * Парсит интервал между отправками (мс)
 */
export function parseWatchCycleIntervalMsFromEnv(): number {
  const parsed = parseInt(process.env.WATCH_CYCLE_INTERVAL_MS || '60000', 10);
  if (!Number.isFinite(parsed)) {
    return 60_000;
  }
  return clampWatchCycleIntervalMs(parsed);
}

/**
 * Ограничивает интервал допустимым диапазоном
 */
export function clampWatchCycleIntervalMs(ms: number): number {
  return Math.min(MAX_CYCLE_MS, Math.max(MIN_CYCLE_MS, Math.round(ms)));
}

/**
 * Текущие эффективные настройки (env + runtime)
 */
export function getWatchSettings(): WatchSettings {
  const fromEnv: WatchSettings = {
    mode: parseWatchModeFromEnv(),
    cycleIntervalMs: parseWatchCycleIntervalMsFromEnv(),
  };
  return {
    mode: runtimeOverrides.mode ?? fromEnv.mode,
    cycleIntervalMs: runtimeOverrides.cycleIntervalMs ?? fromEnv.cycleIntervalMs,
  };
}

/**
 * Обновляет runtime-настройки (без записи в .env)
 */
export function applyWatchSettingsOverrides(partial: Partial<WatchSettings>): WatchSettings {
  if (partial.mode !== undefined) {
    runtimeOverrides.mode = partial.mode;
  }
  if (partial.cycleIntervalMs !== undefined) {
    runtimeOverrides.cycleIntervalMs = clampWatchCycleIntervalMs(partial.cycleIntervalMs);
  }
  return getWatchSettings();
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
