import { describe, it, expect, afterEach } from 'vitest';
import {
  INTEGRITY_TOKEN_PREFIX_LEN,
  getIntegrityTokenDisplay,
  integrityTokenPrefix,
  recordIntegrityTokenForDisplay,
  resetIntegrityTokenDisplayForTests,
} from '../integrityTokenDisplay';

describe('integrityTokenDisplay', () => {
  afterEach(() => {
    resetIntegrityTokenDisplayForTests();
    delete process.env.TWITCH_CLIENT_INTEGRITY;
  });

  it('integrityTokenPrefix обрезает до 32 символов', () => {
    const long = 'a'.repeat(50);
    expect(integrityTokenPrefix(long).length).toBe(INTEGRITY_TOKEN_PREFIX_LEN);
  });

  it('recordIntegrityTokenForDisplay сохраняет прошлый префикс при смене', () => {
    const first = 'f'.repeat(40);
    const second = 's'.repeat(40);
    recordIntegrityTokenForDisplay(first);
    recordIntegrityTokenForDisplay(second);
    const display = getIntegrityTokenDisplay();
    expect(display.previousPrefix).toBe(integrityTokenPrefix(first));
    expect(display.currentPrefix).toBe(integrityTokenPrefix(second));
  });

  it('recordIntegrityTokenForDisplay не меняет прошлый при том же префиксе', () => {
    const token = 't'.repeat(40);
    recordIntegrityTokenForDisplay(token);
    expect(recordIntegrityTokenForDisplay(token)).toBe(false);
    const display = getIntegrityTokenDisplay();
    expect(display.previousPrefix).toBeNull();
    expect(display.currentPrefix).toBe(integrityTokenPrefix(token));
  });

  it('инициализирует текущий префикс из env', () => {
    process.env.TWITCH_CLIENT_INTEGRITY = 'env-token-' + 'x'.repeat(40);
    const display = getIntegrityTokenDisplay();
    expect(display.currentPrefix).toBe(integrityTokenPrefix(process.env.TWITCH_CLIENT_INTEGRITY));
    expect(display.previousPrefix).toBeNull();
  });
});
