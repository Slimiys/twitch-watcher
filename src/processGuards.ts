/**
 * Перехват фатальных ошибок и неожиданных завершений процесса
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './modes/api/logger';

/** Разделитель записей в crash.log */
const CRASH_REPORT_SEPARATOR = '\n========== CRASH REPORT ==========\n';

/**
 * Путь к файлу crash-логов (не ротируется ping-pong, чтобы не потерять след)
 */
function resolveCrashLogPath(): string {
  if (process.env.CRASH_LOG_PATH?.trim()) {
    return process.env.CRASH_LOG_PATH.trim();
  }
  const logDir = process.env.LOG_DIR?.trim() || 'logs';
  return path.join(logDir, 'crash.log');
}

/**
 * Нормализует unknown-ошибку в сообщение и stack
 */
function normalizeError(error: unknown): { name: string; message: string; stack?: string; code?: string } {
  if (error instanceof Error) {
    const err = error as Error & { code?: string };
    return {
      name: err.name || 'Error',
      message: err.message || String(error),
      stack: err.stack,
      code: typeof err.code === 'string' ? err.code : undefined,
    };
  }

  return {
    name: 'NonError',
    message: String(error),
  };
}

/**
 * Собирает контекст процесса для диагностики
 */
function collectProcessContext(): Record<string, unknown> {
  const memory = process.memoryUsage();
  const watcher = (global as { watcher?: { isWatcherRunning?: () => boolean } }).watcher;

  return {
    pid: process.pid,
    ppid: process.ppid,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cwd: process.cwd(),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    rssMb: Math.round(memory.rss / 1024 / 1024),
    watcherActive: watcher?.isWatcherRunning?.() ?? null,
  };
}

/**
 * Синхронно пишет отчёт о сбое в crash.log (не зависит от ping-pong ротации)
 * @param eventType Тип события (unhandledRejection, fatalExit и т.д.)
 * @param payload Дополнительные данные
 */
export function writeCrashReport(eventType: string, payload: Record<string, unknown> = {}): void {
  const crashLogPath = resolveCrashLogPath();

  try {
    fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
  } catch {
    // каталог мог уже существовать
  }

  const report = {
    timestamp: new Date().toISOString(),
    eventType,
    ...collectProcessContext(),
    ...payload,
  };

  const lines = [
    CRASH_REPORT_SEPARATOR.trim(),
    JSON.stringify(report, null, 2),
    '',
  ];

  if (typeof payload.stack === 'string' && payload.stack.length > 0) {
    lines.push('--- stack ---', payload.stack, '');
  }

  try {
    fs.appendFileSync(crashLogPath, `${lines.join('\n')}\n`, 'utf8');
  } catch (fileError: unknown) {
    const message = fileError instanceof Error ? fileError.message : String(fileError);
    console.error(`⚠️  Failed to write crash log (${crashLogPath}): ${message}`);
  }

  console.error(`💥  [CRASH] ${eventType} — details saved to ${crashLogPath}`);
}

/**
 * Логирует намеренный аварийный выход перед process.exit
 * @param source Источник (модуль/сценарий)
 * @param message Описание причины
 * @param error Связанная ошибка
 */
export function logFatalExit(source: string, message: string, error?: unknown): void {
  const normalized = error !== undefined ? normalizeError(error) : undefined;

  writeCrashReport('fatalExit', {
    source,
    message,
    errorName: normalized?.name,
    errorMessage: normalized?.message,
    errorCode: normalized?.code,
    stack: normalized?.stack,
  });

  logger.error(`🛑  Fatal exit (${source}): ${message}`);
  if (normalized?.stack) {
    logger.error(normalized.stack);
  }
}

/**
 * Регистрирует глобальные обработчики необработанных ошибок и завершения процесса
 */
export function registerProcessGuards(): void {
  const crashLogPath = resolveCrashLogPath();
  logger.info(`🛡️  Crash logging enabled: ${crashLogPath}`);

  process.on('unhandledRejection', (reason: unknown) => {
    const normalized = normalizeError(reason);

    writeCrashReport('unhandledRejection', {
      errorName: normalized.name,
      errorMessage: normalized.message,
      errorCode: normalized.code,
      stack: normalized.stack,
    });

    logger.error(`❌  Unhandled promise rejection (process continues): ${normalized.message}`);
    if (normalized.stack) {
      logger.error(normalized.stack);
    }
  });

  process.on('uncaughtException', (error: Error, origin?: string) => {
    const normalized = normalizeError(error);

    writeCrashReport('uncaughtException', {
      origin: origin ?? 'unknown',
      errorName: normalized.name,
      errorMessage: normalized.message,
      errorCode: normalized.code,
      stack: normalized.stack,
    });

    logger.error(`❌  Uncaught exception (process continues): ${normalized.message}`);
    if (normalized.stack) {
      logger.error(normalized.stack);
    }
  });

  process.on('uncaughtExceptionMonitor', (error: Error, origin?: string) => {
    const normalized = normalizeError(error);
    writeCrashReport('uncaughtExceptionMonitor', {
      origin: origin ?? 'unknown',
      errorName: normalized.name,
      errorMessage: normalized.message,
      stack: normalized.stack,
    });
  });

  process.on('warning', (warning: Error) => {
    writeCrashReport('processWarning', {
      warningName: warning.name,
      warningMessage: warning.message,
      stack: warning.stack,
    });
    logger.warn(`⚠️  Process warning: ${warning.name}: ${warning.message}`);
  });

  process.on('multipleResolves', (type: string, reason: unknown) => {
    const normalized = normalizeError(reason);
    writeCrashReport('multipleResolves', {
      resolveType: type,
      errorName: normalized.name,
      errorMessage: normalized.message,
      stack: normalized.stack,
    });
    logger.error(`❌  Promise resolved/rejected multiple times (${type}): ${normalized.message}`);
  });

  process.on('rejectionHandled', (reason: unknown) => {
    const normalized = normalizeError(reason);
    logger.verbose(`ℹ️  Previously unhandled rejection was handled: ${normalized.message}`);
  });

  process.on('beforeExit', (code: number) => {
    writeCrashReport('beforeExit', { exitCode: code });
    logger.verbose(`ℹ️  Process beforeExit (code: ${code})`);
  });

  process.on('exit', (code: number) => {
    if (code === 0) {
      return;
    }

    try {
      writeCrashReport('processExit', { exitCode: code });
    } catch {
      // exit handler — только sync, без throw
    }
  });
}
