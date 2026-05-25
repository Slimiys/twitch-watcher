/**
 * Файловая блокировка действия dashboard (обновление / stop / restart).
 * Переживает завершение Node-процесса, пока bash-скрипт ещё выполняется.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../pidFile';

const LOCK_FILE_NAME = '.dashboard-action.lock';

/**
 * Путь к lock-файлу в logs/
 */
export function getDashboardActionLockPath(): string {
  return path.join(getProjectRoot(), 'logs', LOCK_FILE_NAME);
}

/**
 * Создаёт lock-файл (вызывается при spawn скрипта)
 */
export function writeDashboardActionLock(): void {
  const lockPath = getDashboardActionLockPath();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, 'utf8');
  } catch {
    // не блокируем spawn при ошибке записи
  }
}

/**
 * Удаляет lock-файл (тесты / аварийный сброс)
 */
export function removeDashboardActionLock(): void {
  try {
    fs.unlinkSync(getDashboardActionLockPath());
  } catch {
    // файла может не быть
  }
}

/**
 * Выполняется ли сейчас bash-скрипт управления (по lock-файлу)
 */
export function isDashboardActionLockPresent(): boolean {
  try {
    return fs.existsSync(getDashboardActionLockPath());
  } catch {
    return false;
  }
}
