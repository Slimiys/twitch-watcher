/**
 * Получение Client-Integrity токена для защищённых GraphQL-мутаций Twitch
 */

import { CLIENT_ID } from './constants';
import { logger } from './logger';
import * as crypto from 'crypto';
import {
  allowApiIntegrityFallback,
  getManualIntegrityFromEnv,
  integrityExpirationToMs,
  resolveIntegritySource,
  ResolvedIntegritySource,
} from './integrityConfig';
import { buildTwitchGqlHeaders } from './twitchGqlContext';

const INTEGRITY_URL = 'https://gql.twitch.tv/integrity';

/**
 * Кэширует integrity-токен и device id для ClaimCommunityPoints и подобных операций.
 * manual — из TWITCH_CLIENT_INTEGRITY (DevTools); api — POST /integrity; fallback по env.
 */
export class TwitchIntegrityProvider {
  private source: ResolvedIntegritySource;
  private apiToken: string | null = null;
  private apiExpiresAtMs = 0;
  private readonly deviceId: string;
  private apiRefreshPromise: Promise<string> | null = null;
  private readonly userAgent: string;

  /**
   * @param authToken OAuth-токен Twitch
   * @param userAgent User-Agent для запросов
   * @param deviceId Стабильный X-Device-Id (опционально)
   */
  constructor(
    private authToken: string,
    userAgent: string,
    deviceId?: string
  ) {
    this.userAgent = userAgent;
    const fromEnv = process.env.TWITCH_DEVICE_ID?.trim();
    this.deviceId = deviceId || fromEnv || crypto.randomUUID();
    this.source = resolveIntegritySource();

    if (this.source === 'manual') {
      const manual = getManualIntegrityFromEnv();
      if (!manual) {
        logger.warn(
          '🔐  Integrity: manual, но TWITCH_CLIENT_INTEGRITY не задан — claim не сработает. Скопируйте Client-Integrity из DevTools → Network → gql.'
        );
      } else {
        logger.info('🔐  Integrity: manual (TWITCH_CLIENT_INTEGRITY из DevTools)');
        if (allowApiIntegrityFallback()) {
          logger.info('   Fallback POST /integrity включён (TWITCH_INTEGRITY_FALLBACK_API=true)');
        }
      }
    } else {
      logger.info('🔐  Integrity: api (POST /integrity)');
    }
  }

  /**
   * Возвращает стабильный device id для заголовков Twitch
   */
  getDeviceId(): string {
    return this.deviceId;
  }

  /**
   * Сбрасывает кэш API-токена; manual перечитывается из env при следующем getToken
   */
  invalidate(): void {
    this.apiToken = null;
    this.apiExpiresAtMs = 0;
    this.apiRefreshPromise = null;
    if (this.source === 'manual') {
      logger.verbose(
        '🔐  Integrity invalidated — обновите TWITCH_CLIENT_INTEGRITY в .env (Request Headers → Client-Integrity)'
      );
    }
  }

  /**
   * Возвращает актуальный Client-Integrity токен
   */
  async getToken(): Promise<string> {
    if (this.source === 'manual') {
      return this.getManualOrFallbackToken();
    }
    return this.getApiToken();
  }

  private getManualOrFallbackToken(): Promise<string> {
    const manual = getManualIntegrityFromEnv();
    if (manual && Date.now() < manual.expiresAtMs - 60_000) {
      return Promise.resolve(manual.token);
    }

    if (manual && Date.now() >= manual.expiresAtMs - 60_000) {
      logger.warn(
        '🔐  TWITCH_CLIENT_INTEGRITY истёк — обновите из DevTools (Client-Integrity + TWITCH_CLIENT_INTEGRITY_EXPIRES)'
      );
    } else if (!manual) {
      logger.verbose('🔐  TWITCH_CLIENT_INTEGRITY не задан');
    }

    if (allowApiIntegrityFallback()) {
      logger.verbose('🔐  Пробуем fallback POST /integrity...');
      return this.getApiToken();
    }

    throw new Error(
      'Нет действующего TWITCH_CLIENT_INTEGRITY. Откройте twitch.tv в браузере, DevTools → Network → gql → скопируйте Client-Integrity в .env'
    );
  }

  private async getApiToken(): Promise<string> {
    const now = Date.now();
    if (this.apiToken && now < this.apiExpiresAtMs - 60_000) {
      return this.apiToken;
    }

    if (!this.apiRefreshPromise) {
      this.apiRefreshPromise = this.refreshApiToken().finally(() => {
        this.apiRefreshPromise = null;
      });
    }

    return this.apiRefreshPromise;
  }

  private async refreshApiToken(): Promise<string> {
    const fetchTimeoutMs = parseInt(process.env.FETCH_TIMEOUT_MS || '20000', 10);
    const headers = await buildTwitchGqlHeaders({
      authToken: this.authToken,
      userAgent: this.userAgent,
      clientId: CLIENT_ID,
      deviceId: this.deviceId,
    });
    delete headers['Content-Type'];

    const response = await fetch(INTEGRITY_URL, {
      method: 'POST',
      headers,
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
    this.apiToken = data.token;
    this.apiExpiresAtMs = integrityExpirationToMs(data.expiration, now);

    logger.verbose(`🔐  Client-Integrity refreshed via API (device ${this.deviceId.slice(0, 8)}...)`);
    return this.apiToken;
  }
}
