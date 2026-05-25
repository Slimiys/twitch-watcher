import { describe, it, expect, afterEach } from 'vitest';
import {
  isDashboardUpdateEnabled,
  validateDashboardUpdateRequest,
} from '../appUpdate';

describe('appUpdate', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('отключено без DASHBOARD_UPDATE_ENABLED', () => {
    delete process.env.DASHBOARD_UPDATE_ENABLED;
    expect(isDashboardUpdateEnabled()).toBe(false);
    const check = validateDashboardUpdateRequest();
    expect(check.ok).toBe(false);
  });

  it('требует API-ключ при включённом обновлении', () => {
    process.env.DASHBOARD_UPDATE_ENABLED = 'true';
    delete process.env.WEB_DASHBOARD_API_KEY;
    const check = validateDashboardUpdateRequest();
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.error).toContain('WEB_DASHBOARD_API_KEY');
    }
  });
});
