import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import { generate as generateSelfSigned } from 'selfsigned';
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
 * Проверяет, что пара cert/key подходит для TLS-сервера.
 */
function validateTlsPair(cert: string, key: string): boolean {
  try {
    tls.createSecureContext({ cert, key });
    return true;
  } catch {
    return false;
  }
}

/**
 * Загружает TLS-материалы; при отсутствии или повреждении создаёт самоподписанный сертификат.
 */
export async function ensureHttpsCredentials(): Promise<{ cert: string; key: string }> {
  const { certPath, keyPath } = resolveHttpsCredentialPaths();

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const cert = fs.readFileSync(certPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    if (validateTlsPair(cert, key)) {
      return { cert, key };
    }
    logger.warn('⚠️  Повреждённый TLS-сертификат, пересоздаём...');
    fs.unlinkSync(certPath);
    fs.unlinkSync(keyPath);
  }

  await generateSelfSignedCredentials(certPath, keyPath);

  const cert = fs.readFileSync(certPath, 'utf8');
  const key = fs.readFileSync(keyPath, 'utf8');
  if (!validateTlsPair(cert, key)) {
    throw new Error('Созданный TLS-сертификат не прошёл проверку');
  }
  return { cert, key };
}

/**
 * Список SAN для selfsigned / openssl.
 */
function buildSubjectAltNameEntries(): Array<{ type: 2; value: string } | { type: 7; ip: string }> {
  const entries: Array<{ type: 2; value: string } | { type: 7; ip: string }> = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];
  const extra = (process.env.SSL_EXTRA_SANS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const item of extra) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(item)) {
      entries.push({ type: 7, ip: item });
    } else {
      entries.push({ type: 2, value: item });
    }
  }
  return entries;
}

/**
 * Генерирует сертификат через selfsigned (Node, без openssl).
 */
async function generateWithSelfsigned(certPath: string, keyPath: string): Promise<void> {
  const cn = (process.env.SSL_CERT_CN || 'twitch-watcher').replace(/"/g, '');
  const altNames = buildSubjectAltNameEntries();

  const pems = await generateSelfSigned([{ name: 'commonName', value: cn }], {
    algorithm: 'sha256',
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  fs.writeFileSync(certPath, pems.cert, 'utf8');
  fs.writeFileSync(keyPath, pems.private, 'utf8');
  logger.info(`🔐  TLS-сертификат создан (selfsigned): ${certPath}`);
  logger.verbose(`    SAN: ${altNames.map((a) => ('value' in a ? a.value : a.ip)).join(', ')}`);
}

/**
 * Запасная генерация через openssl (если selfsigned недоступен).
 */
function generateWithOpenssl(certPath: string, keyPath: string): void {
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  const cn = (process.env.SSL_CERT_CN || 'twitch-watcher').replace(/"/g, '');
  const san = buildSubjectAltNameEntries()
    .map((a) => ('value' in a ? `DNS:${a.value}` : `IP:${a.ip}`))
    .join(',');
  const baseArgs = [
    'openssl req -x509',
    '-newkey rsa:2048',
    '-nodes',
    `-keyout "${keyPath}"`,
    `-out "${certPath}"`,
    '-days 825',
    `-subj "/CN=${cn}"`,
  ];
  const withSan = [...baseArgs, `-addext "subjectAltName=${san}"`].join(' ');
  const simple = baseArgs.join(' ');

  try {
    execSync(withSan, { stdio: 'pipe', encoding: 'utf8' });
  } catch {
    execSync(simple, { stdio: 'pipe', encoding: 'utf8' });
  }
  logger.info(`🔐  TLS-сертификат создан (openssl): ${certPath}`);
}

/**
 * Генерирует самоподписанный сертификат.
 */
async function generateSelfSignedCredentials(certPath: string, keyPath: string): Promise<void> {
  try {
    await generateWithSelfsigned(certPath, keyPath);
  } catch (selfsignedErr: unknown) {
    const msg = selfsignedErr instanceof Error ? selfsignedErr.message : String(selfsignedErr);
    logger.warn(`⚠️  selfsigned: ${msg}, пробуем openssl...`);
    try {
      generateWithOpenssl(certPath, keyPath);
    } catch (opensslErr: unknown) {
      const oMsg = opensslErr instanceof Error ? opensslErr.message : String(opensslErr);
      throw new Error(
        'Не удалось создать TLS-сертификат. Termux: pkg install openssl. '
        + `Ошибка: ${oMsg}`,
      );
    }
  }
}
