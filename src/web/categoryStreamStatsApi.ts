/**
 * API статистики времени стримов по категориям для dashboard
 */

import {
  CategoryStreamDurationTotal,
  DatabaseStorage,
} from '../modes/api/DatabaseStorage';

export interface CategoryStreamStatsApiResponse {
  categories: CategoryStreamDurationTotal[];
  error?: string;
}

/**
 * Возвращает суммарное время стримов по категориям из БД
 */
export function readCategoryStreamStatsForApi(
  databaseStorage: DatabaseStorage | null | undefined
): CategoryStreamStatsApiResponse {
  if (!databaseStorage?.isReady()) {
    return { categories: [], error: 'Database storage not available' };
  }

  return { categories: databaseStorage.getCategoryStreamDurationTotals() };
}
