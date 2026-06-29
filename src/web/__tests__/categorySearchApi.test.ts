/**
 * Тесты для categorySearchApi
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterCategoriesByPrefix } from '../categorySearchApi';

vi.mock('../../appRuntime', () => ({
  loadTokenFromConfig: vi.fn(() => 'token'),
}));

vi.mock('../../modes/api/appSettings', () => ({
  getAppSetting: vi.fn(() => undefined),
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

  it('filterCategoriesByPrefix оставляет только совпадения по префиксу', () => {
    const input = [
      { id: '1', name: 'Path of Exile', boxArtUrl: null },
      { id: '2', name: 'Path of Exile 2', boxArtUrl: null },
      { id: '3', name: 'Just Chatting', boxArtUrl: null },
    ];

    expect(filterCategoriesByPrefix(input, 'path')).toEqual([
      { id: '1', name: 'Path of Exile', boxArtUrl: null },
      { id: '2', name: 'Path of Exile 2', boxArtUrl: null },
    ]);
  });

  it('searchCategoriesForApi применяет prefix-фильтр к ответу Twitch', async () => {
    const { searchCategoriesForApi } = await import('../categorySearchApi');

    searchCategoriesMock.mockResolvedValue([
      { id: '1', name: 'Just Chatting', boxArtUrl: null },
      { id: '2', name: 'Minecraft', boxArtUrl: null },
    ]);

    const result = await searchCategoriesForApi('mine');
    expect(result.categories).toEqual([{ id: '2', name: 'Minecraft', boxArtUrl: null }]);
  });
});
