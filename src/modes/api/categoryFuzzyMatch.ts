/**
 * Нечёткое сопоставление названий категорий Twitch
 */

/** Максимальная доля ошибок для совпадения (50%) */
export const CATEGORY_FUZZY_MAX_ERROR_RATIO = 0.5;

/**
 * Расстояние Левенштейна между двумя строками
 */
export function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (!left.length) {
    return right.length;
  }
  if (!right.length) {
    return left.length;
  }

  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let row = 0; row < rows; row += 1) {
    matrix[row][0] = row;
  }
  for (let col = 0; col < cols; col += 1) {
    matrix[0][col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

/**
 * Возвращает долю ошибок при сопоставлении запроса с названием категории (0..1)
 */
export function getCategoryMatchErrorRatio(query: string, categoryName: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedCategory = categoryName.trim().toLowerCase();

  if (!normalizedQuery || !normalizedCategory) {
    return 1;
  }

  if (normalizedCategory.startsWith(normalizedQuery)) {
    return 0;
  }

  const fullDistance = levenshteinDistance(normalizedQuery, normalizedCategory);
  let bestRatio = fullDistance / Math.max(normalizedQuery.length, normalizedCategory.length);

  const minWindow = Math.max(1, normalizedQuery.length - 2);
  const maxWindow = normalizedQuery.length + 2;

  for (let windowLength = minWindow; windowLength <= maxWindow; windowLength += 1) {
    if (windowLength > normalizedCategory.length) {
      continue;
    }

    for (let start = 0; start <= normalizedCategory.length - windowLength; start += 1) {
      const slice = normalizedCategory.slice(start, start + windowLength);
      const distance = levenshteinDistance(normalizedQuery, slice);
      const ratio = distance / Math.max(normalizedQuery.length, slice.length);
      if (ratio < bestRatio) {
        bestRatio = ratio;
      }
    }
  }

  return bestRatio;
}

/**
 * Проверяет, подходит ли категория под запрос с допустимой долей ошибок
 */
export function isCategoryFuzzyMatch(
  query: string,
  categoryName: string,
  maxErrorRatio: number = CATEGORY_FUZZY_MAX_ERROR_RATIO
): boolean {
  return getCategoryMatchErrorRatio(query, categoryName) < maxErrorRatio;
}
