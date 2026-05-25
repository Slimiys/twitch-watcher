/**
 * Генерация самоподписанного сертификата для HTTPS дашборда.
 * Использование: npm run certs:generate
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const dir = process.env.SSL_DIR || path.join(process.cwd(), 'certs');
const certPath = process.env.SSL_CERT_PATH || path.join(dir, 'server.crt');
const keyPath = process.env.SSL_KEY_PATH || path.join(dir, 'server.key');
const cn = (process.env.SSL_CERT_CN || 'twitch-watcher').replace(/"/g, '');

function buildAltNames() {
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];
  const extra = (process.env.SSL_EXTRA_SANS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const item of extra) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(item)) {
      altNames.push({ type: 7, ip: item });
    } else {
      altNames.push({ type: 2, value: item });
    }
  }
  return altNames;
}

async function main() {
  const { generate } = await import('selfsigned');
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  const altNames = buildAltNames();
  const pems = await generate([{ name: 'commonName', value: cn }], {
    algorithm: 'sha256',
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.writeFileSync(certPath, pems.cert, 'utf8');
  fs.writeFileSync(keyPath, pems.private, 'utf8');
  console.log(`\n✅  Certificate: ${certPath}`);
  console.log(`✅  Private key:  ${keyPath}`);
  console.log('\nВ .env: WEB_SERVER_HTTPS=true');
}

main().catch((e) => {
  console.error('❌', e.message || e);
  process.exit(1);
});
