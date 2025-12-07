import * as dotenv from 'dotenv';

// Загружаем переменные окружения явно
dotenv.config();
import puppeteer, { Browser, Page, LaunchOptions } from 'puppeteer-core';
import dayjs from 'dayjs';
import cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { askLogin } from './input';
import treekill from 'tree-kill';
import { CookieData, BrowserSpawn, LoginInput, DayjsUnit, AppConfig } from './types';
import { logger } from './modes/api/logger';

// ========================================== CONFIG SECTION =================================================================
const configPath = './config.json';
// Используем абсолютный путь для папки скриншотов
const screenshotFolder = path.join(process.cwd(), 'screenshots');
const baseUrl = 'https://www.twitch.tv/';
const userAgent = (process.env.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.108 Safari/537.36');

// Время просмотра больше не используется - просмотр продолжается бесконечно

const channelsWithPriority = process.env.channelsWithPriority ? process.env.channelsWithPriority.split(",") : [];

const showBrowser = false; // false state equ headless mode;
const proxy = (process.env.proxy || ""); // "ip:port" By https://github.com/Jan710
const proxyAuth = (process.env.proxyAuth || "");

// Проверяем опцию скриншотов (поддерживаем разные форматы)
// Функция для проверки опции скриншотов (вызывается динамически)
function getBrowserScreenshot(): boolean {
  const value = process.env.browserScreenshot;
  return (
    value === 'true' || 
    value === '1' ||
    value === 'True' ||
    value === 'TRUE'
  );
}

// Проверяем опцию скриншотов (поддерживаем разные форматы)
const browserScreenshot = getBrowserScreenshot();

// Состояние опции скриншотов будет логироваться в функции main()

// Интервал для периодических скриншотов (в секундах, 0 = отключено)
const screenshotInterval = Number(process.env.screenshotInterval) || 0;

const browserClean = 1;
const browserCleanUnit: DayjsUnit = 'hour';

let run = true;
let firstRun = true;
let cookie: CookieData[] | null = null;
let priorityChannelIndex = 0; // Индекс текущего приоритетного канала для ротации
let streamers: string[] | null = null;

// Map для отслеживания активных просмотров: стример -> { page, startTime }
interface ActiveWatch {
  page: Page;
  startTime: number; // Время начала просмотра (когда стример перешел из офлайн в онлайн)
  initialChannelPoints: string | null; // Начальное количество баллов при старте просмотра
  lastChannelPoints: string | null; // Последние известные баллы канала
}
const activeWatches = new Map<string, ActiveWatch>();

let browserConfig: LaunchOptions = {
  headless: !showBrowser,
  args: [
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-setuid-sandbox'
  ]
};

// Добавляем явный аргумент --headless для headless режима
if (!showBrowser) {
  if (browserConfig.args) {
    browserConfig.args.push('--headless');
  }
}

const cookiePolicyQuery = 'button[data-a-target="consent-banner-accept"]';
const matureContentQuery = 'button[data-a-target="player-overlay-mature-accept"]';
const sidebarQuery = '*[data-test-selector="user-menu__toggle"]';
// Селектор для кнопки получения бонусов канала (из twitch_collect.js)
// Основной селектор: .community-points-summary > *:nth-child(2) button
const channelPointsBonusSelector = '.community-points-summary > *:nth-child(2) button';
// Альтернативные селекторы для статуса аккаунта/стрима
const userStatusQueries = [
  // Селекторы для статуса стрима (ON AIR / В ЭФИРЕ)
  '.tw-channel-status-text-indicator',
  'div.tw-channel-status-text-indicator',
  '[class*="channel-status-text-indicator"]',
  '[class*="ChannelStatusTextIndicator"]',
  'span.CoreText-sc-1txzju1-0', // Внутренний span с текстом
  // Старые селекторы для статуса аккаунта
  'span[data-a-target="presence-text"]',
  '[data-a-target="presence-text"]',
  'span[class*="presence"]',
  '[class*="presence-text"]',
  '[class*="PresenceText"]',
  'div[class*="presence"]',
  'span[title*="Online"]',
  'span[title*="Offline"]',
  'span[title*="Away"]'
];
// Селекторы для баллов канала (несколько вариантов на случай изменения интерфейса)
const channelPointsSelectors = [
  '[data-test-selector="copo-balance-string"]', // Основной селектор для баллов канала Twitch
  '[data-a-target="channel-points"]',
  '[data-test-selector="channel-points"]',
  '.channel-points',
  '[class*="channel-points"]',
  '[class*="ChannelPoints"]',
  '[class*="AnimatedNumber"]', // Для элементов типа ScAnimatedNumber-sc-1 iib0w9-0
  '[class*="animated-number"]',
  'button[aria-label*="points" i]',
  'div[class*="points"]',
  'span[class*="Number"]' // Для span элементов с числами
];
// Обновленный селектор для поиска каналов стримеров на Twitch
// Пробуем несколько вариантов, начиная с наиболее специфичных
const channelsQuery = '[data-a-target="directory-channel-card"] a, a[data-a-target="preview-card-image-link"], a[href^="/"][href!="/"][href!="/directory"][href!="/p"][href!="/videos"][href!="/clips"]';
const streamPauseQuery = 'button[data-a-target="player-play-pause-button"]';
const streamSettingsQuery = '[data-a-target="player-settings-button"]';
const streamQualitySettingQuery = '[data-a-target="player-settings-menu-item-quality"]';
const streamQualityQuery = 'input[data-a-target="tw-radio"]';
// ========================================== CONFIG SECTION =================================================================

/**
 * Просмотр одного стримера в отдельной странице
 * @param browser Экземпляр браузера
 * @param streamerName Имя стримера
 * @returns Promise, который завершается когда просмотр закончен или стример офлайн
 */
async function watchStreamer(browser: Browser, streamerName: string): Promise<void> {
  const page = await createPage(browser);
  const watch = streamerName;
  
  try {
    console.log(`\n🔗 [${watch}] Starting watch...`);

      await page.goto(baseUrl + watch, {
        waitUntil: "networkidle0"
      }); // https://github.com/puppeteer/puppeteer/blob/master/docs/api.md#pagegobackoptions

      await clickWhenExist(page, cookiePolicyQuery);
      await clickWhenExist(page, matureContentQuery); // Click on accept button
      
      // Дополнительная проверка: убеждаемся, что стример действительно онлайн перед началом просмотра
      console.log(`🔍 Verifying ${watch} is still online...`);
      await page.waitFor(3000); // Даем время на полную загрузку страницы
      
      // Делаем несколько попыток проверки (иногда страница загружается медленно)
      // Первая попытка с детальным логированием, остальные без
      let isStillOnline = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        isStillOnline = await isStreamerOnline(page, attempt === 0);
        if (isStillOnline) {
          break;
        }
        if (attempt < 2) {
          console.log(`   Attempt ${attempt + 1} failed, waiting 2 seconds...`);
          await page.waitFor(2000);
        }
      }
      
      if (!isStillOnline) {
        console.log(`⚠️ [${watch}] is OFFLINE. Stopping watch.`);
        await page.close();
        return; // Прекращаем просмотр этого стримера
      }
      
      console.log(`✅ [${watch}] Verified: ONLINE. Starting watch...`);

      // Делаем скриншот сразу после загрузки страницы стримера
      const shouldScreenshot = getBrowserScreenshot();
      
      if (shouldScreenshot) {
        await page.waitFor(2000); // Даем время на полную загрузку страницы
        
        // Создаем папку для скриншотов, если её нет
        try {
          await fs.promises.access(screenshotFolder);
        } catch (error) {
          // Папка не существует, создаем её
          try {
            await fs.promises.mkdir(screenshotFolder, { recursive: true });
          } catch (mkdirError: any) {
            // Не бросаем ошибку, продолжаем работу
          }
        }
        
        const screenshotPath = path.join(screenshotFolder, `${watch}.png`);
        try {
          await page.screenshot({
            path: screenshotPath
          });
          
          // Очищаем старые скриншоты
          await cleanupOldScreenshots(10);
        } catch (screenshotError: any) {
          // Игнорируем ошибки сохранения скриншотов
        }
      }

      // Настройка разрешения (только один раз для каждого стримера)
      console.log(`🔧 [${watch}] Setting lowest possible resolution..`);
        try {
          await clickWhenExist(page, streamPauseQuery);
          await clickWhenExist(page, streamSettingsQuery);
          try {
            await Promise.race([
              page.waitForSelector(streamQualitySettingQuery),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Quality setting selector timeout')), 10000))
            ]);
          } catch (timeoutError: any) {
            throw new Error('Quality setting selector timeout');
          }
          await clickWhenExist(page, streamQualitySettingQuery);
          try {
            await Promise.race([
              page.waitForSelector(streamQualityQuery),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Quality options timeout')), 10000))
            ]);
          } catch (timeoutError: any) {
            throw new Error('Quality options timeout');
          }
          const resolution = await queryOnWebsite(page, streamQualityQuery);
          if (resolution.length === 0) {
            throw new Error('No resolution options found');
          }
          const resolutionId = resolution[resolution.length - 1].attribs.id;
          await page.evaluate((resolutionId: string) => {
            const element = document.getElementById(resolutionId);
            if (element) {
              element.click();
            }
          }, resolutionId);
          await clickWhenExist(page, streamPauseQuery);
          await page.keyboard.press('m'); // For unmute
          console.log('✅ Resolution settings completed');
        } catch (resolutionError: any) {
          // Игнорируем ошибки настройки разрешения
        }
      
      // Убеждаемся, что видео воспроизводится (не на паузе)
      console.log(`▶️ [${watch}] Ensuring video is playing...`);
      try {
        // Проверяем, не на паузе ли видео, и запускаем если нужно
        const isPaused = await page.evaluate(() => {
          const video = document.querySelector('video');
          if (video) {
            return video.paused;
          }
          return false;
        });
        
        if (isPaused) {
          console.log('⏸️ Video is paused, trying to play...');
          await clickWhenExist(page, streamPauseQuery);
          await page.waitFor(1000);
        }
        
        // Убеждаемся, что видео играет
        await page.evaluate(() => {
          const video = document.querySelector('video') as HTMLVideoElement;
          if (video && video.paused) {
            video.play().catch(() => {
              // Игнорируем ошибки автоплея
            });
          }
        });
        
        console.log('✅ Video playback ensured');
      } catch (playError: any) {
        console.log('⚠️ Could not ensure video playback:', playError.message || playError);
      }

      await clickWhenExist(page, sidebarQuery); // Open sidebar
      try {
        // Ждем немного, чтобы сайдбар успел открыться
        await page.waitFor(2000);
      } catch (timeoutError: any) {
        // Игнорируем ошибки
      }
      
      // Получаем статус аккаунта через JavaScript, пробуя все возможные селекторы
      const result = await page.evaluate((selectors: string[]) => {
        const results: any = {
          status: null,
          foundElements: []
        };
        
        // Пробуем каждый селектор
        for (const selector of selectors) {
          try {
            const element = document.querySelector(selector);
            if (element) {
              const text = element.textContent || '';
              const title = element.getAttribute('title') || '';
              const dataTarget = element.getAttribute('data-a-target') || '';
              const dataTest = element.getAttribute('data-test-selector') || '';
              const className = element.className || '';
              
              results.foundElements.push({
                selector: selector,
                text: text.trim(),
                title: title,
                dataTarget: dataTarget,
                dataTest: dataTest,
                className: className,
                tagName: element.tagName
              });
              
              if (text.trim()) {
                results.status = text.trim();
                return results;
              }
              if (title.trim()) {
                results.status = title.trim();
                return results;
              }
            }
          } catch (e) {
            // Продолжаем поиск
          }
        }
        
        // Альтернативный поиск: ищем элементы, содержащие ключевые слова
        const keywords = [
          'В ЭФИРЕ', 'ON AIR', 'LIVE', 'LIVE NOW',
          'Online', 'Offline', 'Away', 'Idle',
          'Онлайн', 'Офлайн', 'Не в сети'
        ];
        const allElements = document.querySelectorAll('span, div, p');
        for (const element of Array.from(allElements)) {
          const text = element.textContent || '';
          for (const keyword of keywords) {
            if (text.includes(keyword) && text.trim().length < 50) {
              const className = (element as HTMLElement).className || '';
              const dataTarget = element.getAttribute('data-a-target') || '';
              const dataTest = element.getAttribute('data-test-selector') || '';
              
              // Проверяем, не является ли это элементом статуса стрима
              if (className.includes('channel-status') || className.includes('status-text-indicator')) {
                results.foundElements.push({
                  selector: 'found-by-keyword-channel-status',
                  text: text.trim(),
                  className: className,
                  dataTarget: dataTarget,
                  dataTest: dataTest,
                  tagName: element.tagName
                });
                
                if (!results.status) {
                  results.status = text.trim();
                }
              } else {
                results.foundElements.push({
                  selector: 'found-by-keyword',
                  text: text.trim(),
                  className: className,
                  dataTarget: dataTarget,
                  dataTest: dataTest,
                  tagName: element.tagName
                });
                
                if (!results.status) {
                  results.status = text.trim();
                }
              }
            }
          }
        }
        
        // Дополнительный поиск: ищем элемент с классом tw-channel-status-text-indicator
        const statusIndicator = document.querySelector('.tw-channel-status-text-indicator');
        if (statusIndicator) {
          const text = statusIndicator.textContent || '';
          if (text.trim() && !results.status) {
            results.status = text.trim();
            results.foundElements.push({
              selector: '.tw-channel-status-text-indicator',
              text: text.trim(),
              className: statusIndicator.className || '',
              dataTarget: statusIndicator.getAttribute('data-a-target') || '',
              dataTest: statusIndicator.getAttribute('data-test-selector') || '',
              tagName: statusIndicator.tagName
            });
          }
        }
        
        return results;
      }, userStatusQueries);
      
      await clickWhenExist(page, sidebarQuery); // Close sidebar

      if (result.status) {
        console.log(`💡 [${watch}] Account status:`, result.status);
      } else {
        console.log(`💡 [${watch}] Account status: Not available`);
        console.log('🔍 Debug: Found elements in sidebar:');
        if (result.foundElements && result.foundElements.length > 0) {
          result.foundElements.slice(0, 10).forEach((elem: any, index: number) => {
            console.log(`   ${index + 1}. Selector: ${elem.selector}`);
            console.log(`      Text: "${elem.text}"`);
            console.log(`      Class: "${elem.className}"`);
            console.log(`      data-a-target: "${elem.dataTarget}"`);
            console.log(`      data-test-selector: "${elem.dataTest}"`);
            console.log(`      Tag: ${elem.tagName}`);
            console.log('');
          });
        } else {
          console.log('   No elements found. Try inspecting the page manually.');
        }
      }
      
      // Получаем количество баллов канала
      const channelPoints = await getChannelPoints(page);
      if (channelPoints) {
        console.log(`💰 [${watch}] Channel points: ${channelPoints}`);
      } else {
        console.log(`💰 [${watch}] Channel points: Not found (may not be available)`);
      }
      
      console.log(`🕒 [${watch}] Time: ${dayjs().format('HH:mm:ss')}`);
      console.log(`💤 [${watch}] Watching stream indefinitely...`);
      
      // Сохраняем информацию о просмотре
      // startTime устанавливается при переходе из офлайн в онлайн (не сбрасывается при перезагрузке)
      const existingWatch = activeWatches.get(watch);
      if (existingWatch) {
        // Если просмотр уже существует (перезагрузка страницы), сохраняем существующие startTime и initialChannelPoints
        existingWatch.page = page;
        existingWatch.lastChannelPoints = channelPoints;
        // Не обновляем startTime и initialChannelPoints - они должны остаться с момента начала просмотра
      } else {
        // Новый просмотр - устанавливаем startTime и initialChannelPoints
        activeWatches.set(watch, { 
          page, 
          startTime: Date.now(), 
          initialChannelPoints: channelPoints, // Начальные баллы при старте просмотра
          lastChannelPoints: channelPoints 
        });
      }

      // Периодические скриншоты во время просмотра
      const shouldScreenshotForPeriodic = getBrowserScreenshot();
      
      if (shouldScreenshotForPeriodic && screenshotInterval > 0) {
        await watchWithPeriodicScreenshots(page, watch, screenshotInterval, channelPoints);
      } else {
        // Простое ожидание с проверкой баллов канала
        await watchWithChannelPointsCheck(page, watch, channelPoints);
      }
      
      // Просмотр завершен
      console.log(`✅ [${watch}] Watch completed`);
      activeWatches.delete(watch);
      await page.close();
    } catch (e) {
      // Если стример стал оффлайн, прекращаем просмотр
      if (e instanceof StreamerOfflineError) {
        console.log(`🔄 [${watch}] ${e.message}. Stopping watch.`);
        activeWatches.delete(watch);
        await page.close();
        return;
      }
      
      console.log(`🤬 [${watch}] Error:`, e);
      activeWatches.delete(watch);
      await page.close();
      // Не бросаем ошибку дальше, чтобы не прерывать другие просмотры
    }
}

