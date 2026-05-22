/**
 * Генерация самоподписанного сертификата для HTTPS дашборда.
 * Использование: npm run certs:generate
 * Переменные: SSL_DIR, SSL_CERT_CN, SSL_EXTRA_SANS (через .env или export)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const dir = process.env.SSL_DIR || path.join(process.cwd(), 'certs');
const certPath = process.env.SSL_CERT_PATH || path.join(dir, 'server.crt');
const keyPath = process.env.SSL_KEY_PATH || path.join(dir, 'server.key');
const cn = (process.env.SSL_CERT_CN || 'twitch-watcher').replace(/"/g, '');

function buildSan() {
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

fs.mkdirSync(path.dirname(certPath), { recursive: true });
const san = buildSan();
const cmd = [
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
  execSync(cmd, { stdio: 'inherit' });
  console.log(`\n✅  Certificate: ${certPath}`);
  console.log(`✅  Private key:  ${keyPath}`);
  console.log(`    SAN: ${san}`);
  console.log('\nВ .env добавьте: WEB_SERVER_HTTPS=true');
} catch (e) {
  console.error('❌  openssl не найден или команда завершилась с ошибкой.');
  console.error('    Termux: pkg install openssl');
  process.exit(1);
}
