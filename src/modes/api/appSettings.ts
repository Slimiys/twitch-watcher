/**
 * Настройки приложения в config.json (вместо .env)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../../pidFile';
import { AppConfig } from '../../types';
import { APP_BOOLEAN_DEFAULT_TRUE, isAppBooleanEnabled, isFileLoggingEnabled } from './logSettings';

/** Значение-заглушка: поле заполнено, менять не нужно */
export const APP_SETTINGS_SECRET_PLACEHOLDER = '••••••••';

export type AppSettingInputType = 'text' | 'password' | 'number' | 'select' | 'boolean';

export interface AppSettingFieldMeta {
  key: string;
  label: string;
  section: string;
  inputType: AppSettingInputType;
  placeholder?: string;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  /** Требуется перезапуск процесса */
  restartRequired?: boolean;
  /** Скрыто в UI «Конфиг бота» (значение из config.json, расширения или авто) */
  hidden?: boolean;
}

const SECRET_KEYS = new Set([
  'token',
  'WEB_DASHBOARD_API_KEY',
  'TWITCH_CLIENT_INTEGRITY',
  'TWITCH_COOKIES',
  'proxyAuth',
]);

const RESTART_REQUIRED_KEYS = new Set([
  'HEALTH_CHECK_PORT',
  'WEB_SERVER_PORT',
  'WEB_SERVER_HTTPS',
  'SSL_DIR',
  'SSL_CERT_PATH',
  'SSL_KEY_PATH',
  'proxy',
  'proxyAuth',
  'FETCH_TIMEOUT_MS',
]);

/** Integrity читается при создании GraphQL-клиента — нужен перезапуск */
const INTEGRITY_RESTART_KEYS = new Set([
  'TWITCH_INTEGRITY_SOURCE',
  'TWITCH_CLIENT_INTEGRITY',
  'TWITCH_CLIENT_INTEGRITY_EXPIRES',
  'TWITCH_INTEGRITY_FALLBACK_API',
  'TWITCH_DEVICE_ID',
  'TWITCH_COOKIES',
  'TWITCH_CLIENT_VERSION',
  'TWITCH_CLIENT_SESSION_ID',
]);

/**
 * Описание полей для dashboard (группы и подписи)
 */
