import { RetryConfig } from './modes/api/types';

/**
 * Интерфейс конфигурации приложения
 */
export interface AppConfig {
  token?: string;
  retry?: RetryConfig;
  streamers?: string[]; // Список стримеров для отслеживания
}

/**
 * Интерфейс для ответа интерактивного ввода
 */
export interface LoginInput {
  token: string;
}

/**
 * Тип для единиц времени dayjs
 */
export type DayjsUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

/**
 * Интерфейс для cookie
 */
export interface CookieData {
  domain: string;
  hostOnly: boolean;
  httpOnly: boolean;
  name: string;
  path: string;
  sameSite: 'Strict' | 'Lax' | 'None' | 'no_restriction' | string;
  secure: boolean;
  session: boolean;
  storeId: string;
  id: number;
  value: string;
}