/**
 * Управление параллельными просмотрами стримеров
 * @param browser Экземпляр браузера
 * @param checkPage Страница для проверки онлайн статуса
 */
export async function manageParallelWatches(browser: Browser, checkPage: Page): Promise<void> {
  const checkInterval = 30000; // Проверка каждые 30 секунд
  
  while (run) {
    try {
      console.log(`\n🔍 Checking priority channels: ${channelsWithPriority.join(', ')}`);
      
      // Выводим детальную статистику по активным просмотрам
      if (activeWatches.size > 0) {
        console.log(`📊 Currently watching (${activeWatches.size}):`);
        for (const [streamerName, watchInfo] of activeWatches.entries()) {
          const elapsed = Date.now() - watchInfo.startTime;
          const elapsedMinutes = Math.floor(elapsed / 60000);
          const elapsedSeconds = Math.floor((elapsed % 60000) / 1000);
          
          // Пытаемся получить баллы канала и статус (без блокировки)
          let channelPointsDisplay = 'N/A';
          let pointsEarned = 'N/A';
          let status = 'ONLINE';
          
          try {
            // Получаем баллы канала
            const currentPoints = await getChannelPoints(watchInfo.page);
            if (currentPoints) {
              // Вычисляем количество заработанных баллов с начала просмотра
              if (watchInfo.initialChannelPoints) {
                const initial = parseInt(watchInfo.initialChannelPoints, 10);
                const current = parseInt(currentPoints, 10);
                if (!isNaN(initial) && !isNaN(current)) {
                  const earned = current - initial;
                  if (earned > 0) {
                    pointsEarned = `+${earned}`;
                  } else if (earned < 0) {
                    pointsEarned = `${earned}`;
                  } else {
                    pointsEarned = '0';
                  }
                }
              }
              
              // Обновляем баллы в структуре просмотра
              if (watchInfo.lastChannelPoints && watchInfo.lastChannelPoints !== currentPoints) {
                // Баллы изменились - показываем изменение
                channelPointsDisplay = `${watchInfo.lastChannelPoints} → ${currentPoints}`;
                watchInfo.lastChannelPoints = currentPoints;
              } else if (watchInfo.lastChannelPoints === null) {
                // Первый раз получаем баллы
                channelPointsDisplay = currentPoints;
                watchInfo.lastChannelPoints = currentPoints;
                // Если начальные баллы еще не установлены, устанавливаем их
                if (!watchInfo.initialChannelPoints) {
                  watchInfo.initialChannelPoints = currentPoints;
                  pointsEarned = '0';
                }
              } else {
                // Баллы не изменились
                channelPointsDisplay = currentPoints;
              }
            } else if (watchInfo.lastChannelPoints) {
              // Не удалось получить текущие баллы, но есть предыдущие
              channelPointsDisplay = watchInfo.lastChannelPoints;
              // Вычисляем заработанные баллы на основе последних известных
              if (watchInfo.initialChannelPoints) {
                const initial = parseInt(watchInfo.initialChannelPoints, 10);
                const current = parseInt(watchInfo.lastChannelPoints, 10);
                if (!isNaN(initial) && !isNaN(current)) {
                  const earned = current - initial;
                  if (earned > 0) {
                    pointsEarned = `+${earned}`;
                  } else if (earned < 0) {
                    pointsEarned = `${earned}`;
                  } else {
                    pointsEarned = '0';
                  }
                }
              }
            }
            
            // Проверяем статус стримера
            const isLive = await isStreamerOnline(watchInfo.page, false);
            status = isLive ? 'ONLINE ✅' : 'OFFLINE ❌';
          } catch (error) {
            // Игнорируем ошибки получения статистики
            // Используем последние известные баллы, если есть
            if (watchInfo.lastChannelPoints) {
              channelPointsDisplay = watchInfo.lastChannelPoints;
              // Вычисляем заработанные баллы на основе последних известных
              if (watchInfo.initialChannelPoints) {
                const initial = parseInt(watchInfo.initialChannelPoints, 10);
                const current = parseInt(watchInfo.lastChannelPoints, 10);
                if (!isNaN(initial) && !isNaN(current)) {
                  const earned = current - initial;
                  if (earned > 0) {
                    pointsEarned = `+${earned}`;
                  } else if (earned < 0) {
                    pointsEarned = `${earned}`;
                  } else {
                    pointsEarned = '0';
                  }
                }
              }
            }
          }
          
          console.log(`   • ${streamerName}: ${elapsedMinutes}m ${elapsedSeconds}s | Points: ${channelPointsDisplay} | Earned: ${pointsEarned} | Status: ${status}`);
        }
      } else {
        console.log(`📊 Currently watching: none`);
      }
      
      // Проверяем всех приоритетных стримеров
      for (const channelName of channelsWithPriority) {
        const channelNameTrimmed = channelName.trim();
        if (!channelNameTrimmed) continue;
        
        // Пропускаем, если уже просматриваем
        if (activeWatches.has(channelNameTrimmed)) {
          continue;
        }
        
        // Проверяем, онлайн ли стример
        try {
          const channelUrl = baseUrl + channelNameTrimmed;
          await Promise.race([
            checkPage.goto(channelUrl, { waitUntil: "networkidle0" }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Page load timeout')), 30000))
          ]).catch(() => {});
          
          await checkPage.waitFor(3000);
          const isLive = await isStreamerOnline(checkPage, false);
          
          if (isLive) {
            console.log(`✅ [${channelNameTrimmed}] is ONLINE - starting watch...`);
            // Запускаем просмотр в отдельной странице (не блокируя)
            watchStreamer(browser, channelNameTrimmed).catch((error: any) => {
              console.log(`❌ [${channelNameTrimmed}] Watch error:`, error.message || error);
            });
          } else {
            console.log(`❌ [${channelNameTrimmed}] is OFFLINE`);
          }
        } catch (error: any) {
          console.log(`⚠️ [${channelNameTrimmed}] Error checking status:`, error.message || error);
        }
      }
      
      // Проверяем активные просмотры - если стример офлайн, останавливаем просмотр
      for (const [streamerName, watchInfo] of activeWatches.entries()) {
        try {
          const channelUrl = baseUrl + streamerName;
          await Promise.race([
            checkPage.goto(channelUrl, { waitUntil: "networkidle0" }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Page load timeout')), 30000))
          ]).catch(() => {});
          
          await checkPage.waitFor(2000);
          const isLive = await isStreamerOnline(watchInfo.page, false);
          
          if (!isLive) {
            console.log(`⚠️ [${streamerName}] went OFFLINE during watch. Stopping...`);
            activeWatches.delete(streamerName);
            await watchInfo.page.close();
          }
        } catch (error: any) {
          // Игнорируем ошибки проверки
        }
      }
      
      // Ждем перед следующей проверкой
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    } catch (error: any) {
      console.log('🤬 Error in parallel watch manager:', error);
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
  }
}

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

      if (proxy) {
        browserConfig.args?.push('--proxy-server=' + proxy);
      }
      browserConfig.executablePath = configFile.exec;
      cookie[0].value = configFile.token;

      return cookie;
    } else if (process.env.token) {
      console.log('✅  Env config found');

      if (proxy) {
        browserConfig.args?.push('--proxy-server=' + proxy);
      }
      cookie[0].value = process.env.token; // Set cookie from env
      // Путь по умолчанию для Windows (Microsoft Edge) или Linux (Chromium)
      browserConfig.executablePath = process.env.exec || 
        (process.platform === 'win32' 
          ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
          : '/usr/bin/chromium-browser');

      return cookie;
    } else {
      console.log('❌ No config file found!');

      const input: LoginInput = await askLogin();

      fs.writeFile(configPath, JSON.stringify(input), (err) => {
        if (err) {
          console.log(err);
        }
      });

      if (proxy) {
        if (browserConfig.args && browserConfig.args.length > 6) {
          browserConfig.args[6] = '--proxy-server=' + proxy;
        } else {
          browserConfig.args?.push('--proxy-server=' + proxy);
        }
      }
      // Используем введенный путь или путь по умолчанию для Windows
      browserConfig.executablePath = input.exec || 
        (process.platform === 'win32' 
          ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
          : '/usr/bin/chromium-browser');
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
 * Создание новой страницы с настройками
 * @param browser Экземпляр браузера
 * @returns Новая страница с настроенными параметрами
 */
async function createPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  
  await page.setUserAgent(userAgent);
  
  if (cookie) {
    const puppeteerCookies = cookie.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: (c.sameSite === 'no_restriction' ? 'None' : c.sameSite) as 'Strict' | 'Lax' | 'None' | undefined
    }));
    await page.setCookie(...puppeteerCookies);
  }
  
  const timeout = Number(process.env.timeout) || 0;
  await page.setDefaultNavigationTimeout(timeout);
  await page.setDefaultTimeout(timeout);
  
  if (proxyAuth) {
    await page.setExtraHTTPHeaders({
      'Proxy-Authorization': 'Basic ' + Buffer.from(proxyAuth).toString('base64')
    });
  }
  
  return page;
}

