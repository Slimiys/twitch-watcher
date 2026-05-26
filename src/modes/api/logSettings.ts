/**
 * Флаги логирования из config / process.env (значения по умолчанию)
 */

/** Boolean-настройки: включены, если ключ отсутствует или не равен false/0 */
export const APP_BOOLEAN_DEFAULT_TRUE = new Set([
  'LOG_TO_FILE',
  'LOG_CLEAR_ON_START',
  'TWITCH_INTEGRITY_AUTO_REFRESH',
  'TWITCH_INTEGRITY_AUTO_PERSIST',
]);

/**
 * Проверяет, включён ли boolean-параметр с учётом значения по умолчанию
 */
export function isAppBooleanEnabled(key: string, value: string | undefined): boolean {
  if (value === undefined || value === '') {
    return APP_BOOLEAN_DEFAULT_TRUE.has(key);
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  return value === 'true' || value === '1';
}

/**
 * Запись логов в файлы включена
 */
export function isFileLoggingEnabled(): boolean {
  return isAppBooleanEnabled('LOG_TO_FILE', process.env.LOG_TO_FILE);
}
