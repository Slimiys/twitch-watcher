import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { buildAppUpdateStatus } from '../appUpdateStatus';
import { clearAppUpdateCheckCache } from '../appUpdateCheck';

vi.mock('../appUpdateCheck', async () => {
  const actual = await vi.importActual<typeof import('../appUpdateCheck')>('../appUpdateCheck');
  return {
    ...actual,
    checkAppUpdateAvailable: vi.fn(() => ({
      branch: 'dev',
      remote: 'origin',
      localRevision: 'aaa',
      remoteRevision: 'bbb',
      localRevisionFull: 'aaa',
      remoteRevisionFull: 'bbb',
      updateAvailable: true,
      checkStatus: 'available' as const,
      checkedAt: Date.now(),
      error: null,
      checkSkippedReason: null,
    })),
  };
});

vi.mock('../appUpdate', () => ({
  isDashboardUpdateEnabled: vi.fn(() => true),
  isDashboardUpdateInProgress: vi.fn(() => false),
  validateDashboardUpdateRequest: vi.fn(() => ({ ok: true as const })),
}));

describe('appUpdateStatus', () => {
  beforeEach(() => {
    clearAppUpdateCheckCache();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('возвращает uiState available при новой ревизии', () => {
    const status = buildAppUpdateStatus(true);
    expect(status.uiState).toBe('available');
    expect(status.indicatorLabel).toContain('Доступно');
    expect(status.dashboardUpdateCanTrigger).toBe(true);
  });
});
