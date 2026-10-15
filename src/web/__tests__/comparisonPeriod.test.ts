import { describe, expect, it } from 'vitest';
import { comparisonPeriodStart } from '../comparisonPeriod';

describe('comparison periods', () => {
  it('uses server midnight for today and exact rolling windows for 7 and 30 days', () => {
    const now = new Date(2026, 9, 15, 14, 30).getTime();
    expect(comparisonPeriodStart('today', now)).toBe(new Date(2026, 9, 15).getTime());
    expect(comparisonPeriodStart('7', now)).toBe(now - 7 * 86400000);
    expect(comparisonPeriodStart('30', now)).toBe(now - 30 * 86400000);
    expect(comparisonPeriodStart('all', now)).toBe(0);
  });
  it('rejects unknown and SQL-like values', () => {
    expect(comparisonPeriodStart('yesterday', Date.now())).toBeNull();
    expect(comparisonPeriodStart('7 OR 1=1', Date.now())).toBeNull();
  });
});
