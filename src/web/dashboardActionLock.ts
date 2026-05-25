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
 * Жив ли процесс с указанным PID (Linux/Android)
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Метаданные lock-файла: PID bash-скрипта и время создания (секунды)
 */
function readDashboardActionLockMeta(): { pid: number; startedAtMs: number } | null {
  try {
    const raw = fs.readFileSync(getDashboardActionLockPath(), 'utf8').trim();
    const [pidStr, tsStr] = raw.split(/\s+/);
    const pid = Number.parseInt(pidStr, 10);
    const ts = Number.parseInt(tsStr, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ts)) {
      return null;
    }
    return { pid, startedAtMs: ts < 1e12 ? ts * 1000 : ts };
  } catch {
    return null;
  }
}

/** Считаем lock устаревшим, если скрипт завершился и файл старше 90 с */
const STALE_LOCK_AFTER_SCRIPT_DEAD_MS = 90_000;

/**
 * Выполняется ли сейчас bash-скрипт управления (по lock-файлу)
 */
export function isDashboardActionLockPresent(): boolean {
  try {
    const lockPath = getDashboardActionLockPath();
    if (!fs.existsSync(lockPath)) {
      return false;
    }
    const meta = readDashboardActionLockMeta();
    if (!meta) {
      return true;
    }
    if (!isProcessAlive(meta.pid)) {
      const age = Date.now() - meta.startedAtMs;
      if (age >= STALE_LOCK_AFTER_SCRIPT_DEAD_MS) {
        removeDashboardActionLock();
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
