import { describe, it, expect, afterEach, vi } from 'vitest';
import * as childProcess from 'child_process';
import {
  checkAppUpdateAvailable,
  clearAppUpdateCheckCache,
  revisionsMatch,
} from '../appUpdateCheck';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../appVersion', () => ({
  getAppVersionParts: () => ({ semver: '0.6.0', revision: 'aaa111bbb222', label: '0.6.0.aaa111bbb222' }),
}));

vi.mock('../../pidFile', () => ({
  getProjectRoot: () => '/proj',
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

describe('appUpdateCheck', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    clearAppUpdateCheckCache();
    vi.clearAllMocks();
  });

  it('revisionsMatch сравнивает короткие hash', () => {
    expect(revisionsMatch('a476fe20ce2b', 'a476fe20ce2b')).toBe(true);
    expect(revisionsMatch('a476fe2', 'a476fe20ce2b')).toBe(true);
    expect(revisionsMatch('abc', 'def')).toBe(false);
  });

  it('updateAvailable при разных ревизиях', () => {
    process.env.DASHBOARD_UPDATE_GIT_BRANCH = 'dev';
    const execFileSync = vi.mocked(childProcess.execFileSync);
    execFileSync.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        return 'bbb222ccc333ddd444eee555\trefs/heads/dev\n';
      }
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return 'bbb222ccc333\n';
      }
      return '';
    });

    const prev = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const result = checkAppUpdateAvailable(true);

    Object.defineProperty(process, 'platform', { value: prev });

    expect(result.updateAvailable).toBe(true);
    expect(result.remoteRevision).toBe('bbb222ccc333');
    expect(result.branch).toBe('dev');
  });

  it('updateAvailable false при совпадении', () => {
    const execFileSync = vi.mocked(childProcess.execFileSync);
    execFileSync.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        return 'aaa111bbb222cccddd444eee\trefs/heads/dev\n';
      }
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return 'aaa111bbb222\n';
      }
      return '';
    });

    const prev = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const result = checkAppUpdateAvailable(true);

    Object.defineProperty(process, 'platform', { value: prev });

    expect(result.updateAvailable).toBe(false);
  });
});
