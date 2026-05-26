/**
 * API настроек приложения для dashboard
 */

import { logger } from '../modes/api/logger';
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
export function applyAppSettingsApi(body: ApplyAppSettingsInput): ApplyAppSettingsResult {
  const result = applyAppSettingsFromInput(body);
  if (result.restartRequired) {
    logger.info(
      `⚙️  App settings saved; restart recommended: ${result.restartReasons.join(', ')}`
    );
  } else {
    logger.info('⚙️  App settings saved and applied');
  }
  return result;
}