/**
 * Создание и настройка браузера
 * @returns Объект с экземплярами браузера и страницы
 */
async function spawnBrowser(): Promise<BrowserSpawn> {
  console.log("=========================");
  console.log('📱 Launching browser...');
  const browser = await puppeteer.launch(browserConfig);
  const page = await createPage(browser);

  return {
    browser,
    page
  };
}

/**
 * Класс исключения для случая, когда стример стал оффлайн во время просмотра
 */
class StreamerOfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamerOfflineError';
  }
}

/**
 * Проверка, онлайн ли стример на текущей странице
 * @param page Экземпляр страницы
 * @param verbose Показывать ли детальное логирование (по умолчанию false)
 * @returns true если стример онлайн, false если оффлайн
 */
async function isStreamerOnline(page: Page, verbose: boolean = false): Promise<boolean> {
  try {
    const checkResult = await page.evaluate(() => {
      const bodyText = document.body.textContent || '';
      const bodyHTML = document.body.innerHTML || '';
      const result: { isLive: boolean; reason: string; details: string[] } = {
        isLive: false,
        reason: '',
        details: []
      };
      
      // Ищем ТОЛЬКО надпись "В ЭФИРЕ" или "LIVE" - это единственный надежный признак онлайн
      // Сначала ищем индикатор стрима (LIVE)
      const liveIndicator = document.querySelector('.tw-channel-status-text-indicator');
      if (liveIndicator) {
        const text = liveIndicator.textContent || '';
        result.details.push(`Found liveIndicator element, text: "${text}"`);
        if (text.includes('LIVE') || text.includes('В ЭФИРЕ') || text.includes('ON AIR')) {
          result.isLive = true;
          result.reason = `LIVE indicator found with text: "${text}"`;
          return result;
        }
      } else {
        result.details.push('No liveIndicator element found (.tw-channel-status-text-indicator)');
      }
      
      // Ищем элементы, содержащие текст "В ЭФИРЕ" или "LIVE"
      const liveElements = document.querySelectorAll('[class*="live"], [class*="Live"], [data-a-target*="live"]');
      result.details.push(`Found ${liveElements.length} elements with "live" in class/attribute`);
      for (let i = 0; i < liveElements.length; i++) {
        const elem = liveElements[i];
        const text = elem.textContent || '';
        if (text.includes('LIVE') || text.includes('В ЭФИРЕ')) {
          result.isLive = true;
          result.reason = `Found LIVE element with text: "${text.substring(0, 50)}"`;
          return result;
        }
      }
      
      // Ищем по ключевым словам в тексте страницы (только "В ЭФИРЕ" или "LIVE")
      const hasLiveInText = bodyText.includes('LIVE') || bodyText.includes('В ЭФИРЕ');
      result.details.push(`Text contains "LIVE" or "В ЭФИРЕ": ${hasLiveInText}`);
      if (hasLiveInText) {
        result.isLive = true;
        result.reason = 'Found "LIVE" or "В ЭФИРЕ" in page text';
        return result;
      }
      
      // Если не нашли надпись "В ЭФИРЕ" или "LIVE" - считаем офлайн
      result.details.push('No "В ЭФИРЕ" or "LIVE" text found - checking for offline indicators');
      
      // Теперь проверяем явные признаки ОФФЛАЙН статуса (только конкретные сообщения)
      const offlineMessages = [
        'This channel is currently offline',
        'Канал сейчас оффлайн',
        'This streamer is offline',
        'channel is currently offline'
      ];
      
      // Ищем конкретные сообщения об оффлайн статусе (не просто слово "offline")
      let foundOfflineMessage = false;
      let offlineElementsCount = 0;
      for (const message of offlineMessages) {
        const hasMessage = bodyText.toLowerCase().includes(message.toLowerCase()) || 
                          bodyHTML.toLowerCase().includes(message.toLowerCase());
        if (hasMessage) {
          foundOfflineMessage = true;
          result.details.push(`Found offline message: "${message}"`);
          // Нашли явное сообщение об оффлайн - проверяем дополнительно
          const offlineElements = document.querySelectorAll('[class*="offline"], [class*="Offline"], [data-a-target*="offline"]');
          offlineElementsCount = offlineElements.length;
          result.details.push(`Found ${offlineElementsCount} elements with "offline" in class/attribute`);
          if (offlineElements.length > 0) {
            // Есть элементы с классом offline - точно офлайн
            result.isLive = false;
            result.reason = `Found offline message "${message}" and ${offlineElements.length} offline elements`;
            return result;
          }
        }
      }
      
      if (!foundOfflineMessage) {
        result.details.push('No explicit offline messages found');
      }
      
      // Проверяем наличие видео только для информации (не используем как признак онлайн)
      const video = document.querySelector('video');
      if (video) {
        result.details.push(`Video element found: paused=${video.paused}, readyState=${video.readyState} (NOT used as online indicator)`);
      } else {
        result.details.push('No video element found');
      }
      
      // Если не нашли надпись "В ЭФИРЕ" или "LIVE" - считаем офлайн
      // Видео элемент не используется как признак онлайн, так как он может быть на странице офлайн стримера
      result.isLive = false;
      result.reason = 'No "В ЭФИРЕ" or "LIVE" text found - streamer is OFFLINE';
      return result;
    });
    
    // Логируем результат проверки только если включен verbose режим
    if (verbose) {
      console.log(`   📊 Status check result: ${checkResult.isLive ? 'ONLINE ✅' : 'OFFLINE ❌'}`);
      console.log(`   📋 Reason: ${checkResult.reason}`);
      if (checkResult.details.length > 0) {
        console.log(`   🔍 Details:`);
        checkResult.details.forEach(detail => {
          console.log(`      - ${detail}`);
        });
      }
    }
    
    return checkResult.isLive;
  } catch (error: any) {
    console.log(`⚠️ Error checking streamer status:`, error.message || error);
    // В случае ошибки при проверке перед началом просмотра - считаем офлайн (безопаснее)
    // Во время просмотра - считаем онлайн (не прерываем просмотр из-за ошибки проверки)
    return false;
  }
}

