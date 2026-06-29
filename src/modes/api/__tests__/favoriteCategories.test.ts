/**
 * Тесты для favoriteCategories
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addFavoriteCategory,
  getFavoriteCategories,
  removeFavoriteCategoryById,
  saveFavoriteCategories,
} from '../favoriteCategories';

describe('favoriteCategories', () => {
  let tempDir: string;
  let configPath: string;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createTempConfig(initial: Record<string, unknown> = {}): void {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favorite-categories-'));
    configPath = path.join(tempDir, 'config.json');
    fs.writeFileSync(configPath, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
  }

  it('возвращает пустой список если секция отсутствует', () => {
    createTempConfig({});
    expect(getFavoriteCategories(configPath)).toEqual([]);
  });

  it('сохраняет и читает избранные категории', () => {
    createTempConfig({ token: 'test' });
    const categories = [
      { id: '509658', name: 'Just Chatting', boxArtUrl: 'https://example.com/509658.jpg' },
    ];
    saveFavoriteCategories(categories, configPath);
    expect(getFavoriteCategories(configPath)).toEqual(categories);

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(raw.token).toBe('test');
    expect(raw.favoriteCategories).toEqual(categories);
  });

  it('добавляет категорию без дубликатов', () => {
    createTempConfig({});
    const first = addFavoriteCategory(
      { id: '1', name: 'Path of Exile', boxArtUrl: null },
      configPath
    );
    expect(first).toHaveLength(1);

    const second = addFavoriteCategory(
      { id: '1', name: 'Path of Exile', boxArtUrl: null },
      configPath
    );
    expect(second).toHaveLength(1);
  });

  it('удаляет категорию по id', () => {
    createTempConfig({
      favoriteCategories: [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
      ],
    });

    const updated = removeFavoriteCategoryById('1', configPath);
    expect(updated).toEqual([{ id: '2', name: 'B', boxArtUrl: null }]);
  });
});
