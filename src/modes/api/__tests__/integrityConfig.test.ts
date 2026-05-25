import { describe, it, expect } from 'vitest';
import { integrityExpirationToMs } from '../integrityConfig';

describe('integrityConfig', () => {
  const now = 1_700_000_000_000;

  it('без expiration — +4 часа от now', () => {
    expect(integrityExpirationToMs(undefined, now)).toBe(now + 4 * 60 * 60 * 1000);
  });

  it('expiration в секундах умножается на 1000', () => {
    expect(integrityExpirationToMs(1_700_000_100, now)).toBe(1_700_000_100_000);
  });

  it('expiration в миллисекундах возвращается как есть', () => {
    expect(integrityExpirationToMs(1_700_000_100_000, now)).toBe(1_700_000_100_000);
  });
});