/**
 * Проверка приоритетных стримеров, возвращает первого найденного онлайн
 * @param page Экземпляр страницы
 * @param priorityChannels Список приоритетных каналов
 * @returns Массив с одним онлайн стримером (первым найденным) или пустой массив
 */
async function checkPriorityStreamersOnline(page: Page, priorityChannels: string[]): Promise<string[]> {
  for (const channel of priorityChannels) {
    const channelName = channel.trim();
    if (!channelName) continue;
    
    try {
      const channelUrl = baseUrl + channelName;
      console.log(`   Checking ${channelName}...`);
      
      // Используем Promise.race для таймаута (старая версия puppeteer-core не поддерживает timeout в опциях)
      await Promise.race([
        page.goto(channelUrl, {
          waitUntil: "networkidle0"
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Page load timeout')), 30000))
      ]).catch(() => {
        // Игнорируем таймаут, продолжаем проверку следующего канала
      });
      
      // Ждем немного для загрузки страницы
      await page.waitFor(3000);
      
      // Используем ту же функцию проверки, что и во время просмотра (с детальным логированием)
      const isLive = await isStreamerOnline(page, true);
      
      if (isLive) {
        console.log(`   ✅ ${channelName} is ONLINE - stopping check`);
        return [channelName]; // Возвращаем первого найденного онлайн стримера
      } else {
        console.log(`   ❌ ${channelName} is OFFLINE`);
      }
    } catch (error: any) {
      console.log(`   ⚠️ Error checking ${channelName}:`, error.message || error);
    }
  }
  
  return []; // Никто не онлайн
}

/**
 * Проверка успешности входа в систему
 * @param page Экземпляр страницы
 * @returns true если вход успешен
 */
async function checkLogin(page: Page): Promise<boolean> {
  const cookieSetByServer = await page.cookies();
  for (let i = 0; i < cookieSetByServer.length; i++) {
    if (cookieSetByServer[i].name === 'twilight-user') {
      console.log('✅ Login successful!');
      return true;
    }
  }
  console.log('🛑 Login failed!');
  console.log('🔑 Invalid token!');
  console.log('\nPlease ensure that you have a valid twitch auth-token.');
  if (!process.env.token) {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  }
  process.exit(1);
  return false;
}

/**
 * Эмуляция прокрутки страницы для загрузки дополнительных стримеров
 * @param page Экземпляр страницы
 * @param times Количество прокруток
 */
async function scroll(page: Page, times: number): Promise<void> {
  console.log('🔨 Emulating scrolling...');

  for (let i = 0; i < times; i++) {
    const scrolled = await page.evaluate(async () => {
      // Пробуем несколько селекторов для прокрутки
      const selectors = [
        "scrollable-trigger__wrapper",
        "infinite-scroll-component",
        "[data-a-target='directory-channel-card']"
      ];
      
      for (const selector of selectors) {
        const elements = document.getElementsByClassName(selector);
        if (elements.length > 0) {
          elements[elements.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
          return true;
        }
      }
      
      // Если не нашли, просто прокручиваем вниз
      window.scrollTo(0, document.body.scrollHeight);
      return true;
    });
    
    if (scrolled) {
      await page.waitFor(2000);
    } else {
      await page.waitFor(2000);
    }
  }
  
  // Финальная прокрутка в самый низ
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitFor(2000);
  
  return;
}

/**
 * Уведомление о создании скриншота (логирование отключено)
 * @param streamerName Имя стримера
 * @param screenshotPath Путь к скриншоту
 * @param isPeriodic Является ли скриншот периодическим
 */
function notifyScreenshot(streamerName: string, screenshotPath: string, isPeriodic: boolean = false): void {
  // Логирование отключено
}

/**
 * Управление количеством скриншотов - оставляет только последние N файлов
 * @param maxScreenshots Максимальное количество скриншотов для хранения
 */
async function cleanupOldScreenshots(maxScreenshots: number = 10): Promise<void> {
  try {
    // Проверяем существование папки
    try {
      await fs.promises.access(screenshotFolder);
    } catch {
      // Папка не существует, ничего не делаем
      return;
    }

    // Получаем список всех файлов в папке скриншотов
    const files = await fs.promises.readdir(screenshotFolder);
    const pngFiles = files.filter(file => file.endsWith('.png'));
    
    if (pngFiles.length <= maxScreenshots) {
      return; // Не нужно удалять файлы
    }

    // Получаем информацию о файлах с датами модификации
    const filesWithStats = await Promise.all(
      pngFiles.map(async (file) => {
        const filePath = path.join(screenshotFolder, file);
        const stats = await fs.promises.stat(filePath);
        return {
          name: file,
          path: filePath,
          mtime: stats.mtime.getTime()
        };
      })
    );

    // Сортируем по дате модификации (старые первыми)
    filesWithStats.sort((a, b) => a.mtime - b.mtime);

    // Удаляем старые файлы, оставляя только последние maxScreenshots
    const filesToDelete = filesWithStats.slice(0, filesWithStats.length - maxScreenshots);
    
    for (const file of filesToDelete) {
      try {
        await fs.promises.unlink(file.path);
      } catch (deleteError) {
        // Игнорируем ошибки удаления
      }
    }
  } catch (error) {
    console.error('❌ Error during screenshot cleanup:', error);
  }
}

/**
 * Получение случайного целого числа в диапазоне
 * @param min Минимальное значение
 * @param max Максимальное значение
 * @returns Случайное целое число
 */
function getRandomInt(min: number, max: number): number {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Клик по элементу, если он существует
 * @param page Экземпляр страницы
 * @param query CSS селектор элемента
 */
async function clickWhenExist(page: Page, query: string): Promise<void> {
  const result = await queryOnWebsite(page, query);

  try {
    if (result[0] && result[0].type === 'tag' && result[0].name === 'button') {
      await page.click(query);
      await page.waitFor(500);
      return;
    }
  } catch (e) {
    // Элемент не найден, игнорируем ошибку
  }
}

/**
 * Автоматический клик на кнопку получения бонусов канала, если она доступна
 * @param page Экземпляр страницы
 * @returns true если кнопка была найдена и нажата, false в противном случае
 */
/**
 * Автоматический клик на кнопку получения бонусов канала, если она доступна
 * Основано на логике из twitch_collect.js
 * @param page Экземпляр страницы
 * @returns true если кнопка была найдена и нажата, false в противном случае
 */
async function claimChannelPointsBonus(page: Page): Promise<boolean> {
  try {
    // Пробуем найти и кликнуть на кнопку получения бонусов
    // Используем селектор из twitch_collect.js: .community-points-summary > *:nth-child(2) button
    const clicked = await page.evaluate((selector: string) => {
      const chestPoints = document.querySelector(selector) as HTMLElement;
      
      if (chestPoints) {
        // Проверяем, что кнопка видима и кликабельна
        const style = window.getComputedStyle(chestPoints);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
          // Кликаем на кнопку
          chestPoints.click();
          return true;
        }
      }
      
      return false;
    }, channelPointsBonusSelector);
    
    return clicked;
  } catch (error: any) {
    // Игнорируем ошибки
    return false;
  }
}

/**
 * Получение количества баллов канала
 * @param page Экземпляр страницы
 * @returns Количество баллов канала или null, если не найдено
 */
async function getChannelPoints(page: Page): Promise<string | null> {
  try {
    // Ждем появления элемента с баллами (особенно важно для Docker/headless режима)
    // Пробуем несколько раз с небольшими задержками
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Ждем появления основного элемента с баллами
        await page.waitForSelector('[data-test-selector="copo-balance-string"]').catch(() => {
          // Элемент не найден, продолжаем попытки
        });
      } catch (e) {
        // Игнорируем ошибки ожидания
      }

      // Пробуем получить баллы через JavaScript, так как они могут быть в динамическом контенте
      const points = await page.evaluate(() => {
        // Простая функция для извлечения числа из текста
        // Удаляет все пробелы, неразрывные пробелы и запятые, оставляя только цифры
        const extractNumber = (text: string): string | null => {
          if (!text || !text.trim()) {
            return null;
          }
          // Удаляем все разделители (пробелы, неразрывные пробелы, запятые)
          const cleaned = text.replace(/[\s\u00A0,]/g, '');
          // Проверяем, что остались только цифры
          if (/^\d+$/.test(cleaned)) {
            return cleaned;
          }
          return null;
        };

        // Используем ТОЛЬКО основной селектор Twitch для баллов канала
        // Не ищем в других местах, чтобы не захватить числа зрителей или другие метрики
        const mainElement = document.querySelector('[data-test-selector="copo-balance-string"]');
        if (mainElement) {
          const text = mainElement.textContent || '';
          const number = extractNumber(text);
          if (number) {
            return number;
          }
        }

        return null;
      });

      // Если нашли баллы, возвращаем их
      if (points) {
        return points;
      }

      // Если не нашли, ждем немного перед следующей попыткой
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return null;
  } catch (error: any) {
    console.log('⚠️ Error getting channel points:', error.message || error);
    return null;
  }
}

/**
 * Просмотр стрима с периодическими скриншотами и проверкой баллов канала
 * Просмотр продолжается бесконечно, пока стример онлайн
 * @param page Экземпляр страницы
 * @param streamerName Имя стримера
 * @param interval Интервал между скриншотами в секундах
 * @param initialChannelPoints Начальное количество баллов канала
 */
async function watchWithPeriodicScreenshots(page: Page, streamerName: string, interval: number, initialChannelPoints: string | null): Promise<void> {
  const intervalMs = interval * 1000;
  let screenshotCount = 0;
  let lastChannelPoints = initialChannelPoints;
  const streamerCheckInterval = 60000; // Проверяем статус стримера каждую минуту
  let lastStreamerCheck = Date.now();
  
  while (run) {
    // Ждем интервал перед следующим скриншотом
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    
    // Периодически проверяем, что видео не на паузе
    try {
      const isPaused = await page.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement;
        return video ? video.paused : false;
      });
      
      if (isPaused) {
        console.log(`⚠️ [${streamerName}] Video is paused, reloading page...`);
        // Перезагружаем страницу
        await page.goto(baseUrl + streamerName, { waitUntil: "networkidle0" });
        // Принимаем cookies и mature content после перезагрузки
        await clickWhenExist(page, cookiePolicyQuery);
        await clickWhenExist(page, matureContentQuery);
        await page.waitFor(2000); // Даем время на загрузку
        // Обновляем баллы канала после перезагрузки
        const newChannelPoints = await getChannelPoints(page);
        if (newChannelPoints) {
          lastChannelPoints = newChannelPoints;
          // Обновляем lastChannelPoints в activeWatches, но не сбрасываем startTime и initialChannelPoints
          const watchInfo = activeWatches.get(streamerName);
          if (watchInfo) {
            watchInfo.lastChannelPoints = newChannelPoints;
            watchInfo.page = page; // Обновляем ссылку на страницу
          }
        }
        console.log(`✅ [${streamerName}] Page reloaded (watch time preserved)`);
      }
    } catch (e) {
      // Игнорируем ошибки проверки
    }
    
    // Периодически проверяем, онлайн ли стример (без детального логирования)
    if (Date.now() - lastStreamerCheck >= streamerCheckInterval) {
      const isOnline = await isStreamerOnline(page, false);
      if (!isOnline) {
        console.log(`⚠️ ${streamerName} is no longer online. Stopping watch and searching for another streamer...`);
        throw new StreamerOfflineError(`${streamerName} went offline during watch`);
      }
      lastStreamerCheck = Date.now();
    }
    
    // Проверяем изменение баллов канала
    const currentChannelPoints = await getChannelPoints(page);
    if (currentChannelPoints && currentChannelPoints !== lastChannelPoints) {
      lastChannelPoints = currentChannelPoints;
      // Обновляем lastChannelPoints в activeWatches
      const watchInfo = activeWatches.get(streamerName);
      if (watchInfo) {
        watchInfo.lastChannelPoints = currentChannelPoints;
      }
    }
    
    // Пробуем получить бонусы канала, если доступны
    const bonusClaimed = await claimChannelPointsBonus(page);
    if (bonusClaimed) {
      console.log(`🎁 [${streamerName}] Channel points bonus claimed!`);
    }
    
    // Делаем периодический скриншот
    screenshotCount++;
    const timestamp = dayjs().format('YYYY-MM-DD_HH-mm-ss');
    const screenshotPath = path.join(screenshotFolder, `${streamerName}_${timestamp}.png`);
    
    try {
      await page.screenshot({
        path: screenshotPath
      });
      
      // Очищаем старые скриншоты после каждого периодического скриншота
      await cleanupOldScreenshots(10);
    } catch (screenshotError: any) {
      // Игнорируем ошибки сохранения скриншотов
    }
  }
}

