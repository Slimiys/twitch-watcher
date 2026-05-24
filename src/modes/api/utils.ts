/**
 * Утилиты для API-режима
 */

import { MinuteWatchedPayload } from './types';
import { logger } from './logger';
import { writeCrashReport } from '../../processGuards';

/**
 * Запускает async-задачу с перехватом ошибок (не роняет процесс)
 */
export function runSafeAsync(label: string, callback: () => void | Promise<void>): void {
  Promise.resolve(callback()).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    writeCrashReport('asyncTaskError', {
      task: label,
      errorMessage: message,
      stack,
    });

    logger.warn(`⚠️  [${label}] ${message}`);
    if (stack) {
      logger.verbose(stack);
    }
  });
}

/**
 * setInterval для async-колбэков с перехватом необработанных ошибок
 */
export function setSafeAsyncInterval(
  label: string,
  callback: () => void | Promise<void>,
  ms: number
): NodeJS.Timeout {
  return setInterval(() => runSafeAsync(label, callback), ms);
}

/**
 * Выполняет async-операцию с таймаутом
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  context: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs}ms [${context}]`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Кодирование payload в Base64 для отправки на Spade URL
 * @param payload Payload для кодирования
 * @returns Закодированный payload в формате { data: "base64_string" }
 */
export function encodePayload(payload: MinuteWatchedPayload[]): { data: string } {
  const jsonEvent = JSON.stringify(payload, null, 0);
  const base64Encoded = Buffer.from(jsonEvent, 'utf-8').toString('base64');
  return { data: base64Encoded };
}

/**
 * Извлечение spade_url из конфигурационного файла Twitch
 * @param configContent Содержимое конфигурационного файла
 * @returns Spade URL или null, если не найден
 */
export function extractSpadeUrl(configContent: string): string | null {
  try {
    // Ищем spade_url в конфигурации
    const regex = /"spade_url":"([^"]+)"/;
    const match = configContent.match(regex);
    return match ? match[1] : null;
  } catch (error) {
    return null;
  }
}

/**
 * Извлечение URL конфигурационного файла из главной страницы
 * @param pageContent Содержимое главной страницы стримера
 * @returns URL конфигурационного файла или null
 */
export function extractSettingsUrl(pageContent: string): string | null {
  try {
    // Пробуем несколько вариантов регулярных выражений
    const patterns = [
      // Стандартный формат: https://static.twitchcdn.net/config/settings-XXXXX.js
      /(https:\/\/static\.twitchcdn\.net\/config\/settings[^"'\s<>]+\.js)/,
      // В кавычках
      /"settingsUrl"\s*:\s*"([^"]+)"/,
      /'settingsUrl'\s*:\s*'([^']+)'/,
      // В атрибутах
      /settings.*?url["']?\s*[:=]\s*["']([^"']+)["']/i,
      // В script тегах
      /<script[^>]*src=["'](https:\/\/static\.twitchcdn\.net\/config\/settings[^"']+\.js)["']/i,
      // В window объектах
      /window\.__.*?settings.*?["'](https:\/\/static\.twitchcdn\.net\/config\/settings[^"']+\.js)["']/i,
    ];

    for (const pattern of patterns) {
      const match = pageContent.match(pattern);
      if (match) {
        const url = match[1] || match[0];
        if (url && url.startsWith('http') && url.includes('settings') && url.endsWith('.js')) {
          return url;
        }
      }
    }

    // Ищем в script тегах напрямую
    const scriptMatches = pageContent.matchAll(/<script[^>]*src=["']([^"']+)["'][^>]*>/gi);
    for (const match of scriptMatches) {
      const url = match[1];
      if (url && url.includes('static.twitchcdn.net') && url.includes('settings') && url.endsWith('.js')) {
        return url;
      }
    }

    // Если не нашли через regex, ищем встроенный JSON
    const jsonMatches = [
      /<script[^>]*>window\.__INITIAL_STATE__\s*=\s*({.+?});/,
      /<script[^>]*>window\.__.*?=\s*({.+?});/,
      /"config":\s*({[^}]+"settingsUrl"[^}]+})/,
    ];

    for (const jsonPattern of jsonMatches) {
      const jsonMatch = pageContent.match(jsonPattern);
      if (jsonMatch) {
        try {
          const state = JSON.parse(jsonMatch[1]);
          if (state?.settingsUrl) {
            return state.settingsUrl;
          }
          // Ищем вложенные объекты
          for (const key in state) {
            if (state[key]?.settingsUrl) {
              return state[key].settingsUrl;
            }
          }
        } catch (e) {
          // Игнорируем ошибки парсинга
        }
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Форматирование времени в читаемый формат
 * @param milliseconds Время в миллисекундах
 * @returns Строка формата "Xm Ys"
 */
export function formatElapsedTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * Извлечение числа из строки (удаление разделителей)
 * @param text Текст с числом
 * @returns Число или null
 */
export function extractNumber(text: string): number | null {
  if (!text || !text.trim()) {
    return null;
  }
  // Удаляем все разделители (пробелы, неразрывные пробелы, запятые)
  const cleaned = text.replace(/[\s\u00A0,]/g, '');
  // Проверяем, что остались только цифры
  if (/^\d+$/.test(cleaned)) {
    return parseInt(cleaned, 10);
  }
  return null;
}

