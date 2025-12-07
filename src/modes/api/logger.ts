/**
 * Система логирования с уровнями детализации
 */

/**
 * Уровни логирования
 */
export enum LogLevel {
  VERBOSE = 'verbose',  // Все логи (по умолчанию)
  NORMAL = 'normal',    // Только важные сообщения
  MINIMAL = 'minimal'   // Только критичные сообщения
}

/**
 * Менеджер логирования
 */
class Logger {
  private level: LogLevel;

  constructor() {
    const envLevel = (process.env.LOG_LEVEL || 'verbose').toLowerCase();
    this.level = Object.values(LogLevel).includes(envLevel as LogLevel) 
      ? (envLevel as LogLevel) 
      : LogLevel.VERBOSE;
  }

  /**
   * Логирует сообщение только в verbose режиме
   */
  verbose(message: string, ...args: any[]): void {
    if (this.level === LogLevel.VERBOSE) {
      console.log(message, ...args);
    }
  }

  /**
   * Логирует важное сообщение (в normal и verbose режимах)
   */
  info(message: string, ...args: any[]): void {
    if (this.level !== LogLevel.MINIMAL) {
      console.log(message, ...args);
    }
  }

  /**
   * Логирует критичное сообщение (всегда)
   */
  important(message: string, ...args: any[]): void {
    console.log(message, ...args);
  }

  /**
   * Логирует предупреждение (в normal и verbose режимах)
   */
  warn(message: string, ...args: any[]): void {
    if (this.level !== LogLevel.MINIMAL) {
      console.warn(message, ...args);
    }
  }

  /**
   * Логирует ошибку (в normal и verbose режимах)
   */
  error(message: string, ...args: any[]): void {
    if (this.level !== LogLevel.MINIMAL) {
      console.error(message, ...args);
    }
  }

  /**
   * Получает текущий уровень логирования
   */
  getLevel(): LogLevel {
    return this.level;
  }
}

// Экспортируем единственный экземпляр
export const logger = new Logger();

