/**
 * API статистики времени стримов по категориям для dashboard
 */

import {
  CategoryStreamDurationTotal,
  DatabaseStorage,
} from '../modes/api/DatabaseStorage';
import { filterCategoryStreamDurationTotals } from './categoryStreamDurationFilter';

export interface CategoryStreamStatsApiResponse {
  categories: CategoryStreamDurationTotal[];
  error?: string;
}

/** Провайдер живой статистики категорий (БД + активные сегменты) */
export interface CategoryStreamStatsProvider {
  getCategoryStreamDurationTotalsForDashboard(): CategoryStreamDurationTotal[];
  resetCategoryStreamDurationStats?(): void;
}

export interface CategoryStreamStatsResetResult {
  success: boolean;
  message?: string;
}

/**
 * Возвращает суммарное время стримов по категориям
 */
export function readCategoryStreamStatsForApi(
  databaseStorage: DatabaseStorage | null | undefined,
  statsProvider: CategoryStreamStatsProvider | null | undefined = null
): CategoryStreamStatsApiResponse {
  if (statsProvider?.getCategoryStreamDurationTotalsForDashboard) {
    return {
      categories: filterCategoryStreamDurationTotals(
        statsProvider.getCategoryStreamDurationTotalsForDashboard()
      ),
    };
  }

  if (!databaseStorage?.isReady()) {
    return { categories: [], error: 'Database storage not available' };
  }

  return {
    categories: filterCategoryStreamDurationTotals(
      databaseStorage.getCategoryStreamDurationDetails()
    ),
  };
}

/**
 * Сбрасывает статистику времени стримов по категориям
 */
export function resetCategoryStreamStatsForApi(
  databaseStorage: DatabaseStorage | null | undefined,
  statsProvider: CategoryStreamStatsProvider | null | undefined = null
): CategoryStreamStatsResetResult {
  if (typeof statsProvider?.resetCategoryStreamDurationStats === 'function') {
    statsProvider.resetCategoryStreamDurationStats();
    return { success: true };
  }

  if (!databaseStorage?.isReady()) {
    return { success: false, message: 'Database storage not available' };
  }

  if (!databaseStorage.clearCategoryStreamDurationStats()) {
    return { success: false, message: 'Failed to reset category stream stats' };
  }

  return { success: true };
}
