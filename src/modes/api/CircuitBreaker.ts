/**
 * Реализация Circuit Breaker паттерна для защиты от каскадных сбоев
 */

import { logger } from './logger';

/**
 * Состояния Circuit Breaker
 */
export enum CircuitState {
  CLOSED = 'CLOSED',       // Нормальная работа, запросы проходят
  OPEN = 'OPEN',          // Слишком много ошибок, запросы блокируются
  HALF_OPEN = 'HALF_OPEN' // Тестирование восстановления
}

/**
 * Конфигурация Circuit Breaker
 */
export interface CircuitBreakerConfig {
  failureThreshold: number;      // Количество ошибок для перехода в OPEN
  resetTimeoutMs: number;         // Время ожидания перед переходом в HALF_OPEN
  halfOpenMaxAttempts: number;    // Количество попыток в HALF_OPEN перед переходом в CLOSED
}

/**
 * Параметры по умолчанию
 */
const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,  // 30 секунд
  halfOpenMaxAttempts: 1,
};

/**
 * Circuit Breaker для защиты от каскадных сбоев
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private config: CircuitBreakerConfig;
  private name: string;

  /**
   * Создает экземпляр Circuit Breaker
   * @param name Имя Circuit Breaker (для логирования)
   * @param config Конфигурация
   */
  constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Получает текущее состояние
   * @returns Текущее состояние
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Проверяет, можно ли выполнить запрос
   * @returns true если запрос можно выполнить
   */
  canExecute(): boolean {
    // Обновляем состояние на основе времени
    this.updateState();

    switch (this.state) {
      case CircuitState.CLOSED:
        return true;
      
      case CircuitState.OPEN:
        // Проверяем, прошло ли достаточно времени для перехода в HALF_OPEN
        const timeSinceLastFailure = Date.now() - this.lastFailureTime;
        if (timeSinceLastFailure >= this.config.resetTimeoutMs) {
          this.transitionToHalfOpen();
          return true;
        }
        return false;
      
      case CircuitState.HALF_OPEN:
        return true;
      
      default:
        return false;
    }
  }

  /**
   * Регистрирует успешное выполнение запроса
   */
  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      
      // Если успешных попыток достаточно, переходим в CLOSED
      if (this.successCount >= this.config.halfOpenMaxAttempts) {
        this.transitionToClosed();
        logger.info(`✅  [CircuitBreaker:${this.name}] Переход в состояние CLOSED после успешных попыток`);
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Сбрасываем счетчик ошибок при успехе
      this.failureCount = 0;
    }
  }

  /**
   * Регистрирует неудачное выполнение запроса
   */
  recordFailure(): void {
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.CLOSED) {
      this.failureCount++;
      
      // Если ошибок слишком много, переходим в OPEN
      if (this.failureCount >= this.config.failureThreshold) {
        this.transitionToOpen();
        logger.warn(`⚠️  [CircuitBreaker:${this.name}] Переход в состояние OPEN после ${this.failureCount} ошибок`);
      }
    } else if (this.state === CircuitState.HALF_OPEN) {
      // Если в HALF_OPEN произошла ошибка, сразу переходим в OPEN
      this.transitionToOpen();
      logger.warn(`⚠️  [CircuitBreaker:${this.name}] Переход в состояние OPEN из HALF_OPEN после ошибки`);
    }
  }

  /**
   * Выполняет функцию через Circuit Breaker
   * @param fn Функция для выполнения
   * @returns Результат выполнения функции
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      const error: any = new Error(`Circuit Breaker ${this.name} is OPEN. Request blocked.`);
      error.circuitBreakerOpen = true;
      throw error;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Обновляет состояние на основе времени
   */
  private updateState(): void {
    if (this.state === CircuitState.OPEN) {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure >= this.config.resetTimeoutMs) {
        this.transitionToHalfOpen();
      }
    }
  }

  /**
   * Переход в состояние OPEN
   */
  private transitionToOpen(): void {
    this.state = CircuitState.OPEN;
    this.successCount = 0;
  }

  /**
   * Переход в состояние HALF_OPEN
   */
  private transitionToHalfOpen(): void {
    this.state = CircuitState.HALF_OPEN;
    this.failureCount = 0;
    this.successCount = 0;
    logger.verbose(`🔄  [CircuitBreaker:${this.name}] Переход в состояние HALF_OPEN для тестирования`);
  }

  /**
   * Переход в состояние CLOSED
   */
  private transitionToClosed(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
  }

  /**
   * Сбрасывает состояние Circuit Breaker
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    logger.verbose(`🔄  [CircuitBreaker:${this.name}] Состояние сброшено`);
  }

  /**
   * Получает статистику Circuit Breaker
   * @returns Статистика
   */
  getStats(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    lastFailureTime: number;
  } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

