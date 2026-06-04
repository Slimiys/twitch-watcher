/**
 * Получение Client-Integrity токена для защищённых GraphQL-мутаций Twitch
 */

import { CLIENT_ID } from './constants';
import { logger } from './logger';
import {
  allowApiIntegrityFallback,
  canRefreshIntegrityViaApi,
  getIntegrityRefreshLeadMs,
  getManualIntegrityFromEnv,
  integrityExpirationToMs,
  isIntegrityAutoRefreshEnabled,
  isManualIntegrityExpiringSoon,
  resolveIntegritySource,
  ResolvedIntegritySource,
} from './integrityConfig';
import { resolveStableDeviceId } from './integrityDeviceId';
import { persistIntegrityToAppConfig } from './integrityPersistence';
import { IntegrityHealthSnapshot } from './botHealthTypes';
import { buildTwitchGqlHeaders } from './twitchGqlContext';

const INTEGRITY_URL = 'https://gql.twitch.tv/integrity';

/**
 * Кэширует integrity-токен и device id для ClaimCommunityPoints и подобных операций.
 * manual — из TWITCH_CLIENT_INTEGRITY (DevTools); api — POST /integrity; auto — оба с автообновлением.
 */
export class TwitchIntegrityProvider {
  private source: ResolvedIntegritySource;
  private readonly configuredSource: string;
  private apiToken: string | null = null;
  private apiExpiresAtMs = 0;
  private readonly deviceId: string;
  private apiRefreshPromise: Promise<string> | null = null;
  private readonly userAgent: string;
  private proactiveRefreshTimer: ReturnType<typeof setInterval> | null = null;

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
    this.deviceId = resolveStableDeviceId(deviceId);
    this.configuredSource = (process.env.TWITCH_INTEGRITY_SOURCE || 'auto').trim().toLowerCase();
    this.source = resolveIntegritySource();

    this.logSourceOnStartup();

