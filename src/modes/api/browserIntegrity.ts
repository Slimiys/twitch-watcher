/**
 * Получение Client-Integrity через headless Chromium (Playwright)
 */

import { CLIENT_ID } from './constants';
import { integrityExpirationToMs } from './integrityConfig';
import { logger } from './logger';

const INTEGRITY_URL = 'https://gql.twitch.tv/integrity';

export interface BrowserIntegrityOptions {
  authToken: string;
  deviceId: string;
  userAgent: string;
  pageUrl?: string;
  waitAfterLoadMs?: number;
  timeoutMs?: number;
  executablePath?: string;
}

export interface BrowserIntegrityResult {
  token: string;
  expiresAtMs: number;
}

/**
 * Запрашивает integrity из контекста браузера (Kasada / fingerprint Twitch)
 */
export async function fetchBrowserIntegrityToken(
  options: BrowserIntegrityOptions
): Promise<BrowserIntegrityResult> {
  let playwrightModule: typeof import('playwright');
  try {
    playwrightModule = await import('playwright');
  } catch {
    throw new Error(
      'Playwright не установлен. Выполните: npm install playwright (или TWITCH_INTEGRITY_SOURCE=manual)'
    );
  }

  const timeoutMs = options.timeoutMs ?? 90_000;
  const pageUrl = options.pageUrl?.trim() || 'https://www.twitch.tv';
  const waitAfterLoadMs = options.waitAfterLoadMs ?? 5_000;

  const launchOptions: Record<string, unknown> = {
    headless: true,
    timeout: timeoutMs,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };

  if (options.executablePath?.trim()) {
    launchOptions.executablePath = options.executablePath.trim();
  }

  const browser = await playwrightModule.chromium.launch(launchOptions);

  try {
    const context = await browser.newContext({
      userAgent: options.userAgent,
      viewport: { width: 1280, height: 720 },
    });

    await context.addCookies([
      {
        name: 'auth-token',
        value: options.authToken,
        domain: '.twitch.tv',
        path: '/',
        secure: true,
        sameSite: 'None',
      },
      {
        name: 'unique_id',
        value: options.deviceId,
        domain: '.twitch.tv',
        path: '/',
        secure: true,
        sameSite: 'None',
      },
    ]);

    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    if (waitAfterLoadMs > 0) {
      await page.waitForTimeout(waitAfterLoadMs);
    }

    interface IntegrityPageArg {
      integrityUrl: string;
      clientId: string;
      deviceId: string;
    }

    const data = await page.evaluate(
      async (arg: IntegrityPageArg) => {
        const response = await fetch(arg.integrityUrl, {
          method: 'POST',
          headers: {
            'Client-Id': arg.clientId,
            'X-Device-Id': arg.deviceId,
          },
        });
        if (!response.ok) {
          throw new Error(`integrity ${response.status}`);
        }
        return response.json() as Promise<{ token?: string; expiration?: number }>;
      },
      {
        integrityUrl: INTEGRITY_URL,
        clientId: CLIENT_ID,
        deviceId: options.deviceId,
      }
    );

    if (!data.token) {
      throw new Error('Browser integrity response missing token');
    }

    const now = Date.now();
    const expiresAtMs = integrityExpirationToMs(data.expiration, now);

    logger.verbose(
      `🔐  Client-Integrity from browser (device ${options.deviceId.slice(0, 8)}..., page ${pageUrl})`
    );

    return { token: data.token, expiresAtMs };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Путь к Chromium: exec или PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
 */
export function resolveBrowserExecutablePath(): string | undefined {
  return (
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() ||
    process.env.exec?.trim() ||
    undefined
  );
}
