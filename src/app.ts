import * as dotenv from 'dotenv';

// Загружаем переменные окружения явно
dotenv.config();
import * as fs from 'fs';
import * as path from 'path';
import { askLogin } from './input';
import { CookieData, LoginInput, AppConfig } from './types';
import { logger } from './modes/api/logger';

// ========================================== CONFIG SECTION =================================================================
const configPath = './config.json';
const channelsWithPriority = process.env.channelsWithPriority ? process.env.channelsWithPriority.split(",") : [];

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
      cookie[0].value = configFile.token;

      return cookie;
    } else if (process.env.token) {
      console.log('✅  Env config found');
      cookie[0].value = process.env.token;

      return cookie;
    } else {
      console.log('❌ No config file found!');

      const input: LoginInput = await askLogin();

      fs.writeFile(configPath, JSON.stringify(input), (err) => {
        if (err) {
          console.log(err);
        }
      });

      cookie[0].value = input.token;

      return cookie;
    }
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
  console.log("\n👋Bye Bye👋");
  process.exit(0);
}

/**
 * Запускает API-режим
 */
async function startAPIMode(): Promise<void> {
  const { StreamWatcher } = await import('./modes/api/StreamWatcher');
  const userAgent = process.env.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.108 Safari/537.36';
  
  cookie = await readLoginData();
  if (!cookie || !cookie[0] || !cookie[0].value) {
    console.error('❌ ERROR: No auth token found!');
    process.exit(1);
  }

  const authToken = cookie[0].value;
  const watcher = new StreamWatcher(authToken, userAgent, channelsWithPriority);
  
  try {
    await watcher.start();
    watcher.startStatusCheck();
  } catch (error: any) {
    console.error('❌ Error starting API mode:', error.message || error);
    process.exit(1);
  }
}

/**
 * Главная функция приложения
 */
async function main(): Promise<void> {
  console.clear();
  console.log("=========================");
  
  // Проверяем, что приоритетные каналы настроены
  if (channelsWithPriority.length === 0) {
    console.log('❌ ERROR: No priority channels configured!');
    console.log('💡 Please set channelsWithPriority in .env file');
    console.log('💡 Example: channelsWithPriority=alkaizerx,mathil1');
    process.exit(1);
  }
  
  console.log(`✅  Priority channels configured: ${channelsWithPriority.join(', ')}`);
  console.log("=========================");
  
  logger.verbose(`🔍  Environment check:`);
  logger.verbose(`   MODE: API (only mode available)`);
  const logLevel = (process.env.LOG_LEVEL || 'verbose').toLowerCase();
  logger.verbose(`   LOG_LEVEL: "${logLevel}"`);
  logger.verbose(`=========================`);
  
  console.log('🔧  Mode: API (Channel Points Miner style)');
  console.log("=========================");
  await startAPIMode();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
