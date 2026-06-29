/**
 * API поиска категорий Twitch для dashboard
 */

import { loadTokenFromConfig } from '../appRuntime';
import {
  getCategoryMatchErrorRatio,
  isCategoryFuzzyMatch,
} from '../modes/api/categoryFuzzyMatch';
import { getAppConfigPath, getAppSetting } from '../modes/api/appSettings';
import { TwitchAPI, TwitchCategorySummary } from '../modes/api/TwitchAPI';
import { StreamWatcher } from '../modes/api/StreamWatcher';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Фильтрует и сортирует категории по нечёткому совпадению
 */
export function filterCategoriesByFuzzyMatch(
  categories: TwitchCategorySummary[],
  query: string
): TwitchCategorySummary[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const fuzzyMatches = categories.filter((item) =>
    isCategoryFuzzyMatch(normalizedQuery, item.name)
  );
  const pool = fuzzyMatches.length > 0 ? fuzzyMatches : categories;

  return [...pool].sort(
    (left, right) =>
      getCategoryMatchErrorRatio(normalizedQuery, left.name) -
      getCategoryMatchErrorRatio(normalizedQuery, right.name)
  );
}

/**
 * Убирает дубликаты категорий по id
 */
export function dedupeCategories(
  categories: TwitchCategorySummary[]
): TwitchCategorySummary[] {
  const byId = new Map<string, TwitchCategorySummary>();
  for (const item of categories) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

/**
 * Собирает кандидатов из Helix по основному и укороченным запросам (опечатки)
 */
export async function fetchCategorySearchCandidates(
  twitchApi: TwitchAPI,
  query: string
): Promise<TwitchCategorySummary[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const queries = new Set<string>([trimmed]);
  if (trimmed.length >= 4) {
    queries.add(trimmed.slice(0, -1));
  }
  if (trimmed.length >= 5) {
    queries.add(trimmed.slice(0, -2));
  }
  if (trimmed.length >= 3) {
    queries.add(trimmed.slice(0, 3));
  }

  const merged: TwitchCategorySummary[] = [];
  for (const searchQuery of queries) {
    const batch = await twitchApi.searchCategories(searchQuery);
    merged.push(...batch);
  }

  return dedupeCategories(merged);
}

function resolveAuthToken(): string | null {
  return (
    loadTokenFromConfig(getAppConfigPath()) ||
    process.env.token?.trim() ||
    null
  );
}

function resolveTwitchApi(provider: StreamWatcher | null): TwitchAPI | null {
  if (provider) {
    return provider.getTwitchApiForDashboard();
  }

  const token = resolveAuthToken();
  if (!token) {
    return null;
  }

  return new TwitchAPI(token, resolveUserAgent());
}

/**
 * @deprecated Используйте filterCategoriesByFuzzyMatch
 */
export function filterCategoriesByPrefix(
  categories: TwitchCategorySummary[],
  query: string
): TwitchCategorySummary[] {
  return filterCategoriesByFuzzyMatch(categories, query);
}

function resolveUserAgent(): string {
  return process.env.userAgent?.trim() || getAppSetting('userAgent')?.trim() || DEFAULT_USER_AGENT;
}

/**
 * Ищет категории Twitch с нечётким сопоставлением названия
 */
export async function searchCategoriesForApi(
  query: string,
  provider: StreamWatcher | null = null
): Promise<{
  categories: TwitchCategorySummary[];
  error?: string;
}> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { categories: [] };
  }

  const twitchApi = resolveTwitchApi(provider);
  if (!twitchApi) {
    return { categories: [], error: 'Twitch token is not configured' };
  }

  const candidates = await fetchCategorySearchCandidates(twitchApi, trimmed);
  return { categories: filterCategoriesByFuzzyMatch(candidates, trimmed).slice(0, 20) };
}
