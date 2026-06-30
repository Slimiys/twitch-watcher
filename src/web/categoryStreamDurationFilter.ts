/**
 * Фильтрация статистики времени стримов по категориям
 */

import { CategoryStreamDurationTotal } from '../modes/api/DatabaseStorage';

/**
 * Проверяет, нужно ли показывать категорию в статистике (время > 0 в UI, т.е. ≥ 1 мин)
 */
export function shouldIncludeCategoryStreamDuration(durationMs: number): boolean {
  const ms = Math.max(0, Math.floor(Number(durationMs) || 0));
  if (ms <= 0) {
    return false;
  }
  // В дашборде длительность < 1 мин отображается как «0 минут»
  return Math.floor(ms / 60_000) > 0;
}

/**
 * Убирает категории и стримеров с нулевым (или неотображаемым) временем
 */
export function filterCategoryStreamDurationTotals(
  categories: CategoryStreamDurationTotal[]
): CategoryStreamDurationTotal[] {
  return categories
    .map((entry) => {
      const streamers = (entry.streamers ?? []).filter((row) =>
        shouldIncludeCategoryStreamDuration(row.durationMs)
      );
      const streamersSum = streamers.reduce((sum, row) => sum + (Number(row.durationMs) || 0), 0);
      const entryDuration = Number(entry.durationMs) || 0;
      const durationMs = Math.max(
        streamersSum,
        shouldIncludeCategoryStreamDuration(entryDuration) ? entryDuration : 0
      );

      return {
        ...entry,
        durationMs,
        streamers,
      };
    })
    .filter((entry) => shouldIncludeCategoryStreamDuration(entry.durationMs))
    .sort(
      (a, b) =>
        b.durationMs - a.durationMs || a.category.localeCompare(b.category, 'ru')
    );
}
