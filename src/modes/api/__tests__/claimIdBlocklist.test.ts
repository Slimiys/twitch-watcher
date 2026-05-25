import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClaimIdBlocklist } from '../claimIdBlocklist';

describe('ClaimIdBlocklist', () => {
  it('блокирует claimId после markFailed', () => {
    const list = new ClaimIdBlocklist(0);
    list.markFailed('claim-a');
    expect(list.isBlocked('claim-a')).toBe(true);
    expect(list.isBlocked('claim-b')).toBe(false);
  });

  it('clear снимает блокировку', () => {
    const list = new ClaimIdBlocklist(0);
    list.markFailed('claim-a');
    list.clear('claim-a');
    expect(list.isBlocked('claim-a')).toBe(false);
  });

  it('после TTL блокировка снимается', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const list = new ClaimIdBlocklist(1000);
    list.markFailed('claim-a');
    expect(list.isBlocked('claim-a')).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(list.isBlocked('claim-a')).toBe(false);
    vi.useRealTimers();
  });

  it('prune удаляет устаревшие записи', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const list = new ClaimIdBlocklist(500);
    list.markFailed('claim-a');
    vi.advanceTimersByTime(600);
    list.prune();
    expect(list.isBlocked('claim-a')).toBe(false);
    vi.useRealTimers();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
