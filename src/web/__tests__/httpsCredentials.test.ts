import { afterEach, describe, expect, it } from 'vitest';
import {
  getWebServerScheme,
  isWebServerHttpsEnabled,
  resolveHttpsCredentialPaths,
} from '../httpsCredentials';

describe('httpsCredentials', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('HTTPS выключен по умолчанию', () => {
    delete process.env.WEB_SERVER_HTTPS;
    expect(isWebServerHttpsEnabled()).toBe(false);
    expect(getWebServerScheme()).toBe('http');
  });

  it('HTTPS включается через WEB_SERVER_HTTPS=true', () => {
    process.env.WEB_SERVER_HTTPS = 'true';
    expect(isWebServerHttpsEnabled()).toBe(true);
    expect(getWebServerScheme()).toBe('https');
  });

  it('resolveHttpsCredentialPaths использует SSL_DIR', () => {
    process.env.SSL_DIR = '/tmp/test-certs';
    delete process.env.SSL_CERT_PATH;
    delete process.env.SSL_KEY_PATH;
    const paths = resolveHttpsCredentialPaths();
    expect(paths.certPath).toContain('test-certs');
    expect(paths.keyPath).toContain('server.key');
  });
});
