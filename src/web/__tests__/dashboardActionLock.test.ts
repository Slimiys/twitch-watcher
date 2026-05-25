import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  getDashboardActionLockPath,
  writeDashboardActionLock,
  removeDashboardActionLock,
  isDashboardActionLockPresent,
} from '../dashboardActionLock';

describe('dashboardActionLock', () => {
  afterEach(() => {
    removeDashboardActionLock();
  });

  it('создаёт и удаляет lock-файл', () => {
    expect(isDashboardActionLockPresent()).toBe(false);
    writeDashboardActionLock();
    expect(isDashboardActionLockPresent()).toBe(true);
    expect(fs.existsSync(getDashboardActionLockPath())).toBe(true);
    removeDashboardActionLock();
    expect(isDashboardActionLockPresent()).toBe(false);
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
