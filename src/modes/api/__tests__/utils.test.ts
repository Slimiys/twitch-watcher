import { describe, expect, it } from 'vitest';
import { withTimeout } from '../utils';

describe('withTimeout', () => {
  it('resolves when fn completes in time', async () => {
    const result = await withTimeout(async () => 42, 1000, 'test');
    expect(result).toBe(42);
  });

  it('rejects when fn exceeds timeout', async () => {
    await expect(
      withTimeout(
        () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 200)),
        50,
        'slow-op'
      )
    ).rejects.toThrow(/Timeout after 50ms \[slow-op\]/);
  });
});
