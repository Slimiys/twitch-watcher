/**
 * PID-файл для перезапуска приложения (Termux / dashboard update)
 */

import * as fs from 'fs';
import * as path from 'path';

const PID_FILE_NAME = '.twitch-watcher.pid';

/**
 * Корень проекта (рядом с package.json)
 */
export function getProjectRoot(): string {
  return path.join(__dirname, '..');
}

/**
 * Путь к PID-файлу
 */
export function getPidFilePath(): string {
  return path.join(getProjectRoot(), PID_FILE_NAME);
}

/**
 * Записывает PID текущего процесса
 */
export function writePidFile(pid = process.pid): void {
  fs.writeFileSync(getPidFilePath(), String(pid), 'utf8');
}

/**
 * Удаляет PID-файл при завершении
 */
export function removePidFile(): void {
  try {
    const filePath = getPidFilePath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // не критично
  }
}
