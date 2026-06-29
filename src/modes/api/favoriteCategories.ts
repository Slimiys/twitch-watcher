/**
 * Избранные категории Twitch в config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../../pidFile';
import { AppConfig, FavoriteCategory } from '../../types';

/**
 * Путь к config.json в корне проекта
 */
export function getFavoriteCategoriesConfigPath(): string {
  return path.join(getProjectRoot(), 'config.json');
}

function readConfig(configPath: string = getFavoriteCategoriesConfigPath()): AppConfig {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as AppConfig;
  } catch {
    return {};
  }
}

function writeConfig(config: AppConfig, configPath: string = getFavoriteCategoriesConfigPath()): void {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function normalizeCategory(category: FavoriteCategory): FavoriteCategory | null {
  const id = category.id?.trim();
  const name = category.name?.trim();
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    boxArtUrl: category.boxArtUrl?.trim() || null,
  };
}

/**
 * Возвращает список избранных категорий из config.json
 */
export function getFavoriteCategories(
  configPath: string = getFavoriteCategoriesConfigPath()
): FavoriteCategory[] {
  const config = readConfig(configPath);
  if (!Array.isArray(config.favoriteCategories)) {
    return [];
  }
  return config.favoriteCategories
    .map((item) => normalizeCategory(item))
    .filter((item): item is FavoriteCategory => item !== null);
}

/**
 * Сохраняет список избранных категорий в config.json
 */
export function saveFavoriteCategories(
  categories: FavoriteCategory[],
  configPath: string = getFavoriteCategoriesConfigPath()
): void {
  const config = readConfig(configPath);
  config.favoriteCategories = categories;
  writeConfig(config, configPath);
}

/**
 * Добавляет категорию в избранное (без дубликатов по id)
 */
export function addFavoriteCategory(
  category: FavoriteCategory,
  configPath: string = getFavoriteCategoriesConfigPath()
): FavoriteCategory[] {
  const normalized = normalizeCategory(category);
  if (!normalized) {
    throw new Error('id and name are required');
  }

  const current = getFavoriteCategories(configPath);
  if (current.some((item) => item.id === normalized.id)) {
    return current;
  }

  const updated = [...current, normalized];
  saveFavoriteCategories(updated, configPath);
  return updated;
}

/**
 * Удаляет категорию из избранного по id
 */
export function removeFavoriteCategoryById(
  id: string,
  configPath: string = getFavoriteCategoriesConfigPath()
): FavoriteCategory[] {
  const normalizedId = id?.trim();
  if (!normalizedId) {
    throw new Error('id is required');
  }

  const updated = getFavoriteCategories(configPath).filter((item) => item.id !== normalizedId);
  saveFavoriteCategories(updated, configPath);
  return updated;
}
