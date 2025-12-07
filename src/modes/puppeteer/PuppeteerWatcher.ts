/**
 * Менеджер просмотра стримов в Puppeteer-режиме
 * Использует существующую логику из app.ts
 */

import { Browser, Page } from 'puppeteer-core';
import { manageParallelWatches } from '../../app';

/**
 * Запускает просмотр стримов в Puppeteer-режиме
 * @param browser Экземпляр браузера
 * @param checkPage Страница для проверки онлайн статуса
 */
export async function startPuppeteerWatcher(browser: Browser, checkPage: Page): Promise<void> {
  console.log('🚀 Starting Puppeteer mode watcher...');
  await manageParallelWatches(browser, checkPage);
}

