/**
 * Обновление приложения с dashboard (git pull + run-local.sh + перезапуск)
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot, getPidFilePath } from '../pidFile';
import { getDashboardApiKey } from './apiAuth';
import { logger } from '../modes/api/logger';

let updateInProgress = false;

/**
 * Включено ли обновление через API (явно DASHBOARD_UPDATE_ENABLED=true)
 */
export function isDashboardUpdateEnabled(): boolean {
  return process.env.DASHBOARD_UPDATE_ENABLED === 'true';
}

/**
 * Проверка перед запуском обновления
 */
export function validateDashboardUpdateRequest(): { ok: true } | { ok: false; error: string } {
  if (!isDashboardUpdateEnabled()) {
    return {
      ok: false,
      error: 'Обновление через dashboard отключено. Установите DASHBOARD_UPDATE_ENABLED=true в .env',
    };
  }
  if (updateInProgress) {
    return { ok: false, error: 'Обновление уже выполняется' };
  }
  if (process.platform === 'win32') {
    return {
      ok: false,
      error: 'Обновление через dashboard поддерживается только на Linux/Android (bash)',
    };
  }

  const scriptPath = resolveUpdateScriptPath();
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `Скрипт не найден: ${scriptPath}` };
  }

  return { ok: true };
}

/**
 * Путь к scripts/dashboard-update.sh
 */
export function resolveUpdateScriptPath(): string {
  return path.join(getProjectRoot(), 'scripts', 'dashboard-update.sh');
}

/**
 * Запускает git pull + run-local.sh --update-only и перезапуск в фоне
 */
export function triggerDashboardUpdate(): { started: boolean; message: string } {
  const check = validateDashboardUpdateRequest();
  if (!check.ok) {
    return { started: false, message: check.error };
  }

  const projectRoot = getProjectRoot();
  const scriptPath = resolveUpdateScriptPath();
  const branch = process.env.DASHBOARD_UPDATE_GIT_BRANCH?.trim() || 'dev';
  updateInProgress = true;

  try {
    fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });
  } catch {
    // каталог logs может уже существовать
  }

  const child = spawn('bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
    cwd: projectRoot,
    env: {
      ...process.env,
      TWITCH_WATCHER_PID: String(process.pid),
      TWITCH_WATCHER_PID_FILE: getPidFilePath(),
      DASHBOARD_UPDATE_GIT_BRANCH: branch,
    },
  });

  child.unref();

  child.on('error', (err) => {
    updateInProgress = false;
    logger.error('Dashboard update spawn failed:', err.message);
  });

  // Сброс флага через таймаут на случай, если процесс не перезапустился
  setTimeout(() => {
    updateInProgress = false;
  }, 10 * 60 * 1000);

  logger.warn(
    `🔄  Dashboard update started (branch ${branch}, pid ${process.pid}). Log: logs/dashboard-update.log`
  );

  return {
    started: true,
    message:
      'Обновление запущено: git pull → run-local.sh --update-only → перезапуск. Лог: logs/dashboard-update.log',
  };
}

/**
 * Идёт ли сейчас обновление
 */
export function isDashboardUpdateInProgress(): boolean {
  return updateInProgress;
}
