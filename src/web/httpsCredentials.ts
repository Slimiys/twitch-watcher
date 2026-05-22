import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../modes/api/logger';

export interface HttpsCredentialPaths {
  certPath: string;
  keyPath: string;
}

/**
 * Включён ли HTTPS для дашборда (WEB_SERVER_HTTPS).
 */
export function isWebServerHttpsEnabled(): boolean {
  const value = (process.env.WEB_SERVER_HTTPS || '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * Схема URL веб-сервера: http или https.
 */
export function getWebServerScheme(): 'http' | 'https' {
  return isWebServerHttpsEnabled() ? 'https' : 'http';
}

/**
 * Пути к сертификату и ключу (SSL_DIR / SSL_CERT_PATH / SSL_KEY_PATH).
 */
export function resolveHttpsCredentialPaths(): HttpsCredentialPaths {
  const dir = process.env.SSL_DIR || path.join(process.cwd(), 'certs');
  const certPath = process.env.SSL_CERT_PATH || path.join(dir, 'server.crt');
  const keyPath = process.env.SSL_KEY_PATH || path.join(dir, 'server.key');
  return { certPath, keyPath };
}

/**
 * Загружает TLS-материалы; при отсутствии файлов создаёт самоподписанный сертификат (openssl).
 */
export function ensureHttpsCredentials(): { cert: string; key: string } {
  const { certPath, keyPath } = resolveHttpsCredentialPaths();

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    generateSelfSignedCredentials(certPath, keyPath);
  }

  return {
    cert: fs.readFileSync(certPath, 'utf8'),
    key: fs.readFileSync(keyPath, 'utf8'),
  };
}

/**
 * Формирует subjectAltName для openssl (localhost + опционально SSL_EXTRA_SANS).
 */
function buildSubjectAltName(): string {
  const entries = ['DNS:localhost', 'IP:127.0.0.1'];
  const extra = (process.env.SSL_EXTRA_SANS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const item of extra) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(item)) {
      entries.push(`IP:${item}`);
    } else {
      entries.push(`DNS:${item}`);
    }
  }

  return entries.join(',');
}

/**
 * Генерирует самоподписанный сертификат через openssl.
 */
function generateSelfSignedCredentials(certPath: string, keyPath: string): void {
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  const cn = (process.env.SSL_CERT_CN || 'twitch-watcher').replace(/"/g, '');
  const san = buildSubjectAltName();
  const opensslCmd = [
    'openssl req -x509',
    '-newkey rsa:2048',
    '-nodes',
    `-keyout "${keyPath}"`,
    `-out "${certPath}"`,
    '-days 825',
    `-subj "/CN=${cn}"`,
    `-addext "subjectAltName=${san}"`,
  ].join(' ');

  try {
    execSync(opensslCmd, { stdio: 'pipe', encoding: 'utf8' });
    logger.info(`🔐  Создан самоподписанный TLS-сертификат: ${certPath}`);
    logger.verbose(`    SAN: ${san}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Не удалось создать SSL-сертификат (нужен openssl в PATH). `
      + `Выполните: npm run certs:generate. ${message}`,
    );
  }
}
