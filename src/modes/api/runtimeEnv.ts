/**
 * Политика авто-завершения процесса и сетевые коды ошибок
 */

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
 * Является ли код ошибки временным сетевым/DNS сбоем
 */
export function isTransientNetworkErrorCode(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  return TRANSIENT_NETWORK_ERROR_CODES.has(code);
}

/**
 * Завершать процесс при длительном unhealthy health-check (только при AUTO_EXIT_ON_UNHEALTHY=true)
 */
export function shouldAutoExitOnUnhealthy(): boolean {
  return process.env.AUTO_EXIT_ON_UNHEALTHY === 'true';
}

/**
 * Завершать процесс при невалидном токене (только при AUTO_EXIT_ON_INVALID_TOKEN=true)
 */
export function shouldAutoExitOnInvalidToken(): boolean {
  return process.env.AUTO_EXIT_ON_INVALID_TOKEN === 'true';
}
