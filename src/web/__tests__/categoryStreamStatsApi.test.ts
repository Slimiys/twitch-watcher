/**
 * Тесты для categoryStreamStatsApi
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCategoryStreamStatsForApi, resetCategoryStreamStatsForApi } from '../categoryStreamStatsApi';

describe('categoryStreamStatsApi', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('readCategoryStreamStatsForApi возвращает пустой список без БД', () => {
    const result = readCategoryStreamStatsForApi(null);
    expect(result.categories).toEqual([]);
    expect(result.error).toBe('Database storage not available');
  });

  it('readCategoryStreamStatsForApi читает данные из DatabaseStorage', () => {
    const databaseStorage = {
      isReady: () => true,
      getCategoryStreamDurationDetails: () => [
        { category: 'Torchlight', durationMs: 3600000, streamers: [] },
      ],
    };

    const result = readCategoryStreamStatsForApi(databaseStorage as any);
    expect(result.categories).toEqual([
      { category: 'Torchlight', durationMs: 3600000, streamers: [] },
    ]);
    expect(result.error).toBeUndefined();
  });

  it('readCategoryStreamStatsForApi предпочитает живые данные провайдера', () => {
    const provider = {
      getCategoryStreamDurationTotalsForDashboard: () => [
        {
          category: 'Path of Exile',
          durationMs: 120000,
          streamers: [{ streamerName: 'shroud', durationMs: 120000 }],
        },
      ],
    };

    const result = readCategoryStreamStatsForApi(null, provider);
    expect(result.categories).toEqual([
      {
        category: 'Path of Exile',
        durationMs: 120000,
        streamers: [{ streamerName: 'shroud', durationMs: 120000 }],
      },
    ]);
    expect(result.error).toBeUndefined();
  });

  it('readCategoryStreamStatsForApi фильтрует категории с нулевым временем', () => {
    const provider = {
      getCategoryStreamDurationTotalsForDashboard: () => [
        { category: 'Skipped', durationMs: 0, streamers: [] },
        { category: 'Short', durationMs: 30_000, streamers: [] },
        { category: 'Kept', durationMs: 120_000, streamers: [] },
      ],
    };

    const result = readCategoryStreamStatsForApi(null, provider);
    expect(result.categories).toEqual([
      { category: 'Kept', durationMs: 120_000, streamers: [] },
    ]);
  });

  it('resetCategoryStreamStatsForApi вызывает сброс у провайдера', () => {
    const reset = vi.fn();
    const provider = {
      getCategoryStreamDurationTotalsForDashboard: () => [],
      resetCategoryStreamDurationStats: reset,
    };

    const result = resetCategoryStreamStatsForApi(null, provider);
    expect(result.success).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('resetCategoryStreamStatsForApi очищает БД без провайдера', () => {
    const clear = vi.fn(() => true);
    const databaseStorage = {
      isReady: () => true,
      clearCategoryStreamDurationStats: clear,
    };

    const result = resetCategoryStreamStatsForApi(databaseStorage as any, null);
    expect(result.success).toBe(true);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
