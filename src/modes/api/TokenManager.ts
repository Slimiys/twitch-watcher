/**
 * Менеджер для отслеживания и уведомлений об истечении токена
 */

import { TokenValidationResult } from './types';
import { logger } from './logger';
import { TwitchAPI } from './TwitchAPI';
import * as notifier from 'node-notifier';

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
        if (this.config.enableNotifications) {
          this.sendNotification(
            'Token Invalid',
            'Your Twitch token is invalid. Please update it in config.json or .env file.',
            'error'
          );
          if (this.eventHandlers.onTokenInvalid) {
            this.eventHandlers.onTokenInvalid();
          }
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
        if (this.config.enableNotifications) {
          this.sendNotification(
            'Token Expired',
            'Your Twitch token has expired. Please update it in config.json or .env file.',
            'error'
          );
          if (this.eventHandlers.onTokenExpired) {
            this.eventHandlers.onTokenExpired();
          }
        }
        return;
      }

      // Проверяем, скоро ли истечет токен
      const minutesRemaining = Math.floor((result.expiresAt - now) / 1000 / 60);
      const warningThreshold = this.config.warningThresholdMinutes;

      if (minutesRemaining <= warningThreshold && this.config.enableNotifications) {
        const hoursRemaining = Math.floor(minutesRemaining / 60);
        const minutesPart = minutesRemaining % 60;
        const timeText = hoursRemaining > 0 
          ? `${hoursRemaining}h ${minutesPart}m`
          : `${minutesRemaining}m`;
        
        this.sendNotification(
          'Token Expiring Soon',
          `Your Twitch token will expire in ${timeText}. Please update it soon.`,
          'warning'
        );
        
        if (this.eventHandlers.onTokenExpiringSoon) {
          this.eventHandlers.onTokenExpiringSoon(result.expiresAt, minutesRemaining);
        }
      } else {
        logger.verbose(`✅  Token is valid (expires in ${minutesRemaining} minutes)`);
      }
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

  /**
   * Отправляет уведомление через node-notifier
   * @param title Заголовок уведомления
   * @param message Текст уведомления
   * @param type Тип уведомления
   */
  private sendNotification(title: string, message: string, type: 'info' | 'warning' | 'error'): void {
    try {
      notifier.notify({
        title: `Twitch Watcher - ${title}`,
        message: message,
        sound: type === 'error',
        wait: false,
      });
      logger.info(`📢  Notification sent: ${title} - ${message}`);
    } catch (error: any) {
      logger.warn(`⚠️  Failed to send notification: ${error.message || error}`);
    }
  }
}

