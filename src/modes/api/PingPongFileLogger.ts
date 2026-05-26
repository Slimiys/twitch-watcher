import * as fs from 'fs';
import * as path from 'path';
import { clearLogDirectoryOnStartup, resolveLogDirectory } from '../../logDirectory';
import { isFileLoggingEnabled } from './logSettings';

/**
 * Двухфайловый логгер: при заполнении первого файла пишет во второй;
 * когда второй заполнен — очищает первый и снова пишет в первый (цикл).
 */
export class PingPongFileLogger {
  private readonly maxBytes: number;
  private readonly paths: [string, string];
  private activeIndex: 0 | 1 = 0;

  /**
   * @param logDir Каталог для файлов логов
   * @param baseName Базовое имя (файлы: baseName.1.log, baseName.2.log)
   * @param maxBytes Максимальный размер одного файла в байтах
   */
  constructor(logDir: string, baseName: string, maxBytes: number) {
    fs.mkdirSync(logDir, { recursive: true });
    this.maxBytes = maxBytes;
    this.paths = [
      path.join(logDir, `${baseName}.1.log`),
      path.join(logDir, `${baseName}.2.log`),
    ];
  }

  /**
   * Добавляет строку в активный файл с ротацией при превышении лимита.
   */
  append(line: string): void {
    const targetPath = this.resolveWritablePath();
    fs.appendFileSync(targetPath, `${line}\n`, 'utf8');
  }

  /**
   * Возвращает пути к файлам логов (для диагностики).
   */
  getLogPaths(): [string, string] {
    return [...this.paths];
  }

  /**
   * Удаляет оба файла логов (вызывается при старте приложения).
   */
  clearOnStartup(): void {
    for (const filePath of this.paths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        try {
          fs.truncateSync(filePath, 0);
        } catch {
          // игнорируем — запись начнётся с нового файла
        }
      }
    }
    this.activeIndex = 0;
  }

  /**
   * Выбирает файл для записи: переключение или очистка по правилу ping-pong.
   */
  private resolveWritablePath(): string {
    let currentPath = this.paths[this.activeIndex];
    if (this.getFileSize(currentPath) >= this.maxBytes) {
      this.activeIndex = this.activeIndex === 0 ? 1 : 0;
      currentPath = this.paths[this.activeIndex];
      if (this.getFileSize(currentPath) >= this.maxBytes) {
        fs.truncateSync(currentPath, 0);
      }
    }
    return currentPath;
  }

  private getFileSize(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }
}

/** Результат инициализации файлового логирования */
export interface PingPongFileLoggerSetup {
  logger: PingPongFileLogger | null;
  /** Сколько файлов удалено из LOG_DIR при старте */
  clearedFiles: number;
  logDir: string;
}

/**
 * Создаёт файловый логгер из переменных окружения или null, если выключено.
 */
export function createPingPongFileLoggerFromEnv(): PingPongFileLoggerSetup {
  const logDir = resolveLogDirectory();
  const clearedFiles = clearLogDirectoryOnStartup(logDir);

  if (!isFileLoggingEnabled()) {
    return { logger: null, clearedFiles, logDir };
  }

  const baseName = process.env.LOG_FILE_BASENAME || 'twitch-watcher';
  const maxMb = parseInt(process.env.LOG_FILE_MAX_MB || '100', 10);
  const maxBytes = (Number.isFinite(maxMb) && maxMb > 0 ? maxMb : 100) * 1024 * 1024;

  const logger = new PingPongFileLogger(logDir, baseName, maxBytes);
  return { logger, clearedFiles, logDir };
}
