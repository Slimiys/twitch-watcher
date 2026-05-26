import { setupNetwork } from './setupNetwork';

setupNetwork();

import { registerProcessGuards } from './processGuards';

registerProcessGuards();

import * as fs from 'fs';
import { getAppVersionLabel, resetAppVersionLabelCache } from './appVersion';
import { clearAppUpdateCheckCache } from './web/appUpdateCheck';
import { writePidFile } from './pidFile';
import { logger } from './modes/api/logger';
import { writeCrashReport } from './processGuards';
import {
  ensureDashboardStarted,
  loadStreamersFromConfig,
  loadTokenFromConfig,
  tryStartWatcherIfNeeded,
} from './appRuntime';

// ========================================== CONFIG SECTION =================================================================
const configPath = './config.json';

let channelsWithPriority: string[] = loadStreamersFromConfig(configPath);

if (channelsWithPriority.length > 0) {
  console.log(`✅  Loaded ${channelsWithPriority.length} streamer(s) from config.json`);
} else if (fs.existsSync(configPath)) {
  console.log(`ℹ️  No streamers in config.json (you can add them via web interface)`);
} else {
  console.log(`ℹ️  config.json not found, will be created when saving settings`);
  console.log(`ℹ️  You can add streamers via web interface after application starts`);
}
// ========================================== CONFIG SECTION =================================================================

/**
 * Корректное завершение работы приложения
 */
async function shutDown(): Promise<void> {
  writeCrashReport('gracefulShutdown', { signal: 'SIGINT/SIGTERM' });
  console.log('\n👋Bye Bye👋');
  const watcher = (global as any).watcher as { stop?: () => void } | undefined;
  if (watcher?.stop) {
    try {
      watcher.stop();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`⚠️  Error during watcher shutdown: ${message}`);
    }
  }
  process.exit(0);
}

/**
 * Запускает API-режим: dashboard всегда; watcher — при наличии токена
 */
async function startAPIMode(): Promise<void> {
  await ensureDashboardStarted();

  const token = loadTokenFromConfig(configPath);
  if (!token) {
    console.log('ℹ️  Токен не задан — откройте dashboard → «Конфиг бота» и укажите auth-token');
    console.log('ℹ️  После сохранения бот запустится автоматически');
    return;
  }

  const result = await tryStartWatcherIfNeeded();
  if (!result.started) {
    console.error(`❌  ${result.message}`);
  }
}

/**
 * Главная функция приложения
 */
async function main(): Promise<void> {
  writePidFile();
  resetAppVersionLabelCache();
  clearAppUpdateCheckCache();
  const versionLabel = getAppVersionLabel();
  console.clear();
  console.log('=========================');
  console.log(`📦  Version: ${versionLabel}`);
  logger.info(`📦  Version: ${versionLabel}`);
  console.log('=========================');

  if (channelsWithPriority.length > 0) {
    console.log(`✅  Streamers configured: ${channelsWithPriority.join(', ')}`);
  } else {
    console.log(`ℹ️  No streamers in config.json - you can add them via web interface`);
  }
  console.log("=========================");
  
  logger.verbose(`🔍  Environment check:`);
  logger.verbose(`   VERSION: ${versionLabel}`);
  logger.verbose(`   MODE: API (only mode available)`);
  const logLevel = (process.env.LOG_LEVEL || 'verbose').toLowerCase();
  logger.verbose(`   LOG_LEVEL: "${logLevel}"`);
  logger.verbose(`=========================`);
  
  console.log('🔧  Mode: API (Channel Points Miner style)');
  console.log("=========================");
  await startAPIMode();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  writeCrashReport('startupFatal', {
    errorMessage: message,
    stack,
  });

  console.error('Fatal error during startup:', error);
  if (!(global as any).watcher) {
    process.exit(1);
  }
  logger.warn('⚠️  Startup error after partial init — watcher/web may still be running');
});

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
