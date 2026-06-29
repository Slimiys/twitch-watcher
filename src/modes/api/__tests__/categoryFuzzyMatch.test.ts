/**
 * Тесты для categoryFuzzyMatch
 */

import { describe, expect, it } from 'vitest';
import {
  getCategoryMatchErrorRatio,
  isCategoryFuzzyMatch,
  levenshteinDistance,
} from '../categoryFuzzyMatch';

describe('categoryFuzzyMatch', () => {
  it('levenshteinDistance считает расстояние между строками', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('torchlight', 'torchlight')).toBe(0);
  });

  it('rocglight подходит к Torchlight с долей ошибок менее 50%', () => {
    expect(isCategoryFuzzyMatch('rocglight', 'Torchlight')).toBe(true);
    expect(getCategoryMatchErrorRatio('rocglight', 'Torchlight')).toBeLessThan(0.5);
  });

  it('префикс даёт нулевую долю ошибок', () => {
    expect(getCategoryMatchErrorRatio('path', 'Path of Exile')).toBe(0);
    expect(isCategoryFuzzyMatch('path', 'Path of Exile')).toBe(true);
  });

  it('сильно отличающийся запрос не подходит', () => {
    expect(isCategoryFuzzyMatch('rocglight', 'Just Chatting')).toBe(false);
  });
});
