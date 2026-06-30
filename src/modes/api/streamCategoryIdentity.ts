/**
 * Идентификация категории стрима для учёта длительности
 */

/** Ссылка на категорию Twitch (имя и опциональный id) */
export interface StreamCategoryRef {
  name: string | null | undefined;
  id?: string | null;
}

/**
 * Нормализует отображаемое имя категории
 */
export function normalizeStreamCategoryName(name: string | null | undefined): string {
  return name?.trim() ?? '';
}

/**
 * Проверяет, что две категории относятся к одной игре
 */
export function isSameStreamCategory(left: StreamCategoryRef, right: StreamCategoryRef): boolean {
  const leftName = normalizeStreamCategoryName(left.name);
  const rightName = normalizeStreamCategoryName(right.name);

  if (!leftName && !rightName) {
    return true;
  }
  if (!leftName || !rightName) {
    return false;
  }

  const leftId = left.id?.trim();
  const rightId = right.id?.trim();
  if (leftId && rightId) {
    return leftId === rightId;
  }

  return leftName === rightName;
}
