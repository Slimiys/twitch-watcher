/**
 * API поиска категорий Twitch для dashboard
 */

import { loadTokenFromConfig } from '../appRuntime';
import { getAppSetting } from '../modes/api/appSettings';
import { TwitchAPI, TwitchCategorySummary } from '../modes/api/TwitchAPI';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Фильтрует категории по префиксу имени (без учёта регистра)
 */
export function filterCategoriesByPrefix(
  categories: TwitchCategorySummary[],
  query: string
): TwitchCategorySummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  return categories.filter((item) => item.name.toLowerCase().startsWith(normalizedQuery));
}

function resolveUserAgent(): string {
  return process.env.userAgent?.trim() || getAppSetting('userAgent')?.trim() || DEFAULT_USER_AGENT;
}

/**
 * Ищет категории Twitch по префиксу названия
 */
export async function searchCategoriesForApi(query: string): Promise<{
  categories: TwitchCategorySummary[];
  error?: string;
}> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { categories: [] };
  }

  const token = loadTokenFromConfig();
  if (!token) {
    return { categories: [], error: 'Twitch token is not configured' };
  }

  const twitchApi = new TwitchAPI(token, resolveUserAgent());
  const raw = await twitchApi.searchCategories(trimmed);
  return { categories: filterCategoriesByPrefix(raw, trimmed) };
}
