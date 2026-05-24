/**
 * Получение Client-Integrity токена для защищённых GraphQL-мутаций Twitch
 */

import { CLIENT_ID } from './constants';
import { logger } from './logger';
import * as crypto from 'crypto';

const INTEGRITY_URL = 'https://gql.twitch.tv/integrity';

/**
 * Кэширует integrity-токен и device id для ClaimCommunityPoints и подобных операций
 */
export class TwitchIntegrityProvider {
  private token: string | null = null;
  private expiresAtMs = 0;
  private readonly deviceId: string;

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
  }

  /**
   * Возвращает актуальный Client-Integrity токен
   */
  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.expiresAtMs - 60_000) {
      return this.token;
    }

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

    this.token = data.token;
    // Twitch возвращает expiration в секундах unix time
    this.expiresAtMs =
      data.expiration != null && data.expiration > 1_000_000_000_000
        ? data.expiration
        : (data.expiration ?? 0) * 1000;

    if (this.expiresAtMs <= now) {
      this.expiresAtMs = now + 4 * 60 * 60 * 1000;
    }

    logger.verbose(`🔐  Client-Integrity token refreshed (device ${this.deviceId.slice(0, 8)}...)`);
    return this.token;
  }
}
