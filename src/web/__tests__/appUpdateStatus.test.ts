import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
      remoteRevision: 'aaa',
      localRevisionFull: 'aaa',
      remoteRevisionFull: 'aaa',
      updateAvailable: false,
      checkStatus: 'current' as const,
      checkedAt: Date.now(),
      error: null,
      checkSkippedReason: null,
    })),
  };
});

vi.mock('../appUpdate', () => ({
  isDashboardUpdateEnabled: vi.fn(() => true),
  isDashboardUpdateInProgress: vi.fn(),
  validateDashboardUpdateRequest: vi.fn(() => ({ ok: true as const })),
}));

describe('appUpdateStatus', () => {
  beforeEach(() => {
    clearAppUpdateCheckCache();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('возвращает uiState current когда обновление не идёт', async () => {
    const appUpdate = await import('../appUpdate');
    vi.mocked(appUpdate.isDashboardUpdateInProgress).mockReturnValue(false);

    const status = buildAppUpdateStatus(true);
    expect(status.uiState).toBe('current');
    expect(status.indicatorLabel).toBe('Актуальная версия');
    expect(status.dashboardUpdateCanTrigger).toBe(true);
  });

  it('возвращает uiState updating пока идёт скрипт', async () => {
    const appUpdate = await import('../appUpdate');
    vi.mocked(appUpdate.isDashboardUpdateInProgress).mockReturnValue(true);

    const status = buildAppUpdateStatus(true);
    expect(status.uiState).toBe('updating');
    expect(status.indicatorLabel).toBe('Обновление…');
    expect(status.dashboardUpdateCanTrigger).toBe(false);
  });
});
