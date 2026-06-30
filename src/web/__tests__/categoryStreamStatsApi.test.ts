/**
 * Тесты для categoryStreamStatsApi
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCategoryStreamStatsForApi } from '../categoryStreamStatsApi';

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
});
