/**
 * Тесты идентификации категорий стрима
 */

import { describe, expect, it } from 'vitest';
import { isSameStreamCategory } from '../streamCategoryIdentity';

describe('streamCategoryIdentity', () => {
  it('различает Path of Exile и Path of Exile 2 по имени', () => {
    expect(
      isSameStreamCategory(
        { name: 'Path of Exile' },
        { name: 'Path of Exile 2' }
      )
    ).toBe(false);
  });

  it('считает категории одинаковыми при совпадении id', () => {
    expect(
      isSameStreamCategory(
        { name: 'Path of Exile', id: '498789' },
        { name: 'Path of Exile', id: '498789' }
      )
    ).toBe(true);
  });

  it('различает категории с разными id даже при похожих именах', () => {
    expect(
      isSameStreamCategory(
        { name: 'Path of Exile', id: '498789' },
        { name: 'Path of Exile 2', id: '1702520304' }
      )
    ).toBe(false);
  });
});
