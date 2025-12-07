/**
 * Менеджер для отслеживания и уведомлений об истечении токена
 */

import { TokenValidationResult } from './types';
import { logger } from './logger';
import { TwitchAPI } from './TwitchAPI';

/**
 * Обработчик событий токена
 */
export interface TokenEventHandler {
  /**
   * Вызывается когда токен скоро истечет
   * @param expiresAt Время истечения токена (timestamp)
   * @param minutesRemaining Минут до истечения
   */
  onTokenExpiringSoon?: (expiresAt: number, minutesRemaining: number) => void;

  /**
   * Вызывается когда токен истек
   */
  onTokenExpired?: () => void;

  /**
   * Вызывается когда токен невалиден
   */
  onTokenInvalid?: () => void;
}

/**
 * Конфигурация TokenManager
 */
export interface TokenManagerConfig {
  checkIntervalMs?: number; // Интервал проверки токена в миллисекундах (по умолчанию 5 минут)
  warningThresholdMinutes?: number; // За сколько минут до истечения предупреждать (по умолчанию 60 минут)
  enableNotifications?: boolean; // Включить уведомления (по умолчанию true)
}

/**
 * Менеджер для отслеживания состояния токена
 */
export class TokenManager {
  private twitchAPI: TwitchAPI;
  private config: Required<TokenManagerConfig>;
  private checkInterval: NodeJS.Timeout | null = null;
  private eventHandlers: TokenEventHandler;
  private lastValidationResult: TokenValidationResult | null = null;
  private isRunning = false;

  /**
   * Создает экземпляр TokenManager
   * @param twitchAPI Экземпляр TwitchAPI для валидации токена
   * @param config Конфигурация менеджера
   * @param eventHandlers Обработчики событий
   */
  constructor(
    twitchAPI: TwitchAPI,
    config: TokenManagerConfig = {},
    eventHandlers: TokenEventHandler = {}
  ) {
    this.twitchAPI = twitchAPI;
    this.config = {
      checkIntervalMs: config.checkIntervalMs ?? 5 * 60 * 1000, // 5 минут по умолчанию
      warningThresholdMinutes: config.warningThresholdMinutes ?? 60, // 60 минут по умолчанию
      enableNotifications: config.enableNotifications !== false,
    };
    this.eventHandlers = eventHandlers;
  }

  /**
   * Запускает периодическую проверку токена
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('⚠️  TokenManager is already running');
      return;
    }

    this.isRunning = true;
    
    // Выполняем первую проверку сразу
    this.checkToken();

    // Настраиваем периодическую проверку
    this.checkInterval = setInterval(() => {
      this.checkToken();
    }, this.config.checkIntervalMs);

    logger.info(`✅  TokenManager started (check interval: ${this.config.checkIntervalMs / 1000 / 60} minutes)`);
  }

  /**
   * Останавливает периодическую проверку токена
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    logger.verbose('🛑  TokenManager stopped');
  }

  /**
   * Выполняет проверку токена
   */
  private async checkToken(): Promise<void> {
    try {
      const result = await this.twitchAPI.validateTokenWithInfo();
      this.lastValidationResult = result;

      if (!result.isValid) {
        logger.warn('⚠️  Token validation failed - token is invalid');
        // Критическое уведомление - токен невалиден
        if (this.eventHandlers.onTokenInvalid) {
          this.eventHandlers.onTokenInvalid();
        }
        return;
      }

      // Если токен валиден, но нет информации о сроке действия
      if (!result.expiresAt) {
        logger.verbose('ℹ️  Token is valid, but expiration time is unknown');
        return;
      }

      // Проверяем, не истек ли токен
      const now = Date.now();
      if (result.expiresAt <= now) {
        logger.error('❌  Token has expired!');
        // Критическое уведомление - токен истек
        if (this.eventHandlers.onTokenExpired) {
          this.eventHandlers.onTokenExpired();
        }
        return;
      }

      // Проверяем, скоро ли истечет токен
      const minutesRemaining = Math.floor((result.expiresAt - now) / 1000 / 60);
      const warningThreshold = this.config.warningThresholdMinutes;

      // Не показываем предупреждения о скором истечении - только критические уведомления
      logger.verbose(`✅  Token is valid (expires in ${minutesRemaining} minutes)`);
    } catch (error: any) {
      logger.error(`❌  Error checking token: ${error.message || error}`);
    }
  }

  /**
   * Получает последний результат валидации
   * @returns Последний результат валидации или null
   */
  getLastValidationResult(): TokenValidationResult | null {
    return this.lastValidationResult;
  }

  /**
   * Выполняет немедленную проверку токена
   * @returns Результат валидации
   */
  async validateNow(): Promise<TokenValidationResult> {
    return await this.twitchAPI.validateTokenWithInfo();
  }

}

