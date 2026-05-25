/**
 * Единый статус обновления для dashboard (проверка + возможность запуска)
 */

import { checkAppUpdateAvailable, AppUpdateCheckResult } from './appUpdateCheck';
import {
  isDashboardUpdateEnabled,
  isDashboardUpdateInProgress,
  validateDashboardUpdateRequest,
} from './appUpdate';

/** Состояние для UI карточки «Версия» */
export type AppUpdateUiState =
  | 'checking'
  | 'current'
  | 'available'
  | 'updating'
  | 'error'
  | 'unavailable';

/** Полный статус обновления для API и dashboard */
export interface AppUpdateStatus extends AppUpdateCheckResult {
  uiState: AppUpdateUiState;
  indicatorLabel: string;
  dashboardUpdateEnabled: boolean;
  dashboardUpdateCanTrigger: boolean;
  dashboardUpdateBlockedReason: string | null;
  dashboardUpdateInProgress: boolean;
}

/**
 * Собирает статус обновления (ветка dev на remote, сравнение с локальным HEAD)
 */
export function buildAppUpdateStatus(forceRefresh = false): AppUpdateStatus {
  const dashboardUpdateEnabled = isDashboardUpdateEnabled();
  const dashboardUpdateInProgress = isDashboardUpdateInProgress();
  const triggerCheck = validateDashboardUpdateRequest();
  const dashboardUpdateCanTrigger = triggerCheck.ok;
  const dashboardUpdateBlockedReason = triggerCheck.ok ? null : triggerCheck.error;

  if (dashboardUpdateInProgress) {
    const check = checkAppUpdateAvailable(forceRefresh);
    return {
      ...check,
      uiState: 'updating',
      indicatorLabel: 'Обновление…',
      dashboardUpdateEnabled,
      dashboardUpdateCanTrigger: false,
      dashboardUpdateBlockedReason: 'Обновление уже выполняется',
      dashboardUpdateInProgress: true,
    };
  }

  const check = checkAppUpdateAvailable(forceRefresh);
  const uiState = resolveUiState(check);
  const indicatorLabel = resolveIndicatorLabel(check, uiState);

  return {
    ...check,
    uiState,
    indicatorLabel,
    dashboardUpdateEnabled,
    dashboardUpdateCanTrigger,
    dashboardUpdateBlockedReason,
    dashboardUpdateInProgress: false,
  };
}

function resolveUiState(check: AppUpdateCheckResult): AppUpdateUiState {
  if (check.checkSkippedReason) {
    return 'unavailable';
  }
  if (check.error) {
    return 'error';
  }
  if (check.updateAvailable) {
    return 'available';
  }
  return 'current';
}

function resolveIndicatorLabel(check: AppUpdateCheckResult, uiState: AppUpdateUiState): string {
  switch (uiState) {
    case 'available':
      return check.remoteRevision
        ? `Доступно: ${check.remoteRevision}`
        : 'Доступно обновление';
    case 'current':
      return 'Актуальная версия';
    case 'error':
      return 'Ошибка проверки';
    case 'unavailable':
      return check.checkSkippedReason || 'Проверка недоступна';
    default:
      return '—';
  }
}
