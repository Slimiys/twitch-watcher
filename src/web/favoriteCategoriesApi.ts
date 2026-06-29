/**
 * API избранных категорий Twitch для dashboard
 */

import {
  addFavoriteCategory,
  getFavoriteCategories,
  removeFavoriteCategoryById,
} from '../modes/api/favoriteCategories';
import { FavoriteCategory } from '../types';

export interface FavoriteCategoriesApiResponse {
  categories: FavoriteCategory[];
  message?: string;
}

/**
 * Возвращает избранные категории
 */
export function readFavoriteCategoriesForApi(): FavoriteCategoriesApiResponse {
  return { categories: getFavoriteCategories() };
}

/**
 * Добавляет категорию в избранное
 */
export function addFavoriteCategoryFromApi(body: {
  id?: string;
  name?: string;
  boxArtUrl?: string | null;
}): FavoriteCategoriesApiResponse {
  const categories = addFavoriteCategory({
    id: body.id ?? '',
    name: body.name ?? '',
    boxArtUrl: body.boxArtUrl ?? null,
  });
  return {
    categories,
    message: 'Категория добавлена в избранное',
  };
}

/**
 * Удаляет категорию из избранного
 */
export function removeFavoriteCategoryFromApi(id: string): FavoriteCategoriesApiResponse {
  const categories = removeFavoriteCategoryById(id);
  return {
    categories,
    message: 'Категория удалена из избранного',
  };
}
