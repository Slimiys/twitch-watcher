/**
 * API настроек приложения для dashboard
 */

import { loadTokenFromConfig, tryStartWatcherIfNeeded } from '../appRuntime';
import { logger, reloadLoggerFromAppSettings } from '../modes/api/logger';
import {
  applyAppSettingsFromInput,
  ApplyAppSettingsInput,
  ApplyAppSettingsResult,
  readAppSettingsForApi,
  AppSettingsApiSnapshot,
} from '../modes/api/appSettings';

/**
 * GET /api/app-settings
 */
export function readAppSettingsApi(): AppSettingsApiSnapshot {
  return readAppSettingsForApi();
}

/**
 * POST /api/app-settings
 */
export async function applyAppSettingsApi(
  body: ApplyAppSettingsInput
): Promise<ApplyAppSettingsResult & { watcherStarted?: boolean; watcherMessage?: string }> {
  const hadTokenBefore = Boolean(loadTokenFromConfig());
  const result = applyAppSettingsFromInput(body);
  reloadLoggerFromAppSettings();

  let watcherStarted: boolean | undefined;
  let watcherMessage: string | undefined;

  const tokenProvided =
    body.token !== undefined &&
    body.token !== null &&
    String(body.token).trim().length > 0 &&
    !String(body.token).startsWith('••••');

  if (tokenProvided || (!hadTokenBefore && result.tokenSet)) {
    const start = await tryStartWatcherIfNeeded();
    watcherStarted = start.started;
    watcherMessage = start.message;
    if (start.started) {
      result.restartReasons = result.restartReasons.filter((k) => k !== 'token');
      result.restartRequired = result.restartReasons.length > 0;
      result.message = result.restartRequired
        ? 'Настройки сохранены. Бот запущен; для части параметров нужен перезапуск.'
        : 'Настройки сохранены. Бот запущен.';
    } else if (!hadTokenBefore && result.tokenSet) {
      result.message = `${result.message} ${start.message}`;
    }
  }

  if (result.restartRequired) {
    logger.info(
      `⚙️  App settings saved; restart recommended: ${result.restartReasons.join(', ')}`
    );
  } else {
    logger.info('⚙️  App settings saved and applied');
  }

  return { ...result, watcherStarted, watcherMessage };
}
