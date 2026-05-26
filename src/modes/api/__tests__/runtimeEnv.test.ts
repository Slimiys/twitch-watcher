import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  shouldAutoExitOnUnhealthy,
  shouldAutoExitOnInvalidToken,
  isTransientNetworkErrorCode,
} from '../runtimeEnv';

describe('runtimeEnv', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    delete process.env.AUTO_EXIT_ON_UNHEALTHY;
    delete process.env.AUTO_EXIT_ON_INVALID_TOKEN;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('shouldAutoExitOnUnhealthy: false по умолчанию', () => {
    expect(shouldAutoExitOnUnhealthy()).toBe(false);
  });

  it('shouldAutoExitOnUnhealthy: true при AUTO_EXIT_ON_UNHEALTHY=true', () => {
    process.env.AUTO_EXIT_ON_UNHEALTHY = 'true';
    expect(shouldAutoExitOnUnhealthy()).toBe(true);
  });

  it('shouldAutoExitOnUnhealthy: false при AUTO_EXIT_ON_UNHEALTHY=false', () => {
    process.env.AUTO_EXIT_ON_UNHEALTHY = 'false';
    expect(shouldAutoExitOnUnhealthy()).toBe(false);
  });

  it('shouldAutoExitOnInvalidToken: false по умолчанию', () => {
    expect(shouldAutoExitOnInvalidToken()).toBe(false);
  });

  it('shouldAutoExitOnInvalidToken: false при AUTO_EXIT_ON_INVALID_TOKEN=false', () => {
    process.env.AUTO_EXIT_ON_INVALID_TOKEN = 'false';
    expect(shouldAutoExitOnInvalidToken()).toBe(false);
  });

  it('shouldAutoExitOnInvalidToken: true при AUTO_EXIT_ON_INVALID_TOKEN=true', () => {
    process.env.AUTO_EXIT_ON_INVALID_TOKEN = 'true';
    expect(shouldAutoExitOnInvalidToken()).toBe(true);
  });

  it('isTransientNetworkErrorCode распознаёт ENOTFOUND', () => {
    expect(isTransientNetworkErrorCode('ENOTFOUND')).toBe(true);
    expect(isTransientNetworkErrorCode('INVALID_TOKEN')).toBe(false);
  });
});