/**
 * Просмотр стрима с проверкой баллов канала (без периодических скриншотов)
 * Просмотр продолжается бесконечно, пока стример онлайн
 * @param page Экземпляр страницы
 * @param streamerName Имя стримера
 * @param initialChannelPoints Начальное количество баллов канала
 */
async function watchWithChannelPointsCheck(page: Page, streamerName: string, initialChannelPoints: string | null): Promise<void> {
  const checkInterval = 30000; // Проверяем баллы каждые 30 секунд
  const streamerCheckInterval = 60000; // Проверяем статус стримера каждую минуту
  let lastChannelPoints = initialChannelPoints;
  let lastStreamerCheck = Date.now();
  
  while (run) {
    await new Promise(resolve => setTimeout(resolve, checkInterval));
    
    // Периодически проверяем, что видео не на паузе
    try {
      const isPaused = await page.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement;
        return video ? video.paused : false;
      });
      
      if (isPaused) {
        console.log(`⚠️ [${streamerName}] Video is paused, reloading page...`);
        // Перезагружаем страницу
        await page.goto(baseUrl + streamerName, { waitUntil: "networkidle0" });
        // Принимаем cookies и mature content после перезагрузки
        await clickWhenExist(page, cookiePolicyQuery);
        await clickWhenExist(page, matureContentQuery);
        await page.waitFor(2000); // Даем время на загрузку
        // Обновляем баллы канала после перезагрузки
        const newChannelPoints = await getChannelPoints(page);
        if (newChannelPoints) {
          lastChannelPoints = newChannelPoints;
          // Обновляем lastChannelPoints в activeWatches, но не сбрасываем startTime и initialChannelPoints
          const watchInfo = activeWatches.get(streamerName);
          if (watchInfo) {
            watchInfo.lastChannelPoints = newChannelPoints;
            watchInfo.page = page; // Обновляем ссылку на страницу
          }
        }
        console.log(`✅ [${streamerName}] Page reloaded (watch time preserved)`);
      }
    } catch (e) {
      // Игнорируем ошибки проверки
    }
    
    // Периодически проверяем, онлайн ли стример (без детального логирования)
    if (Date.now() - lastStreamerCheck >= streamerCheckInterval) {
      const isOnline = await isStreamerOnline(page, false);
      if (!isOnline) {
        console.log(`⚠️ Streamer is no longer online. Stopping watch and searching for another streamer...`);
        throw new StreamerOfflineError('Streamer went offline during watch');
      }
      lastStreamerCheck = Date.now();
    }
    
    // Проверяем изменение баллов канала
    const currentChannelPoints = await getChannelPoints(page);
    if (currentChannelPoints && currentChannelPoints !== lastChannelPoints) {
      lastChannelPoints = currentChannelPoints;
      // Обновляем lastChannelPoints в activeWatches
      const watchInfo = activeWatches.get(streamerName);
      if (watchInfo) {
        watchInfo.lastChannelPoints = currentChannelPoints;
      }
    }
    
    // Пробуем получить бонусы канала, если доступны
    const bonusClaimed = await claimChannelPointsBonus(page);
    if (bonusClaimed) {
      console.log(`🎁 [${streamerName}] Channel points bonus claimed!`);
    }
  }
}

