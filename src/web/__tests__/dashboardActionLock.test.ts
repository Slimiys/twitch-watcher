import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Изолированный корень проекта для тестов (не пересекается с logs/ других тестов) */
let testProjectRoot = '';

vi.mock('../../pidFile', () => ({
  getProjectRoot: () => testProjectRoot,
}));

import {
  getDashboardActionLockPath,
  writeDashboardActionLock,
  removeDashboardActionLock,
  isDashboardActionLockPresent,
} from '../dashboardActionLock';

describe('dashboardActionLock', () => {
  beforeEach(() => {
    testProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-dash-lock-'));
  });

  afterEach(() => {
    removeDashboardActionLock();
    if (testProjectRoot && fs.existsSync(testProjectRoot)) {
      fs.rmSync(testProjectRoot, { recursive: true, force: true });
    }
    testProjectRoot = '';
  });

  it('создаёт и удаляет lock-файл', () => {
    expect(isDashboardActionLockPresent()).toBe(false);
    writeDashboardActionLock();
    const lockPath = getDashboardActionLockPath();
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(isDashboardActionLockPresent()).toBe(true);
    removeDashboardActionLock();
    expect(isDashboardActionLockPresent()).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('удаляет устаревший lock, если PID скрипта уже не существует', () => {
    const lockPath = getDashboardActionLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const oldTs = Math.floor((Date.now() - 120_000) / 1000);
    fs.writeFileSync(lockPath, `999999999 ${oldTs}\n`, 'utf8');
    expect(isDashboardActionLockPresent()).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
