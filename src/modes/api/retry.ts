/**
 * Утилита для retry с экспоненциальной задержкой
 */

import { shouldRetry } from './errorUtils';
import { logger } from './logger';

/**
 * Конфигурация retry
 */
export interface RetryConfig {
  maxAttempts: number;        // Максимальное количество попыток
  initialDelayMs: number;     // Начальная задержка в миллисекундах
  maxDelayMs: number;         // Максимальная задержка в миллисекундах
  multiplier: number;         // Множитель для экспоненциальной задержки
  jitter?: boolean;           // Добавлять ли случайную задержку (jitter)
}

/**
 * Параметры по умолчанию для retry
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  multiplier: 2,
  jitter: true,
};

/**
 * Вычисляет задержку для попытки с экспоненциальным backoff
 * @param attemptNumber Номер попытки (начиная с 1)
 * @param config Конфигурация retry
 * @returns Задержка в миллисекундах
 */
function calculateDelay(attemptNumber: number, config: RetryConfig): number {
  // Экспоненциальная задержка: initialDelay * (multiplier ^ (attemptNumber - 1))
  const exponentialDelay = config.initialDelayMs * Math.pow(config.multiplier, attemptNumber - 1);
  
  // Ограничиваем максимальной задержкой
  let delay = Math.min(exponentialDelay, config.maxDelayMs);
  
  // Добавляем jitter (случайную задержку до 20% от основной задержки)
  if (config.jitter) {
    const jitterAmount = delay * 0.2 * Math.random();
    delay = delay + jitterAmount;
  }
  
  return Math.floor(delay);
}

/**
 * Выполняет функцию с retry и экспоненциальной задержкой
 * @param fn Функция для выполнения
 * @param config Конфигурация retry
 * @param context Контекст для логирования (имя операции)
 * @returns Результат выполнения функции
 */
export async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  context: string = 'operation'
): Promise<T> {
  const finalConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: any = null;
  let lastStatusCode: number | undefined = undefined;

  for (let attempt = 1; attempt <= finalConfig.maxAttempts; attempt++) {
    try {
      const result = await fn();
      
      // Если это не первая попытка, логируем успешный retry
      if (attempt > 1) {
        logger.info(`✅  [${context}] Успешно после ${attempt} попытки`);
      }
      
      return result;
    } catch (error: any) {
      lastError = error;
      
      // Извлекаем статус код из ошибки, если есть
      if (error?.response?.status) {
        lastStatusCode = error.response.status;
      } else if (error?.status) {
        lastStatusCode = error.status;
      } else if (error?.statusCode) {
        lastStatusCode = error.statusCode;
      }
      
      // Проверяем, стоит ли повторять
      if (!shouldRetry(error, lastStatusCode)) {
        logger.verbose(`⚠️  [${context}] Ошибка не требует retry: ${error.message || error}`);
        throw error;
      }
      
      // Если это последняя попытка, выбрасываем ошибку
      if (attempt === finalConfig.maxAttempts) {
        logger.error(`❌  [${context}] Все ${finalConfig.maxAttempts} попыток исчерпаны. Последняя ошибка: ${error.message || error}`);
        throw error;
      }
      
      // Вычисляем задержку для следующей попытки
      const delay = calculateDelay(attempt, finalConfig);
      
      logger.warn(`⚠️  [${context}] Попытка ${attempt}/${finalConfig.maxAttempts} не удалась: ${error.message || error}. Повтор через ${Math.floor(delay)}ms`);
      
      // Ждем перед следующей попыткой
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // Этот код не должен выполниться, но TypeScript требует возврат
  throw lastError || new Error('Retry failed');
}

/**
 * Обертка для fetch с retry
 * @param url URL для запроса
 * @param options Опции fetch
 * @param config Конфигурация retry
 * @param context Контекст для логирования
 * @returns Response объект
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  config: Partial<RetryConfig> = {},
  context: string = 'fetch'
): Promise<Response> {
  return retryWithExponentialBackoff(
    async () => {
      const response = await fetch(url, options);
      
      // Если статус код указывает на ошибку, выбрасываем исключение
      if (!response.ok) {
        const error: any = new Error(`HTTP ${response.status}: ${response.statusText}`);
        error.status = response.status;
        error.statusCode = response.status;
        error.response = response;
        throw error;
      }
      
      return response;
    },
    config,
    context
  );
}

