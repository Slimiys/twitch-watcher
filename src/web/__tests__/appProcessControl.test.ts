import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import {
  triggerDashboardStop,
  triggerDashboardRestart,
  validateDashboardControlRequest,
  resolveStopScriptPath,
  resolveRestartScriptPath,
  isDashboardUpdateEnabled,
} from '../appUpdate';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

describe('app process control', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    vi.clearAllMocks();
  });

  it('stop отклонён без DASHBOARD_UPDATE_ENABLED', () => {
    delete process.env.DASHBOARD_UPDATE_ENABLED;
    const result = triggerDashboardStop();
    expect(result.started).toBe(false);
  });

  it('restart отклонён на win32', () => {
    process.env.DASHBOARD_UPDATE_ENABLED = 'true';
    const prev = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const result = triggerDashboardRestart();
    Object.defineProperty(process, 'platform', { value: prev });
    expect(result.started).toBe(false);
  });

  it('скрипты stop/restart существуют в репозитории', () => {
    expect(fs.existsSync(resolveStopScriptPath())).toBe(true);
    expect(fs.existsSync(resolveRestartScriptPath())).toBe(true);
  });

  it('validate разрешает при linux и включённом флаге', () => {
    process.env.DASHBOARD_UPDATE_ENABLED = 'true';
    expect(isDashboardUpdateEnabled()).toBe(true);
    const prev = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const check = validateDashboardControlRequest(resolveRestartScriptPath());
    Object.defineProperty(process, 'platform', { value: prev });
    expect(check.ok).toBe(true);
  });
});