/**
 * Выполнение запроса на веб-сайте с использованием Cheerio
 * @param page Экземпляр страницы
 * @param query CSS селектор
 * @returns Массив найденных элементов
 */
async function queryOnWebsite(page: Page, query: string): Promise<any> {
  const bodyHTML = await page.evaluate(() => document.body.innerHTML);
  const $ = cheerio.load(bodyHTML);
  
  // Пробуем основной селектор (теперь он содержит несколько вариантов через запятую)
  let jquery = $(query);
  
  // Если основной селектор не нашел элементы, пробуем альтернативные
  if (jquery.length === 0) {
    const alternativeSelectors = [
      '[data-a-target="directory-channel-card"] a',
      'a[data-a-target="preview-card-image-link"]',
      'a[href^="/"][href!="/"][href!="/directory"][href!="/p"][href!="/videos"][href!="/clips"]'
    ];
    
    for (const altQuery of alternativeSelectors) {
      jquery = $(altQuery);
      if (jquery.length > 0) {
        // Используем альтернативный селектор
        break;
      }
    }
  }
  
  return jquery;
}

/**
 * Очистка и перезапуск браузера
 * @param browser Экземпляр браузера
 * @param page Экземпляр страницы
 * @returns Новый экземпляр браузера и страницы
 */
