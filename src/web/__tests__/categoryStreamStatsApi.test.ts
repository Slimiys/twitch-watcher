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
      getCategoryStreamDurationTotals: () => [
        { category: 'Torchlight', durationMs: 3600000 },
      ],
    };

    const result = readCategoryStreamStatsForApi(databaseStorage as any);
    expect(result.categories).toEqual([{ category: 'Torchlight', durationMs: 3600000 }]);
    expect(result.error).toBeUndefined();
  });
});