export const APP_SETTING_FIELDS: AppSettingFieldMeta[] = [
  {
    key: 'token',
    label: 'Токен (cookie: auth-token)',
    section: 'Авторизация',
    inputType: 'password',
    hint: 'DevTools → Application → Cookies → twitch.tv → auth-token. В gql также заголовок Authorization.',
    restartRequired: true,
  },
  {
    key: 'LOG_LEVEL',
    label: 'Уровень логов',
    section: 'Логирование',
    inputType: 'select',
    options: [
      { value: 'verbose', label: 'verbose' },
      { value: 'normal', label: 'normal' },
      { value: 'minimal', label: 'minimal' },
    ],
  },
  {
    key: 'LOG_TO_FILE',
    label: 'Писать логи в файлы',
    section: 'Логирование',
    inputType: 'boolean',
    hint: 'По умолчанию включено. Каталог — LOG_DIR (обычно ./logs)',
  },
  {
    key: 'LOG_DIR',
    label: 'Каталог логов',
    section: 'Логирование',
    inputType: 'text',
    placeholder: './logs',
    hidden: true,
  },
  {
    key: 'LOG_FILE_MAX_MB',
    label: 'Макс. размер файла (МБ)',
    section: 'Логирование',
    inputType: 'number',
    hidden: true,
  },
  {
    key: 'LOG_FILE_BASENAME',
    label: 'Базовое имя файла',
    section: 'Логирование',
    inputType: 'text',
    placeholder: 'twitch-watcher',
    hidden: true,
  },
  {
    key: 'LOG_CLEAR_ON_START',
    label: 'Очищать каталог логов при старте',
    section: 'Логирование',
    inputType: 'boolean',
    hidden: true,
  },
  {
    key: 'MAX_SIMULTANEOUS_CHANNELS',
    label: 'Макс. одновременных каналов',
    section: 'Просмотр',
    inputType: 'number',
    restartRequired: true,
  },
  {
    key: 'WATCH_PREP_INTERVAL_MS',
    label: 'Обновление стримера перед watch (мс)',
    section: 'Просмотр',
    inputType: 'number',
    hidden: true,
  },
  {
    key: 'WATCH_OPERATION_TIMEOUT_MS',
    label: 'Таймаут watch/spade (мс)',
    section: 'Просмотр',
    inputType: 'number',
    hidden: true,
  },
  {
    key: 'CLAIM_CHECK_INTERVAL_MS',
    label: 'Интервал опроса claim (мс)',
    section: 'Просмотр',
    inputType: 'number',
    hidden: true,
  },
  {
    key: 'CLAIM_FAILED_BLOCK_MS',
    label: 'Blocklist при FORBIDDEN (мс)',
    section: 'Просмотр',
    inputType: 'number',
    hidden: true,
  },
  {
    key: 'WATCH_RESUME_MAX_AGE_MS',
    label: 'Макс. возраст resume-состояния (мс)',
    section: 'Просмотр',
    inputType: 'number',
    hidden: true,
  },
  {
    key: 'FETCH_TIMEOUT_MS',
    label: 'Таймаут HTTP (мс)',
    section: 'Сеть',
    inputType: 'number',
    restartRequired: true,
  },
  {
    key: 'proxy',
    label: 'Прокси (host:port или URL)',
    section: 'Сеть',
    inputType: 'text',
    restartRequired: true,
  },
  {
    key: 'proxyAuth',
    label: 'Прокси: логин:пароль',
    section: 'Сеть',
    inputType: 'password',
    restartRequired: true,
  },
  {
    key: 'userAgent',
    label: 'User-Agent (заголовок: User-Agent)',
    section: 'Сеть',
    inputType: 'text',
    hint: 'Network → gql → Request Headers → User-Agent',
    restartRequired: true,
  },
  {
    key: 'TWITCH_USER_ID',
    label: 'User ID (ответ id.twitch.tv / validate)',
    section: 'Twitch',
    inputType: 'text',
    hint: 'Определяется автоматически через validate; задайте вручную только при недоступности id.twitch.tv',
    hidden: true,
  },
  {
    key: 'TWITCH_INTEGRITY_SOURCE',
    label: 'Источник integrity',
    section: 'Client-Integrity',
    inputType: 'select',
    options: [
      { value: 'auto', label: 'auto' },
      { value: 'manual', label: 'manual' },
      { value: 'api', label: 'api' },
    ],
    hint: 'Токен и GQL-заголовки передаёт расширение Edge или обновляет бот; статус — в панели Bot Health',
  },
  {
    key: 'TWITCH_CLIENT_INTEGRITY',
    label: 'Integrity (заголовок: Client-Integrity)',
    section: 'Client-Integrity',
    inputType: 'password',
    hint: 'Задаётся расширением Edge или автообновлением',
    hidden: true,
  },
  {
    key: 'TWITCH_CLIENT_INTEGRITY_EXPIRES',
    label: 'Срок integrity (ответ /integrity, expiration)',
    section: 'Client-Integrity',
    inputType: 'text',
    hint: 'Записывается автоматически при обновлении integrity',
    hidden: true,
  },
  {
    key: 'TWITCH_INTEGRITY_AUTO_REFRESH',
    label: 'Автообновление Client-Integrity',
    section: 'Client-Integrity',
    inputType: 'boolean',
    hint: 'По умолчанию включено: POST /integrity до истечения срока и при ошибке claim',
  },
  {
    key: 'TWITCH_INTEGRITY_AUTO_PERSIST',
    label: 'Сохранять integrity в config.json',
    section: 'Client-Integrity',
    inputType: 'boolean',
    hint: 'Включено по умолчанию',
    hidden: true,
  },
  {
    key: 'TWITCH_INTEGRITY_FALLBACK_API',
    label: 'Fallback POST /integrity (устаревшее)',
    section: 'Client-Integrity',
    inputType: 'boolean',
    hint: 'Не используется',
    hidden: true,
  },
  {
    key: 'TWITCH_DEVICE_ID',
    label: 'Device ID (заголовок: X-Device-Id)',
    section: 'Client-Integrity',
    inputType: 'text',
    hint: 'Передаётся расширением Edge или генерируется автоматически',
    hidden: true,
  },
  {
    key: 'TWITCH_COOKIES',
    label: 'Доп. cookies (unique_id, api_token, …)',
    section: 'Client-Integrity',
    inputType: 'password',
    hint: 'Передаётся расширением Edge',
    hidden: true,
  },
  {
    key: 'TWITCH_CLIENT_VERSION',
    label: 'Версия клиента (заголовок: Client-Version)',
    section: 'Client-Integrity',
    inputType: 'text',
    hint: 'Передаётся расширением Edge или подгружается ботом',
    hidden: true,
  },
  {
    key: 'TWITCH_CLIENT_SESSION_ID',
    label: 'Сессия (заголовок: Client-Session-Id)',
    section: 'Client-Integrity',
    inputType: 'text',
    hint: 'Передаётся расширением Edge или генерируется ботом',
    hidden: true,
  },
  {
    key: 'HEALTH_CHECK_PORT',
    label: 'Порт health-check',
    section: 'Сервер',
    inputType: 'number',
    restartRequired: true,
  },
  {
    key: 'WEB_SERVER_PORT',
    label: 'Порт dashboard',
    section: 'Сервер',
    inputType: 'number',
    restartRequired: true,
  },
  {
    key: 'WEB_SERVER_HTTPS',
    label: 'HTTPS для dashboard',
    section: 'Сервер',
    inputType: 'boolean',
    restartRequired: true,
  },
  {
    key: 'WEB_DASHBOARD_API_KEY',
    label: 'API-ключ dashboard',
    section: 'Сервер',
    inputType: 'password',
    hint: 'Заголовок X-API-Key. Пусто — без защиты.',
  },
  {
    key: 'DASHBOARD_UPDATE_ENABLED',
    label: 'Обновление с dashboard (Termux)',
    section: 'Сервер',
    inputType: 'boolean',
  },
  {
    key: 'DASHBOARD_UPDATE_GIT_BRANCH',
    label: 'Ветка git для обновления',
    section: 'Сервер',
    inputType: 'text',
    placeholder: 'dev',
  },
  {
    key: 'DASHBOARD_UPDATE_GIT_REMOTE',
    label: 'Git remote',
    section: 'Сервер',
    inputType: 'text',
    placeholder: 'origin',
  },
  {
    key: 'WS_HEALTH_CHECK_INTERVAL_MS',
    label: 'Проверка WebSocket (мс)',
    section: 'WebSocket',
    inputType: 'number',
    hidden: true,
  },
  {
    key: 'WS_CONNECT_TIMEOUT_MS',
    label: 'Таймаут подключения WS (мс)',
    section: 'WebSocket',
    inputType: 'number',
    hidden: true,
  },
  {
    key: 'AUTO_EXIT_ON_UNHEALTHY',
    label: 'Выход при unhealthy',
    section: 'Поведение',
    inputType: 'select',
    options: [
      { value: '', label: 'выкл. (по умолчанию)' },
      { value: 'true', label: 'true' },
      { value: 'false', label: 'false' },
    ],
    hidden: true,
  },
  {
    key: 'AUTO_EXIT_ON_INVALID_TOKEN',
    label: 'Выход при невалидном токене',
    section: 'Поведение',
    inputType: 'select',
    options: [
      { value: '', label: 'выкл. (по умолчанию)' },
      { value: 'true', label: 'true' },
      { value: 'false', label: 'false' },
    ],
    hidden: true,
  },
];