async function cleanup(browser: Browser, _page: Page): Promise<BrowserSpawn> {
  const pages = await browser.pages();
  await Promise.all(pages.map((p: Page) => p.close()));
  const process = browser.process();
  if (process && process.pid) {
    await new Promise<void>((resolve) => {
      treekill(process.pid!, 'SIGKILL', () => {
        resolve();
      });
    });
  }
  // await browser.close();
  return await spawnBrowser();
}

/**
 * Завершение работы браузера
 * @param browser Экземпляр браузера
 * @param page Экземпляр страницы
 */

/**
 * Корректное завершение работы приложения
 */
async function shutDown(): Promise<void> {
  console.log("\n👋Bye Bye👋");
  run = false;
  process.exit(0);
}

/**
 * Очистка папки скриншотов при запуске
 */
async function clearScreenshotsFolder(): Promise<void> {
  try {
    const files = await fs.promises.readdir(screenshotFolder);
    const pngFiles = files.filter(file => file.endsWith('.png'));
    
    if (pngFiles.length > 0) {
      for (const file of pngFiles) {
        const filePath = path.join(screenshotFolder, file);
        await fs.promises.unlink(filePath);
      }
    }
  } catch (error: any) {
    // Если папка не существует, создаем её
    if (error.code === 'ENOENT') {
      try {
        await fs.promises.mkdir(screenshotFolder, { recursive: true });
      } catch (mkdirError: any) {
        // Игнорируем ошибки создания папки
      }
    }
  }
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
 * Запускает Puppeteer-режим
 */
async function startPuppeteerMode(): Promise<void> {
  // Очищаем папку скриншотов при запуске, если включены скриншоты
  if (browserScreenshot) {
    await clearScreenshotsFolder();
  }
  
  cookie = await readLoginData();
  let { browser, page } = await spawnBrowser();
  
  // Открываем главную страницу Twitch для установки cookies
  console.log('🌐 Opening Twitch homepage to set cookies...');
  await page.goto(baseUrl, {
    waitUntil: "networkidle0"
  });
  await page.waitFor(2000); // Даем время на установку cookies
  
  // Проверяем логин один раз при старте
  console.log('🔐 Checking login...');
  await checkLogin(page);
  
  console.log("=========================");
  console.log('🔭 Running watcher...');
  console.log('📝 Mode: Parallel watching of priority channels (Puppeteer)');
  console.log("=========================");
  await manageParallelWatches(browser, page);
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
  
  // Определяем режим работы
  // Проверяем переменную окружения
  const modeEnv = process.env.MODE;
  // Убираем комментарии (всё после #) и лишние пробелы
  const mode = (modeEnv || 'puppeteer')
    .split('#')[0]  // Убираем комментарии
    .trim()         // Убираем пробелы
    .toLowerCase(); // Приводим к нижнему регистру
  
  logger.verbose(`🔍  Environment check:`);
  logger.verbose(`   MODE from process.env.MODE: "${process.env.MODE}"`);
  logger.verbose(`   Resolved mode: "${mode}"`);
  const logLevel = (process.env.LOG_LEVEL || 'verbose').toLowerCase();
  logger.verbose(`   LOG_LEVEL: "${logLevel}"`);
  logger.verbose(`=========================`);
  
  if (mode === 'api') {
    console.log('🔧  Mode: API (Channel Points Miner style)');
    console.log("=========================");
    await startAPIMode();
  } else {
    console.log('🔧  Mode: Puppeteer (Browser automation)');
    console.log("=========================");
    await startPuppeteerMode();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);


