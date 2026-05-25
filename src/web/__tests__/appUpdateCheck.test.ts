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
  getAppVersionParts: () => ({
    semver: '0.6.0',
    revision: 'aaa111bbb222',
    label: '0.6.0.aaa111bbb222',
  }),
}));

vi.mock('../../pidFile', () => ({
  getProjectRoot: () => '/proj',
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

const LOCAL_FULL = 'aaa111bbb222cccddd444eee5555555555555555';
const REMOTE_FULL = 'bbb222ccc333ddd444eee555555555555555555';

describe('appUpdateCheck', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    clearAppUpdateCheckCache();
    vi.clearAllMocks();
  });

  it('revisionsMatch сравнивает полные и короткие hash', () => {
    expect(revisionsMatch(LOCAL_FULL, LOCAL_FULL)).toBe(true);
    expect(revisionsMatch('a476fe2', 'a476fe20ce2b')).toBe(true);
    expect(revisionsMatch('abc', 'def')).toBe(false);
  });

  it('updateAvailable при разных ревизиях', () => {
    process.env.DASHBOARD_UPDATE_GIT_BRANCH = 'dev';
    const execFileSync = vi.mocked(childProcess.execFileSync);
    execFileSync.mockImplementation((cmd, args) => {
      const argv = args ?? [];
      if (cmd === 'git' && argv[0] === 'ls-remote') {
        return `${REMOTE_FULL}\trefs/heads/dev\n`;
      }
      if (cmd === 'git' && argv[0] === 'rev-parse' && argv[1] === 'HEAD') {
        return LOCAL_FULL;
      }
      if (cmd === 'git' && argv[0] === 'rev-parse' && argv[1] === '--short=12') {
        return 'aaa111bbb222';
      }
      if (cmd === 'git' && argv[0] === 'rev-parse' && argv[1] === '--short=12' && argv[2]) {
        return 'bbb222ccc333';
      }
      return '';
    });

    const prev = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const result = checkAppUpdateAvailable(true);

    Object.defineProperty(process, 'platform', { value: prev });

    expect(result.updateAvailable).toBe(true);
    expect(result.checkStatus).toBe('available');
    expect(result.remoteRevisionFull).toBe(REMOTE_FULL);
    expect(result.branch).toBe('dev');
  });

  it('updateAvailable false при совпадении', () => {
    const execFileSync = vi.mocked(childProcess.execFileSync);
    execFileSync.mockImplementation((cmd, args) => {
      const argv = args ?? [];
      if (cmd === 'git' && argv[0] === 'ls-remote') {
        return `${LOCAL_FULL}\trefs/heads/dev\n`;
      }
      if (cmd === 'git' && argv[0] === 'rev-parse' && argv[1] === 'HEAD') {
        return LOCAL_FULL;
      }
      if (cmd === 'git' && argv[0] === 'rev-parse' && argv[1] === '--short=12') {
        return 'aaa111bbb222';
      }
      return '';
    });

    const prev = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const result = checkAppUpdateAvailable(true);

    Object.defineProperty(process, 'platform', { value: prev });

    expect(result.updateAvailable).toBe(false);
    expect(result.checkStatus).toBe('current');
  });
});
