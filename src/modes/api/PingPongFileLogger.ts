import * as fs from 'fs';
import * as path from 'path';

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

/**
 * Создаёт файловый логгер из переменных окружения или null, если выключено.
 */
export function createPingPongFileLoggerFromEnv(): PingPongFileLogger | null {
  const enabled = process.env.LOG_TO_FILE !== 'false' && process.env.LOG_TO_FILE !== '0';
  if (!enabled) {
    return null;
  }

  const logDir = process.env.LOG_DIR || './logs';
  const baseName = process.env.LOG_FILE_BASENAME || 'twitch-watcher';
  const maxMb = parseInt(process.env.LOG_FILE_MAX_MB || '100', 10);
  const maxBytes = (Number.isFinite(maxMb) && maxMb > 0 ? maxMb : 100) * 1024 * 1024;

  const logger = new PingPongFileLogger(logDir, baseName, maxBytes);
  const clearOnStart = process.env.LOG_CLEAR_ON_START !== 'false'
    && process.env.LOG_CLEAR_ON_START !== '0';
  if (clearOnStart) {
    logger.clearOnStartup();
  }
  return logger;
}
