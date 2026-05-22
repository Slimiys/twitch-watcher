import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Настраивает глобальный HTTP-клиент (undici): IPv4, таймауты, опциональный прокси.
 * Вызывать до любых fetch-запросов к Twitch.
 */
export function setupNetwork(): void {
  const undici = require('undici') as typeof import('undici');
  const fetchTimeoutMs = parseInt(process.env.FETCH_TIMEOUT_MS || '30000', 10);
  const connect = { family: 4 as const, timeout: fetchTimeoutMs };

  let proxyUrl =
    process.env.proxy?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    '';

  const proxyAuth = process.env.proxyAuth?.trim();
  if (proxyUrl && proxyAuth && !proxyUrl.includes('@')) {
    const colon = proxyAuth.indexOf(':');
    const user = colon >= 0 ? proxyAuth.slice(0, colon) : proxyAuth;
    const pass = colon >= 0 ? proxyAuth.slice(colon + 1) : '';
    const base = proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`;
    const parsed = new URL(base);
    parsed.username = encodeURIComponent(user);
    parsed.password = encodeURIComponent(pass);
    proxyUrl = parsed.toString();
  }

  if (proxyUrl) {
    const uri = proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`;
    undici.setGlobalDispatcher(new undici.ProxyAgent({ uri, connect }));
    const safeUrl = uri.replace(/:[^:@/]+@/, ':****@');
    console.log('✅  Proxy configured:', safeUrl);
    return;
  }

  undici.setGlobalDispatcher(
    new undici.Agent({
      connect,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: 50,
    })
  );
  console.log('✅  HTTP client: IPv4, keep-alive (Docker-friendly)');
}
