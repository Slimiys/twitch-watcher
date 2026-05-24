/**
 * Получение Client-Integrity токена для защищённых GraphQL-мутаций Twitch
 */

import { CLIENT_ID } from './constants';
import { logger } from './logger';
import * as crypto from 'crypto';
import {
  getManualIntegrityToken,
  hasManualIntegrityToken,
  integrityExpirationToMs,
  IntegritySource,
  loadIntegritySource,
} from './integrityConfig';
import { fetchBrowserIntegrityToken, resolveBrowserExecutablePath } from './browserIntegrity';

const INTEGRITY_URL = 'https://gql.twitch.tv/integrity';

/**
 * Кэширует integrity-токен и device id для ClaimCommunityPoints и подобных операций.
 * Источники: browser (Playwright), manual (TWITCH_CLIENT_INTEGRITY), api (POST /integrity).
 */
export class TwitchIntegrityProvider {
  private token: string | null = null;
  private expiresAtMs = 0;
  private readonly deviceId: string;
  private readonly source: IntegritySource;
  private refreshPromise: Promise<string> | null = null;

  /**
   * @param authToken OAuth-токен Twitch
   * @param userAgent User-Agent для запросов
   * @param deviceId Стабильный X-Device-Id (опционально)
   */
  constructor(
    private authToken: string,
    private userAgent: string,
    deviceId?: string
  ) {
    const fromEnv = process.env.TWITCH_DEVICE_ID?.trim();
    this.deviceId = deviceId || fromEnv || crypto.randomUUID();
    this.source = loadIntegritySource();
    this.logSourceAtStartup();
  }

  /**
   * Возвращает настроенный источник integrity
   */
  getSource(): IntegritySource {
    return this.source;
  }

  /**
   * Возвращает стабильный device id для заголовков Twitch
   */
  getDeviceId(): string {
    return this.deviceId;
  }

  /**
   * Сбрасывает кэш токена (перед повторной попыткой после integrity error)
   */
  invalidate(): void {
    this.token = null;
    this.expiresAtMs = 0;
    this.refreshPromise = null;
  }

  /**
   * Возвращает актуальный Client-Integrity токен
   */
  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.expiresAtMs - 60_000) {
      return this.token;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshToken().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  private logSourceAtStartup(): void {
    const manualHint = hasManualIntegrityToken() ? ', manual token в .env' : '';
    switch (this.source) {
      case 'browser':
        logger.info(
          `🔐  Integrity: browser (Playwright)${manualHint} — TWITCH_INTEGRITY_SOURCE=manual для ручного режима`
        );
        break;
      case 'manual':
        if (!hasManualIntegrityToken()) {
          logger.warn(
            '⚠️  Integrity: manual, но TWITCH_CLIENT_INTEGRITY не задан — claim может не работать'
          );
        } else {
          logger.info('🔐  Integrity: manual (TWITCH_CLIENT_INTEGRITY из .env)');
        }
        break;
      case 'api':
        logger.info('🔐  Integrity: api (POST /integrity, без браузера)');
        break;
    }
  }

  private async refreshToken(): Promise<string> {
    switch (this.source) {
      case 'manual':
        return this.refreshManualToken();
      case 'api':
        return this.refreshApiToken();
      case 'browser':
        return this.refreshBrowserWithFallback();
      default:
        return this.refreshApiToken();
    }
  }

  private async refreshManualToken(): Promise<string> {
    const manual = getManualIntegrityToken();
    if (!manual) {
      throw new Error(
        'TWITCH_INTEGRITY_SOURCE=manual, но TWITCH_CLIENT_INTEGRITY не задан в .env'
      );
    }

    this.token = manual;
    const envExpiry = process.env.TWITCH_CLIENT_INTEGRITY_EXPIRES_MS?.trim();
    const parsedExpiry = envExpiry ? parseInt(envExpiry, 10) : NaN;
    this.expiresAtMs =
      Number.isFinite(parsedExpiry) && parsedExpiry > Date.now()
        ? parsedExpiry
        : Date.now() + 4 * 60 * 60 * 1000;

    logger.verbose(`🔐  Client-Integrity from env (manual, device ${this.deviceId.slice(0, 8)}...)`);
    return this.token;
  }

  private async refreshApiToken(): Promise<string> {
    const fetchTimeoutMs = parseInt(process.env.FETCH_TIMEOUT_MS || '20000', 10);
    const response = await fetch(INTEGRITY_URL, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${this.authToken}`,
        'Client-Id': CLIENT_ID,
        'X-Device-Id': this.deviceId,
        'User-Agent': this.userAgent,
      },
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Integrity request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { token?: string; expiration?: number };
    if (!data.token) {
      throw new Error('Integrity response missing token');
    }

    const now = Date.now();
    this.token = data.token;
    this.expiresAtMs = integrityExpirationToMs(data.expiration, now);

    logger.verbose(`🔐  Client-Integrity from api (device ${this.deviceId.slice(0, 8)}...)`);
    return this.token;
  }

  private async refreshBrowserWithFallback(): Promise<string> {
    try {
      return await this.refreshBrowserToken();
    } catch (browserError: any) {
      const message = browserError?.message || String(browserError);
      logger.warn(`⚠️  Browser integrity failed: ${message}`);

      if (hasManualIntegrityToken()) {
        logger.info('ℹ️  Fallback: TWITCH_CLIENT_INTEGRITY (manual)');
        return this.refreshManualToken();
      }

      logger.verbose('ℹ️  Fallback: POST /integrity (api)');
      return this.refreshApiToken();
    }
  }

  private async refreshBrowserToken(): Promise<string> {
    const pageUrl = process.env.TWITCH_INTEGRITY_BROWSER_URL?.trim();
    const waitAfterLoadMs = parseInt(process.env.TWITCH_INTEGRITY_BROWSER_WAIT_MS || '5000', 10);
    const timeoutMs = parseInt(process.env.TWITCH_INTEGRITY_BROWSER_TIMEOUT_MS || '90000', 10);

    const result = await fetchBrowserIntegrityToken({
      authToken: this.authToken,
      deviceId: this.deviceId,
      userAgent: this.userAgent,
      pageUrl,
      waitAfterLoadMs,
      timeoutMs,
      executablePath: resolveBrowserExecutablePath(),
    });

    this.token = result.token;
    this.expiresAtMs = result.expiresAtMs;
    return this.token;
  }
}
