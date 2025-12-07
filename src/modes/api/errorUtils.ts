/**
 * Утилиты для определения типа ошибок (временные/постоянные)
 */

/**
 * Определяет, является ли HTTP статус код временной ошибкой
 * @param statusCode HTTP статус код
 * @returns true если ошибка временная (стоит повторить)
 */
export function isTemporaryHttpError(statusCode: number): boolean {
  // Временные ошибки: 500, 502, 503, 504 (серверные ошибки), 429 (rate limit)
  return statusCode === 500 || 
         statusCode === 502 || 
         statusCode === 503 || 
         statusCode === 504 || 
         statusCode === 429;
}

/**
 * Определяет, является ли HTTP статус код постоянной ошибкой
 * @param statusCode HTTP статус код
 * @returns true если ошибка постоянная (не стоит повторять)
 */
export function isPermanentHttpError(statusCode: number): boolean {
  // Постоянные ошибки: 400, 401, 403, 404
  return statusCode === 400 || 
         statusCode === 401 || 
         statusCode === 403 || 
         statusCode === 404;
}

/**
 * Определяет, является ли сетевая ошибка временной
 * @param error Объект ошибки
 * @returns true если ошибка временная
 */
export function isTemporaryNetworkError(error: any): boolean {
  if (!error) {
    return false;
  }

  const errorCode = error.code || error.errno;
  const errorMessage = error.message || '';

  // Временные сетевые ошибки
  const temporaryCodes = [
    'ECONNRESET',    // Соединение сброшено
    'ETIMEDOUT',     // Таймаут
    'ENOTFOUND',     // DNS не найден (может быть временным)
    'ECONNREFUSED',  // Соединение отклонено (может быть временным при перезапуске сервера)
    'EAI_AGAIN',     // Временная ошибка DNS
    'EPIPE',         // Разрыв канала
  ];

  // Проверяем код ошибки
  if (errorCode && temporaryCodes.includes(errorCode)) {
    return true;
  }

  // Проверяем сообщение об ошибке
  const temporaryMessages = [
    'timeout',
    'timed out',
    'connection reset',
    'network error',
    'socket hang up',
    'econnreset',
    'etimedout',
  ];

  const lowerMessage = errorMessage.toLowerCase();
  for (const msg of temporaryMessages) {
    if (lowerMessage.includes(msg)) {
      return true;
    }
  }

  return false;
}

/**
 * Определяет, является ли GraphQL ошибка временной
 * @param errorMessage Сообщение об ошибке GraphQL
 * @returns true если ошибка временная
 */
export function isTemporaryGraphQLError(errorMessage: string): boolean {
  if (!errorMessage) {
    return false;
  }

  const lowerMessage = errorMessage.toLowerCase();
  
  // Временные ошибки GraphQL
  const temporaryPatterns = [
    'service timeout',
    'timeout',
    'internal server error',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
    'too many requests',
    'rate limit',
  ];

  for (const pattern of temporaryPatterns) {
    if (lowerMessage.includes(pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Определяет, является ли ошибка специальной (не требует retry)
 * @param errorMessage Сообщение об ошибке
 * @returns true если ошибка специальная (не стоит повторять)
 */
export function isSpecialError(errorMessage: string): boolean {
  if (!errorMessage) {
    return false;
  }

  const lowerMessage = errorMessage.toLowerCase();
  
  // Специальные ошибки, которые не требуют retry
  const specialPatterns = [
    'failed integrity check',  // Бонус уже собран
    'invalid token',          // Неверный токен
    'unauthorized',           // Не авторизован
    'forbidden',              // Нет доступа
    'not found',              // Ресурс не найден
  ];

  for (const pattern of specialPatterns) {
    if (lowerMessage.includes(pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Определяет, стоит ли повторять запрос при данной ошибке
 * @param error Объект ошибки
 * @param statusCode HTTP статус код (если есть)
 * @returns true если стоит повторить запрос
 */
export function shouldRetry(error: any, statusCode?: number): boolean {
  // Если есть специальная ошибка, не повторяем
  if (error?.message && isSpecialError(error.message)) {
    return false;
  }

  // Если есть HTTP статус код
  if (statusCode !== undefined) {
    // Постоянные ошибки не повторяем
    if (isPermanentHttpError(statusCode)) {
      return false;
    }
    // Временные ошибки повторяем
    if (isTemporaryHttpError(statusCode)) {
      return true;
    }
  }

  // Проверяем сетевые ошибки
  if (isTemporaryNetworkError(error)) {
    return true;
  }

  // Проверяем GraphQL ошибки
  if (error?.message && isTemporaryGraphQLError(error.message)) {
    return true;
  }

  // По умолчанию не повторяем (безопаснее)
  return false;
}