const APP_SETTING_KEYS = new Set(
  APP_SETTING_FIELDS.filter((f) => f.key !== 'token').map((f) => f.key)
);

/**
 * Поля, отображаемые в dashboard → «Конфиг бота»
 */
export function getVisibleAppSettingFields(): AppSettingFieldMeta[] {
  return APP_SETTING_FIELDS.filter((field) => !field.hidden);
}

/**
 * Путь к config.json
 */
export function getAppConfigPath(): string {
  return path.join(getProjectRoot(), 'config.json');
}

/**
 * Читает config.json целиком
 */
export function readAppConfigFile(configPath: string = getAppConfigPath()): AppConfig {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as AppConfig;
  } catch {
    return {};
  }
}

/**
 * Записывает config.json
 */
export function writeAppConfigFile(config: AppConfig, configPath: string = getAppConfigPath()): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Настройки из секции app
 */
export function getAppSettingsFromConfig(config: AppConfig): Record<string, string> {
  const app = config.app ?? {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(app)) {
    if (value === undefined || value === null) {
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

/**
 * Применяет app + token к process.env (только известные ключи)
 */
export function applyAppSettingsToProcessEnv(
  config: AppConfig,
  options?: { includeToken?: boolean }
): void {
  const settings = getAppSettingsFromConfig(config);
  for (const [key, value] of Object.entries(settings)) {
    if (!APP_SETTING_KEYS.has(key)) {
      continue;
    }
    if (value === '') {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  if (options?.includeToken !== false && config.token?.trim()) {
    process.env.token = config.token.trim();
  }
}

/**
 * Загружает config.json и гидратирует process.env (вызывать до setupNetwork)
 */
export function bootstrapAppSettings(configPath: string = getAppConfigPath()): void {
  const config = readAppConfigFile(configPath);
  applyAppSettingsToProcessEnv(config);
  if (!isFileLoggingEnabled()) {
    console.log(
      'ℹ️  Запись логов в файлы отключена (LOG_TO_FILE=false). Включите «Писать логи в файлы» в «Конфиг бота».'
    );
  }
}

/**
 * Сохраняет boolean-поле с учётом значения по умолчанию (не пишет true для opt-out полей)
 */
function persistBooleanAppSetting(config: AppConfig, key: string, enabled: boolean): void {
  if (!config.app) {
    config.app = {};
  }
  if (APP_BOOLEAN_DEFAULT_TRUE.has(key)) {
    if (enabled) {
      delete config.app[key];
      delete process.env[key];
    } else {
      config.app[key] = 'false';
      process.env[key] = 'false';
    }
    return;
  }
  if (enabled) {
    config.app[key] = 'true';
    process.env[key] = 'true';
  } else {
    delete config.app[key];
    delete process.env[key];
  }
}

/**
 * Маскирует секрет для API
 */
export function maskSecretValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) {
    return APP_SETTINGS_SECRET_PLACEHOLDER;
  }
  return `${APP_SETTINGS_SECRET_PLACEHOLDER}${trimmed.slice(-4)}`;
}

export interface AppSettingsApiSnapshot {
  settings: Record<string, string>;
  tokenSet: boolean;
  tokenMasked: string | null;
  fields: AppSettingFieldMeta[];
  configPath: string;
}

/**
 * Снимок для GET /api/app-settings
 */
export function readAppSettingsForApi(configPath: string = getAppConfigPath()): AppSettingsApiSnapshot {
  const config = readAppConfigFile(configPath);
  const raw = getAppSettingsFromConfig(config);
  const settings: Record<string, string> = {};

  for (const field of APP_SETTING_FIELDS) {
    if (field.key === 'token') {
      continue;
    }
    if (field.inputType === 'boolean') {
      settings[field.key] = isAppBooleanEnabled(field.key, raw[field.key]) ? 'true' : 'false';
      continue;
    }
    const value = raw[field.key];
    if (value === undefined) {
      continue;
    }
    if (SECRET_KEYS.has(field.key)) {
      settings[field.key] = maskSecretValue(value);
    } else {
      settings[field.key] = value;
    }
  }

  const token = config.token?.trim() ?? '';
  return {
    settings,
    tokenSet: token.length > 0,
    tokenMasked: token.length > 0 ? maskSecretValue(token) : null,
    fields: getVisibleAppSettingFields(),
    configPath,
  };
}

export interface ApplyAppSettingsInput {
  settings?: Record<string, string | boolean | number | null | undefined>;
  token?: string | null;
}

export interface ApplyAppSettingsResult extends AppSettingsApiSnapshot {
  message: string;
  restartRequired: boolean;
  restartReasons: string[];
}

/**
 * Сохраняет настройки в config.json и обновляет process.env
 */
export function applyAppSettingsFromInput(
  input: ApplyAppSettingsInput,
  configPath: string = getAppConfigPath()
): ApplyAppSettingsResult {
  const config = readAppConfigFile(configPath);
  if (!config.app) {
    config.app = {};
  }

  const restartReasons: string[] = [];
  const incoming = input.settings ?? {};

  for (const [key, rawValue] of Object.entries(incoming)) {
    if (key === 'token' || !APP_SETTING_KEYS.has(key)) {
      continue;
    }

    if (rawValue === null || rawValue === undefined) {
      delete config.app[key];
      delete process.env[key];
      continue;
    }

    const str = String(rawValue).trim();
    if (SECRET_KEYS.has(key) && str === APP_SETTINGS_SECRET_PLACEHOLDER) {
      continue;
    }
    if (str.startsWith(APP_SETTINGS_SECRET_PLACEHOLDER) && str.length > APP_SETTINGS_SECRET_PLACEHOLDER.length) {
      continue;
    }

    const fieldMeta = APP_SETTING_FIELDS.find((f) => f.key === key);
    if (fieldMeta?.inputType === 'boolean') {
      const enabled = str === 'true' || str === '1';
      const prev = config.app[key];
      persistBooleanAppSetting(config, key, enabled);
      if (INTEGRITY_RESTART_KEYS.has(key) && prev !== config.app[key]) {
        restartReasons.push(key);
      }
      continue;
    }

    if (str === '') {
      delete config.app[key];
      delete process.env[key];
      if (RESTART_REQUIRED_KEYS.has(key)) {
        restartReasons.push(key);
      }
      continue;
    }

    const prev = config.app[key];
    if (
      (RESTART_REQUIRED_KEYS.has(key) || INTEGRITY_RESTART_KEYS.has(key)) &&
      prev !== undefined &&
      String(prev) !== str
    ) {
      restartReasons.push(key);
    }
    if (INTEGRITY_RESTART_KEYS.has(key) && prev === undefined && str) {
      restartReasons.push(key);
    }

    config.app[key] = str;
    process.env[key] = str;
  }

  if (input.token !== undefined && input.token !== null) {
    const tokenStr = String(input.token).trim();
    if (tokenStr && tokenStr !== APP_SETTINGS_SECRET_PLACEHOLDER && !tokenStr.startsWith(APP_SETTINGS_SECRET_PLACEHOLDER)) {
      const prevToken = config.token;
      config.token = tokenStr;
      process.env.token = tokenStr;
      if (prevToken !== tokenStr) {
        restartReasons.push('token');
      }
    }
  }

  writeAppConfigFile(config, configPath);
  applyAppSettingsToProcessEnv(config);

  const uniqueReasons = [...new Set(restartReasons)];
  const restartRequired = uniqueReasons.length > 0;

  return {
    ...readAppSettingsForApi(configPath),
    message: restartRequired
      ? 'Настройки сохранены в config.json. Для части параметров нужен перезапуск бота.'
      : 'Настройки сохранены в config.json и применены.',
    restartRequired,
    restartReasons: uniqueReasons,
  };
}

/**
 * Значение настройки (после bootstrap — из process.env)
 */
export function getAppSetting(key: string): string | undefined {
  return process.env[key];
}
