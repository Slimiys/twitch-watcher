/**
 * Определение среды выполнения и политики авто-завершения процесса
 */

import * as fs from 'fs';

/**
 * Коды ошибок, связанных с временными сетевыми/DNS сбоями
 */
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/**
 * Проверяет, запущено ли приложение внутри Docker-контейнера
 */
export function isDockerEnvironment(): boolean {
  if (process.env.DOCKER === 'true' || process.env.RUNNING_IN_DOCKER === 'true') {
    return true;
  }
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

/**
 * Является ли код ошибки временным сетевым/DNS сбоем
 */
export function isTransientNetworkErrorCode(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  return TRANSIENT_NETWORK_ERROR_CODES.has(code);
}

/**
 * Нужно ли завершать процесс при длительном unhealthy health-check
 * По умолчанию: true только в Docker (restart policy), иначе false (Termux, локальный запуск)
 */
export function shouldAutoExitOnUnhealthy(): boolean {
  const env = process.env.AUTO_EXIT_ON_UNHEALTHY;
  if (env === 'true') {
    return true;
  }
  if (env === 'false') {
    return false;
  }
  return isDockerEnvironment();
}

/**
 * Нужно ли завершать процесс при невалидном токене
 * По умолчанию: true только в Docker
 */
export function shouldAutoExitOnInvalidToken(): boolean {
  const env = process.env.AUTO_EXIT_ON_INVALID_TOKEN;
  if (env === 'true') {
    return true;
  }
  if (env === 'false') {
    return false;
  }
  return isDockerEnvironment();
}
