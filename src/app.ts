import { setupNetwork } from './setupNetwork';

setupNetwork();

import { registerProcessGuards } from './processGuards';

registerProcessGuards();

import * as fs from 'fs';
import * as path from 'path';
import { askLogin } from './input';
import { CookieData, LoginInput, AppConfig } from './types';
import { getAppVersionLabel } from './appVersion';
import { writePidFile } from './pidFile';
import { logger } from './modes/api/logger';
import { writeCrashReport } from './processGuards';

// ========================================== CONFIG SECTION =================================================================
const configPath = './config.json';

// Загружаем список стримеров из config.json
let channelsWithPriority: string[] = [];

if (fs.existsSync(configPath)) {
  try {
    const configFile: AppConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (configFile.streamers && Array.isArray(configFile.streamers)) {
      channelsWithPriority = configFile.streamers;
      if (channelsWithPriority.length > 0) {
        console.log(`✅  Loaded ${channelsWithPriority.length} streamer(s) from config.json`);
      } else {
        console.log(`ℹ️  No streamers in config.json (you can add them via web interface)`);
      }
    } else {
      console.log(`ℹ️  No streamers array in config.json (you can add them via web interface)`);
    }
  } catch (error: any) {
    console.log(`⚠️  Failed to load streamers from config.json: ${error.message}`);
    console.log(`ℹ️  You can add streamers via web interface after application starts`);
  }
} else {
  console.log(`ℹ️  config.json not found, will be created on first run`);
  console.log(`ℹ️  You can add streamers via web interface after application starts`);
}

let cookie: CookieData[] | null = null;
// ========================================== CONFIG SECTION =================================================================

/**
 * Чтение данных для входа из конфигурационного файла или переменных окружения
 * @returns Массив cookie для авторизации
 */
async function readLoginData(): Promise<CookieData[]> {
  const cookie: CookieData[] = [{
    domain: ".twitch.tv",
    hostOnly: false,
    httpOnly: false,
    name: "auth-token",
    path: "/",
    sameSite: "no_restriction",
    secure: true,
    session: false,
    storeId: "0",
    id: 1,
    value: ""
  }];
  
  try {
    console.log('🔎  Checking config file...');

    if (fs.existsSync(configPath)) {
      console.log('✅  Json config found!');

      const configFile: AppConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (configFile.token) {
        cookie[0].value = configFile.token;
        return cookie;
      }
    }

    // Если токена нет в config.json, проверяем переменную окружения
    if (process.env.token) {
      console.log('✅  Token found in environment variable');
      cookie[0].value = process.env.token;
      return cookie;
    }

    // Если токена нет ни в config.json, ни в переменной окружения
    if (fs.existsSync(configPath)) {
      console.log('⚠️  Token not found in config.json, checking environment variable...');
    } else {
      console.log('❌ No config file found!');
    }

    // В Docker или неинтерактивном режиме не можем запросить токен
    if (process.env.NODE_ENV === 'production' || !process.stdin.isTTY) {
      throw new Error('Token not found in config.json or environment variable. Please set token in .env file or config.json');
    }

    const input: LoginInput = await askLogin();

    // Сохраняем токен в config.json
    let configFile: AppConfig = {};
    if (fs.existsSync(configPath)) {
      try {
        configFile = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (error) {
        // Игнорируем ошибки парсинга
      }
    }
    configFile.token = input.token;
    fs.writeFileSync(configPath, JSON.stringify(configFile, null, 2), 'utf8');

    cookie[0].value = input.token;
    return cookie;
  } catch (err) {
    console.log('🤬 Error: ', err);
    console.log('Please visit my discord channel to solve this problem: https://discord.gg/s8AH4aZ');
    throw err;
  }
}

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
 * Запускает API-режим
 */
async function startAPIMode(): Promise<void> {
  const { StreamWatcher } = await import('./modes/api/StreamWatcher');
  const { WebServer } = await import('./web/WebServer');
  const userAgent = process.env.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.108 Safari/537.36';
  
  cookie = await readLoginData();
  if (!cookie || !cookie[0] || !cookie[0].value) {
    console.error('❌ ERROR: No auth token found!');
    console.error('💡 Please set token in .env file or config.json');
    console.error('💡 The web interface will be available, but the watcher will not start');
    
    // Запускаем веб-сервер даже без токена, чтобы показать ошибку в интерфейсе
    const webPort = process.env.WEB_SERVER_PORT ? parseInt(process.env.WEB_SERVER_PORT, 10) : 3001;
    const webServer = new WebServer(webPort);
    await webServer.startUntilSuccess();
    console.log(`✅  Web server started on port ${webPort} (watcher disabled - no token)`);
    
    // Не выходим из процесса, чтобы веб-сервер продолжал работать
    return;
  }

  const authToken = cookie[0].value;
  const watcher = new StreamWatcher(authToken, userAgent, channelsWithPriority);
  
  // Сохраняем ссылку на watcher для graceful shutdown
  (global as any).watcher = watcher;
  
  try {
    await watcher.start();
  } catch (error: any) {
    console.error('❌ Error starting API mode:', error.message || error);
    // Не выходим из процесса, чтобы веб-сервер продолжал работать
    // process.exit(1);
  }
}

/**
 * Главная функция приложения
 */
async function main(): Promise<void> {
  writePidFile();
  const versionLabel = getAppVersionLabel();
  console.clear();
  console.log('=========================');
  console.log(`📦  Version: ${versionLabel}`);
  logger.info(`📦  Version: ${versionLabel}`);
  console.log('=========================');

  // Информируем о количестве загруженных стримеров
  if (channelsWithPriority.length > 0) {
    console.log(`✅  Streamers configured: ${channelsWithPriority.join(', ')}`);
  } else {
    console.log(`ℹ️  No streamers in config.json - you can add them via web interface at http://localhost:3001`);
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
