import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isDockerEnvironment,
  shouldAutoExitOnUnhealthy,
  shouldAutoExitOnInvalidToken,
  isTransientNetworkErrorCode,
} from '../runtimeEnv';

describe('runtimeEnv', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    delete process.env.AUTO_EXIT_ON_UNHEALTHY;
    delete process.env.AUTO_EXIT_ON_INVALID_TOKEN;
    delete process.env.DOCKER;
    delete process.env.RUNNING_IN_DOCKER;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('shouldAutoExitOnUnhealthy: false по умолчанию вне Docker', () => {
    expect(shouldAutoExitOnUnhealthy()).toBe(isDockerEnvironment());
  });

  it('shouldAutoExitOnUnhealthy: true при AUTO_EXIT_ON_UNHEALTHY=true', () => {
    process.env.AUTO_EXIT_ON_UNHEALTHY = 'true';
    expect(shouldAutoExitOnUnhealthy()).toBe(true);
  });

  it('shouldAutoExitOnUnhealthy: false при AUTO_EXIT_ON_UNHEALTHY=false', () => {
    process.env.AUTO_EXIT_ON_UNHEALTHY = 'false';
    expect(shouldAutoExitOnUnhealthy()).toBe(false);
  });

  it('shouldAutoExitOnInvalidToken: false при AUTO_EXIT_ON_INVALID_TOKEN=false', () => {
    process.env.AUTO_EXIT_ON_INVALID_TOKEN = 'false';
    expect(shouldAutoExitOnInvalidToken()).toBe(false);
  });

  it('isTransientNetworkErrorCode распознаёт ENOTFOUND', () => {
    expect(isTransientNetworkErrorCode('ENOTFOUND')).toBe(true);
    expect(isTransientNetworkErrorCode('INVALID_TOKEN')).toBe(false);
  });
});
