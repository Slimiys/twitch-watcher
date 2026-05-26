/**
 * Общий веб-сервер и запуск watcher (без интерактивного ввода в консоли)
 */

import * as fs from 'fs';
import { AppConfig } from './types';
import { readAppConfigFile } from './modes/api/appSettings';
import { WebServer } from './web/WebServer';
import { logger } from './modes/api/logger';

const CONFIG_PATH = './config.json';

let sharedWebServer: WebServer | null = null;
let watcherStartInProgress = false;

/**
 * Возвращает общий экземпляр dashboard
 */
export function getSharedWebServer(): WebServer | null {
  return sharedWebServer;
}

/**
 * Читает токен из config.json
 */
export function loadTokenFromConfig(configPath: string = CONFIG_PATH): string | null {
  const config = readAppConfigFile(configPath);
  const token = config.token?.trim();
  return token || null;
}

/**
 * Читает список стримеров из config.json
 */
export function loadStreamersFromConfig(configPath: string = CONFIG_PATH): string[] {
  if (!fs.existsSync(configPath)) {
    return [];
  }
  try {
    const config: AppConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.streamers && Array.isArray(config.streamers)) {
      return config.streamers;
    }
  } catch {
    // игнорируем
  }
  return [];
}

/**
 * Запускает dashboard (один раз на процесс)
 */
export async function ensureDashboardStarted(): Promise<WebServer> {
  const port = process.env.WEB_SERVER_PORT ? parseInt(process.env.WEB_SERVER_PORT, 10) : 3001;

  if (!sharedWebServer) {
    sharedWebServer = new WebServer(port);
  }

  if (!sharedWebServer.isRunning()) {
    await sharedWebServer.startUntilSuccess();
    const scheme = process.env.WEB_SERVER_HTTPS === 'true' ? 'https' : 'http';
    console.log(`✅  Dashboard: ${scheme}://localhost:${port}`);
    logger.info(`✅  Dashboard listening on port ${port}`);
  }

  return sharedWebServer;
}

export interface WatcherStartResult {
  started: boolean;
  message: string;
}

/**
 * Запускает watcher, если есть токен и он ещё не запущен
 */
export async function tryStartWatcherIfNeeded(): Promise<WatcherStartResult> {
  if ((global as { watcher?: { start?: () => Promise<void> } }).watcher) {
    return { started: false, message: 'Watcher уже запущен' };
  }

  if (watcherStartInProgress) {
    return { started: false, message: 'Запуск watcher уже выполняется' };
  }

  const token = loadTokenFromConfig();
  if (!token) {
    return {
      started: false,
      message: 'Токен не задан. Откройте dashboard → «Конфиг бота» и укажите auth-token.',
    };
  }

  watcherStartInProgress = true;
  try {
    const webServer = await ensureDashboardStarted();
    const userAgent =
      process.env.userAgent ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.108 Safari/537.36';
    const channels = loadStreamersFromConfig();

    const { StreamWatcher } = await import('./modes/api/StreamWatcher');
    const watcher = new StreamWatcher(token, userAgent, channels, undefined, webServer);
    (global as { watcher?: unknown }).watcher = watcher;

    await watcher.start();
    console.log('✅  Watcher started after configuration');
    return { started: true, message: 'Бот запущен' };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`❌  Failed to start watcher: ${message}`);
    (global as { watcher?: unknown }).watcher = undefined;
    return { started: false, message: `Не удалось запустить бота: ${message}` };
  } finally {
    watcherStartInProgress = false;
  }
}
