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

/** Провайдер живой статистики категорий (БД + активные сегменты) */
export interface CategoryStreamStatsProvider {
  getCategoryStreamDurationTotalsForDashboard(): CategoryStreamDurationTotal[];
}

/**
 * Возвращает суммарное время стримов по категориям
 */
export function readCategoryStreamStatsForApi(
  databaseStorage: DatabaseStorage | null | undefined,
  statsProvider: CategoryStreamStatsProvider | null | undefined = null
): CategoryStreamStatsApiResponse {
  if (statsProvider?.getCategoryStreamDurationTotalsForDashboard) {
    return { categories: statsProvider.getCategoryStreamDurationTotalsForDashboard() };
  }

  if (!databaseStorage?.isReady()) {
    return { categories: [], error: 'Database storage not available' };
  }

  return { categories: databaseStorage.getCategoryStreamDurationDetails() };
}
