import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
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
});
