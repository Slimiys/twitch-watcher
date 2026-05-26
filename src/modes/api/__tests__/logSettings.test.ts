import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAppBooleanEnabled, isFileLoggingEnabled } from '../logSettings';

describe('logSettings', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  beforeEach(() => {
    delete process.env.LOG_TO_FILE;
  });

  it('LOG_TO_FILE enabled by default', () => {
    expect(isAppBooleanEnabled('LOG_TO_FILE', undefined)).toBe(true);
    expect(isFileLoggingEnabled()).toBe(true);
  });

  it('LOG_TO_FILE disabled when false', () => {
    process.env.LOG_TO_FILE = 'false';
    expect(isFileLoggingEnabled()).toBe(false);
  });
});
