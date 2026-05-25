/**
 * Очистка каталога логов при старте приложения
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Возвращает абсолютный путь к каталогу логов (LOG_DIR или ./logs)
 */
export function resolveLogDirectory(): string {
  const dir = process.env.LOG_DIR?.trim() || './logs';
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
}

/**
 * Включена ли очистка логов при старте (LOG_CLEAR_ON_START, по умолчанию да)
 */
export function isLogClearOnStartEnabled(): boolean {
  return process.env.LOG_CLEAR_ON_START !== 'false' && process.env.LOG_CLEAR_ON_START !== '0';
}

/**
 * Удаляет все файлы в каталоге логов (подкаталоги не трогает)
 * @param logDir Каталог логов; по умолчанию resolveLogDirectory()
 * @returns Число удалённых файлов
 */
export function clearLogDirectoryOnStartup(logDir?: string): number {
  if (!isLogClearOnStartEnabled()) {
    return 0;
  }

  const targetDir = logDir ?? resolveLogDirectory();
  let removed = 0;

  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch {
    return 0;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(targetDir, entry.name);
    try {
      fs.unlinkSync(filePath);
      removed += 1;
    } catch {
      try {
        fs.truncateSync(filePath, 0);
        removed += 1;
      } catch {
        // пропускаем файл, который не удалось очистить
      }
    }
  }

  return removed;
}
