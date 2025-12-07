/**
 * Утилита для загрузки конфигурации retry из config.json
 */

import * as fs from 'fs';
import { RetryConfig } from './types';

/**
 * Загружает конфигурацию retry из config.json
 * @returns Конфигурация retry или значения по умолчанию
 */
export function loadRetryConfig(): RetryConfig {
  const configPath = './config.json';
  
  try {
    if (fs.existsSync(configPath)) {
      const configFile = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      if (configFile.retry) {
        return configFile.retry;
      }
    }
  } catch (error) {
    // Игнорируем ошибки загрузки, используем значения по умолчанию
  }
  
  // Значения по умолчанию
  return {
    maxAttempts: 5,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    multiplier: 2,
    jitter: true,
    circuitBreaker: {
      failureThreshold: 5,
      resetTimeoutMs: 30000,
      halfOpenMaxAttempts: 1,
    },
    websocket: {
      maxReconnectAttempts: 10,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
    },
  };
}

