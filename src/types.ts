import { RetryConfig } from './modes/api/types';

/**
 * Интерфейс конфигурации приложения
 */
export interface AppConfig {
  token?: string;
  retry?: RetryConfig;
  streamers?: string[]; // Список стримеров для отслеживания
  /** Интервал ротации minute-watched (мс), настраивается через dashboard */
  watch?: {
    cycleIntervalMs?: number;
  };
  /** Параметры, ранее задаваемые через .env (редактируются в dashboard → «Конфиг бота») */
  app?: Record<string, string>;
  /** Избранные категории Twitch для dashboard */
  favoriteCategories?: FavoriteCategory[];
}

/**
 * Краткая информация о категории Twitch
 */
export interface FavoriteCategory {
  id: string;
  name: string;
  boxArtUrl?: string | null;
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

