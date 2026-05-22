import * as util from 'util';
import { createPingPongFileLoggerFromEnv, PingPongFileLogger } from './PingPongFileLogger';

/**
 * Уровни логирования
 */
export enum LogLevel {
  VERBOSE = 'verbose',  // Все логи (по умолчанию)
  NORMAL = 'normal',    // Только важные сообщения
  MINIMAL = 'minimal'   // Только критичные сообщения
}

/**
 * Менеджер логирования (консоль + опционально два файла с ротацией по размеру)
 */
class Logger {
  private level: LogLevel;
  private readonly fileLogger: PingPongFileLogger | null;

  constructor() {
    const envLevel = (process.env.LOG_LEVEL || 'verbose').toLowerCase();
    this.level = Object.values(LogLevel).includes(envLevel as LogLevel)
      ? (envLevel as LogLevel)
      : LogLevel.VERBOSE;

    this.fileLogger = createPingPongFileLoggerFromEnv();
    if (this.fileLogger) {
      const [p1, p2] = this.fileLogger.getLogPaths();
      console.log(`📝  File logging enabled (max ${process.env.LOG_FILE_MAX_MB || '100'} MB per file, ping-pong):`);
      console.log(`    ${p1}`);
      console.log(`    ${p2}`);
    }
  }

  /**
   * Логирует сообщение только в verbose режиме
   */
  verbose(message: string, ...args: any[]): void {
    if (this.level === LogLevel.VERBOSE) {
      this.write('VERBOSE', message, args, (m, a) => console.log(m, ...a));
    }
  }

  /**
   * Логирует важное сообщение (в normal и verbose режимах)
   */
  info(message: string, ...args: any[]): void {
    if (this.level !== LogLevel.MINIMAL) {
      this.write('INFO', message, args, (m, a) => console.log(m, ...a));
    }
  }

  /**
   * Логирует критичное сообщение (всегда)
   */
  important(message: string, ...args: any[]): void {
    this.write('IMPORTANT', message, args, (m, a) => console.log(m, ...a));
  }

  /**
   * Логирует предупреждение (в normal и verbose режимах)
   */
  warn(message: string, ...args: any[]): void {
    if (this.level !== LogLevel.MINIMAL) {
      this.write('WARN', message, args, (m, a) => console.warn(m, ...a));
    }
  }

  /**
   * Логирует ошибку (в normal и verbose режимах)
   */
  error(message: string, ...args: any[]): void {
    if (this.level !== LogLevel.MINIMAL) {
      this.write('ERROR', message, args, (m, a) => console.error(m, ...a));
    }
  }

  /**
   * Получает текущий уровень логирования
   */
  getLevel(): LogLevel {
    return this.level;
  }

  private write(
    level: string,
    message: string,
    args: any[],
    consoleFn: (message: string, args: any[]) => void
  ): void {
    consoleFn(message, args);
    if (!this.fileLogger) {
      return;
    }
    try {
      const text = args.length > 0 ? util.format(message, ...args) : message;
      const line = `[${new Date().toISOString()}] [${level}] ${text}`;
      this.fileLogger.append(line);
    } catch (err: any) {
      console.error('⚠️  Failed to write log file:', err?.message || err);
    }
  }
}

// Экспортируем единственный экземпляр
export const logger = new Logger();
