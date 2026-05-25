/**
 * Обновление приложения с dashboard (git pull + run-local.sh + перезапуск)
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot, getPidFilePath } from '../pidFile';
import { logger } from '../modes/api/logger';
import {
  isDashboardActionLockPresent,
  writeDashboardActionLock,
} from './dashboardActionLock';

let dashboardActionInProgress = false;

/**
 * Включено ли обновление через API (явно DASHBOARD_UPDATE_ENABLED=true)
 */
export function isDashboardUpdateEnabled(): boolean {
  return process.env.DASHBOARD_UPDATE_ENABLED === 'true';
}

/**
 * Проверка перед удалённым действием (обновление / stop / restart)
 */
export function validateDashboardControlRequest(scriptPath: string): { ok: true } | { ok: false; error: string } {
  if (!isDashboardUpdateEnabled()) {
    return {
      ok: false,
      error: 'Управление через dashboard отключено. Установите DASHBOARD_UPDATE_ENABLED=true в .env',
    };
  }
  if (dashboardActionInProgress) {
    return { ok: false, error: 'Другое действие уже выполняется' };
  }
  if (process.platform === 'win32') {
    return {
      ok: false,
      error: 'Управление процессом поддерживается только на Linux/Android (bash)',
    };
  }
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `Скрипт не найден: ${scriptPath}` };
  }

  return { ok: true };
}

/**
 * Проверка перед запуском обновления
 */
export function validateDashboardUpdateRequest(): { ok: true } | { ok: false; error: string } {
  return validateDashboardControlRequest(resolveUpdateScriptPath());
}

/**
 * Путь к scripts/dashboard-update.sh
 */
export function resolveUpdateScriptPath(): string {
  return path.join(getProjectRoot(), 'scripts', 'dashboard-update.sh');
}

/**
 * Путь к scripts/dashboard-stop.sh
 */
export function resolveStopScriptPath(): string {
  return path.join(getProjectRoot(), 'scripts', 'dashboard-stop.sh');
}

/**
 * Путь к scripts/dashboard-restart.sh
 */
export function resolveRestartScriptPath(): string {
  return path.join(getProjectRoot(), 'scripts', 'dashboard-restart.sh');
}

function spawnDashboardScript(scriptPath: string, logLabel: string): void {
  const projectRoot = getProjectRoot();
  dashboardActionInProgress = true;
  writeDashboardActionLock();

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
    },
  });

  child.unref();

  child.on('error', (err) => {
    dashboardActionInProgress = false;
    logger.error(`Dashboard ${logLabel} spawn failed:`, err.message);
  });

  child.on('exit', () => {
    dashboardActionInProgress = false;
  });

  setTimeout(() => {
    dashboardActionInProgress = false;
  }, 10 * 60 * 1000);

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

  try {
    fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });
  } catch {
    // каталог logs может уже существовать
  }

  dashboardActionInProgress = true;
  writeDashboardActionLock();

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
    dashboardActionInProgress = false;
    logger.error('Dashboard update spawn failed:', err.message);
  });

  child.on('exit', () => {
    dashboardActionInProgress = false;
  });

  setTimeout(() => {
    dashboardActionInProgress = false;
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
 * Останавливает текущий процесс бота
 */
export function triggerDashboardStop(): { started: boolean; message: string } {
  const scriptPath = resolveStopScriptPath();
  const check = validateDashboardControlRequest(scriptPath);
  if (!check.ok) {
    return { started: false, message: check.error };
  }

  spawnDashboardScript(scriptPath, 'stop');
  logger.warn(`⏹  Dashboard stop scheduled (pid ${process.pid}). Log: logs/dashboard-stop.log`);

  return {
    started: true,
    message: 'Остановка запущена. Бот завершится через несколько секунд. Лог: logs/dashboard-stop.log',
  };
}

/**
 * Перезапускает бота (stop + npm start), как после обновления
 */
export function triggerDashboardRestart(): { started: boolean; message: string } {
  const scriptPath = resolveRestartScriptPath();
  const check = validateDashboardControlRequest(scriptPath);
  if (!check.ok) {
    return { started: false, message: check.error };
  }

  spawnDashboardScript(scriptPath, 'restart');
  logger.warn(`🔁  Dashboard restart scheduled (pid ${process.pid}). Log: logs/update-restart.log`);

  return {
    started: true,
    message: 'Перезапуск запущен. Лог: logs/update-restart.log',
  };
}

/**
 * Идёт ли сейчас удалённое действие (обновление / stop / restart)
 */
export function isDashboardUpdateInProgress(): boolean {
  if (isDashboardActionLockPresent()) {
    return true;
  }
  if (dashboardActionInProgress) {
    dashboardActionInProgress = false;
  }
  return false;
}
