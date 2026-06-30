/**
 * Тесты фильтрации статистики времени стримов по категориям
 */

import { describe, expect, it } from 'vitest';
import {
  filterCategoryStreamDurationTotals,
  shouldIncludeCategoryStreamDuration,
} from '../categoryStreamDurationFilter';

describe('categoryStreamDurationFilter', () => {
  it('shouldIncludeCategoryStreamDuration отсекает ноль и длительность < 1 мин', () => {
    expect(shouldIncludeCategoryStreamDuration(0)).toBe(false);
    expect(shouldIncludeCategoryStreamDuration(-100)).toBe(false);
    expect(shouldIncludeCategoryStreamDuration(30_000)).toBe(false);
    expect(shouldIncludeCategoryStreamDuration(59_999)).toBe(false);
    expect(shouldIncludeCategoryStreamDuration(60_000)).toBe(true);
    expect(shouldIncludeCategoryStreamDuration(3_600_000)).toBe(true);
  });

  it('filterCategoryStreamDurationTotals убирает категории с нулевым временем', () => {
    const result = filterCategoryStreamDurationTotals([
      { category: 'Empty', durationMs: 0, streamers: [] },
      { category: 'Short', durationMs: 45_000, streamers: [] },
      {
        category: 'PoE',
        durationMs: 120_000,
        streamers: [
          { streamerName: 'a', durationMs: 0 },
          { streamerName: 'b', durationMs: 120_000 },
        ],
      },
    ]);

    expect(result).toEqual([
      {
        category: 'PoE',
        durationMs: 120_000,
        streamers: [{ streamerName: 'b', durationMs: 120_000 }],
      },
    ]);
  });
});