    if (process.env.NODE_ENV !== 'test' && isIntegrityAutoRefreshEnabled()) {
      this.startProactiveRefresh();
    }
  }

  private logSourceOnStartup(): void {
    if (this.configuredSource === 'manual') {
      const manual = getManualIntegrityFromEnv();
      if (!manual) {
        logger.warn(
          '🔐  Integrity: manual, но TWITCH_CLIENT_INTEGRITY не задан — claim не сработает. Скопируйте Client-Integrity из DevTools → gql.'
        );
      } else {
        logger.info('🔐  Integrity: manual (TWITCH_CLIENT_INTEGRITY из DevTools)');
        if (isIntegrityAutoRefreshEnabled()) {
          logger.info('   Автообновление POST /integrity включено (TWITCH_INTEGRITY_AUTO_REFRESH)');
        } else if (allowApiIntegrityFallback()) {
          logger.info('   Fallback POST /integrity включён (TWITCH_INTEGRITY_FALLBACK_API=true)');
        }
      }
      return;
    }

    if (this.configuredSource === 'api') {
      logger.info('🔐  Integrity: api (POST /integrity)');
      if (isIntegrityAutoRefreshEnabled()) {
        logger.info(`   Device ID: ${this.deviceId.slice(0, 8)}… (задайте TWITCH_DEVICE_ID=unique_id для стабильности)`);
      }
      return;
    }

    logger.info('🔐  Integrity: auto (manual из конфига + автообновление через POST /integrity)');
    if (isIntegrityAutoRefreshEnabled()) {
      logger.info(`   Device ID: ${this.deviceId.slice(0, 8)}…`);
    }
  }

  /**
   * Возвращает стабильный device id для заголовков Twitch
   */
  getDeviceId(): string {
    const fromEnv = process.env.TWITCH_DEVICE_ID?.trim();
    return fromEnv || this.deviceId;
  }

  /**
   * Снимок состояния integrity для dashboard (без токена)
   */
  getHealthSnapshot(now = Date.now()): IntegrityHealthSnapshot {
    const fallbackApiEnabled = allowApiIntegrityFallback();
    let expiresAtMs: number | null = null;
    let configured = false;
    let valid = false;

    const manual = getManualIntegrityFromEnv(now);
    if (manual?.token) {
      configured = true;
      expiresAtMs = manual.expiresAtMs;
      valid = now < manual.expiresAtMs - 60_000;
    } else if (this.apiToken && now < this.apiExpiresAtMs - 60_000) {
      configured = true;
      valid = true;
      expiresAtMs = this.apiExpiresAtMs;
    } else if (this.configuredSource === 'api') {
      configured = true;
    }

    const expiresInMs =
      expiresAtMs != null && expiresAtMs > now ? expiresAtMs - now : expiresAtMs != null ? 0 : null;

    return {
      source: this.source,
      configured,
      valid,
      expiresAtMs,
      expiresInMs,
      fallbackApiEnabled,
      deviceIdPrefix: this.getDeviceId().slice(0, 8),
    };
  }

  /**
   * Сбрасывает кэш API-токена; manual перечитывается из env при следующем getToken
   */
  invalidate(): void {
    this.apiToken = null;
    this.apiExpiresAtMs = 0;
    this.apiRefreshPromise = null;
    if (this.configuredSource === 'manual' || this.configuredSource === 'auto') {
      logger.verbose(
        '🔐  Integrity invalidated — будет запрошен новый токен (POST /integrity), если автообновление включено'
      );
    }
  }

  /**
   * Возвращает актуальный Client-Integrity токен
   */
  async getToken(): Promise<string> {
    if (this.configuredSource === 'api') {
      return this.getApiToken();
    }

    if (this.configuredSource === 'manual') {
      return this.getManualOrFallbackToken();
    }

    return this.getAutoToken();
  }

  private async getAutoToken(): Promise<string> {
    const manual = getManualIntegrityFromEnv();
    if (
      manual &&
      Date.now() < manual.expiresAtMs - 60_000 &&
      !isManualIntegrityExpiringSoon(manual.expiresAtMs)
    ) {
      return manual.token;
    }

    if (!canRefreshIntegrityViaApi()) {
      if (manual) {
        return manual.token;
      }
      throw new Error(
        'Нет Client-Integrity. Задайте TWITCH_CLIENT_INTEGRITY или включите TWITCH_INTEGRITY_AUTO_REFRESH'
      );
    }

    return this.refreshApiTokenAndPersist();
  }

  private getManualOrFallbackToken(): Promise<string> {
    const manual = getManualIntegrityFromEnv();
    const now = Date.now();

    if (
      manual &&
      now < manual.expiresAtMs - 60_000 &&
      !isManualIntegrityExpiringSoon(manual.expiresAtMs)
    ) {
      return Promise.resolve(manual.token);
    }

    if (manual && now >= manual.expiresAtMs - 60_000) {
      logger.warn(
        '🔐  TWITCH_CLIENT_INTEGRITY истёк — обновление через POST /integrity (если включено автообновление)'
      );
    } else if (!manual) {
      logger.verbose('🔐  TWITCH_CLIENT_INTEGRITY не задан');
    }

    if (!canRefreshIntegrityViaApi()) {
      if (manual) {
        return Promise.resolve(manual.token);
      }
      throw new Error(
        'Нет действующего Client-Integrity. Скопируйте из DevTools → gql в «Конфиг бота»'
      );
    }

    return this.refreshApiTokenAndPersist();
  }

  private async getApiToken(): Promise<string> {
    const now = Date.now();
    if (this.apiToken && now < this.apiExpiresAtMs - 60_000) {
      return this.apiToken;
    }

    if (!this.apiRefreshPromise) {
      this.apiRefreshPromise = this.refreshApiTokenAndPersist().finally(() => {
        this.apiRefreshPromise = null;
      });
    }

    return this.apiRefreshPromise;
  }

  /**
   * Запрашивает новый токен у Twitch и при необходимости сохраняет в config.json
   */
  async refreshApiTokenAndPersist(): Promise<string> {
    const token = await this.fetchApiToken();
    persistIntegrityToAppConfig(token, this.apiExpiresAtMs, this.getDeviceId());
    return token;
  }

  private async fetchApiToken(): Promise<string> {
    const fetchTimeoutMs = parseInt(process.env.FETCH_TIMEOUT_MS || '20000', 10);
    const headers = await buildTwitchGqlHeaders({
      authToken: this.authToken,
      userAgent: this.userAgent,
      clientId: CLIENT_ID,
      deviceId: this.getDeviceId(),
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

    logger.verbose(
      `🔐  Client-Integrity refreshed via API (device ${this.getDeviceId().slice(0, 8)}…, TTL ~${Math.round(
        (this.apiExpiresAtMs - now) / 60_000
      )} мин)`
    );
    return this.apiToken;
  }

  private startProactiveRefresh(): void {
    const intervalMs = parseInt(process.env.TWITCH_INTEGRITY_REFRESH_CHECK_MS || '120000', 10);
    const ms = Number.isFinite(intervalMs) && intervalMs >= 30_000 ? intervalMs : 120_000;

    void this.maybeProactiveRefresh();

    this.proactiveRefreshTimer = setInterval(() => {
      void this.maybeProactiveRefresh();
    }, ms);

    if (typeof this.proactiveRefreshTimer.unref === 'function') {
      this.proactiveRefreshTimer.unref();
    }
  }

  private async maybeProactiveRefresh(): Promise<void> {
    if (!isIntegrityAutoRefreshEnabled() || !canRefreshIntegrityViaApi()) {
      return;
    }

    const now = Date.now();
    const lead = getIntegrityRefreshLeadMs();
    let shouldRefresh = false;

    const manual = getManualIntegrityFromEnv(now);
    if (manual) {
      shouldRefresh = isManualIntegrityExpiringSoon(manual.expiresAtMs, now);
    } else if (this.apiToken) {
      shouldRefresh = now >= this.apiExpiresAtMs - lead;
    } else {
      shouldRefresh = true;
    }

    if (!shouldRefresh) {
      return;
    }

    try {
      await this.refreshApiTokenAndPersist();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.verbose(`🔐  Проактивное обновление integrity не удалось: ${message}`);
    }
  }

  /**
   * Останавливает таймер проактивного обновления
   */
  dispose(): void {
    if (this.proactiveRefreshTimer) {
      clearInterval(this.proactiveRefreshTimer);
      this.proactiveRefreshTimer = null;
    }
  }
}
