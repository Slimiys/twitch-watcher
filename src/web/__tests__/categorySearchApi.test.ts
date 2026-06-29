/**
 * Тесты для categorySearchApi
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTokenFromConfig } from '../../appRuntime';
import {
  dedupeCategories,
  filterCategoriesByFuzzyMatch,
  fetchCategorySearchCandidates,
} from '../categorySearchApi';

vi.mock('../../appRuntime', () => ({
  loadTokenFromConfig: vi.fn(() => 'token'),
}));

vi.mock('../../modes/api/appSettings', () => ({
  getAppSetting: vi.fn(() => undefined),
  getAppConfigPath: vi.fn(() => './config.json'),
}));

const searchCategoriesMock = vi.fn();

vi.mock('../../modes/api/TwitchAPI', () => ({
  TwitchAPI: vi.fn().mockImplementation(() => ({
    searchCategories: searchCategoriesMock,
  })),
}));

describe('categorySearchApi', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('filterCategoriesByFuzzyMatch оставляет совпадения по префиксу', () => {
    const input = [
      { id: '1', name: 'Path of Exile', boxArtUrl: null },
      { id: '2', name: 'Path of Exile 2', boxArtUrl: null },
      { id: '3', name: 'Just Chatting', boxArtUrl: null },
    ];

    expect(filterCategoriesByFuzzyMatch(input, 'path')).toEqual([
      { id: '1', name: 'Path of Exile', boxArtUrl: null },
      { id: '2', name: 'Path of Exile 2', boxArtUrl: null },
    ]);
  });

  it('filterCategoriesByFuzzyMatch находит категорию с опечатками', () => {
    const input = [
      { id: '1', name: 'Torchlight', boxArtUrl: null },
      { id: '2', name: 'Just Chatting', boxArtUrl: null },
    ];

    expect(filterCategoriesByFuzzyMatch(input, 'rocglight')).toEqual([
      { id: '1', name: 'Torchlight', boxArtUrl: null },
    ]);
  });

  it('filterCategoriesByFuzzyMatch возвращает все результаты Helix, если fuzzy не сработал', () => {
    const input = [
      { id: '1', name: 'Elden Ring', boxArtUrl: null },
      { id: '2', name: 'Dark Souls III', boxArtUrl: null },
    ];

    const result = filterCategoriesByFuzzyMatch(input, 'fromsoftware');
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.id).sort()).toEqual(['1', '2']);
  });

  it('dedupeCategories убирает дубликаты по id', () => {
    const input = [
      { id: '1', name: 'A', boxArtUrl: null },
      { id: '1', name: 'A', boxArtUrl: null },
      { id: '2', name: 'B', boxArtUrl: null },
    ];

    expect(dedupeCategories(input)).toHaveLength(2);
  });

  it('fetchCategorySearchCandidates объединяет результаты укороченных запросов', async () => {
    searchCategoriesMock
      .mockResolvedValueOnce([{ id: '1', name: 'Torchlight', boxArtUrl: null }])
      .mockResolvedValueOnce([{ id: '2', name: 'Rocket League', boxArtUrl: null }]);

    const twitchApi = { searchCategories: searchCategoriesMock };
    const result = await fetchCategorySearchCandidates(twitchApi as any, 'rocg');

    expect(result).toHaveLength(2);
    expect(searchCategoriesMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('searchCategoriesForApi использует Twitch API watcher при наличии', async () => {
    const { searchCategoriesForApi } = await import('../categorySearchApi');

    searchCategoriesMock.mockResolvedValue([
      { id: '2', name: 'Minecraft', boxArtUrl: null },
    ]);

    const provider = {
      getTwitchApiForDashboard: () => ({ searchCategories: searchCategoriesMock }),
    };

    const result = await searchCategoriesForApi('mine', provider as any);
    expect(result.categories).toEqual([{ id: '2', name: 'Minecraft', boxArtUrl: null }]);
    expect(loadTokenFromConfig).not.toHaveBeenCalled();
  });
});
