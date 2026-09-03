import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_SETTINGS_SECRET_PLACEHOLDER,
  applyAppSettingsFromInput,
  bootstrapAppSettings,
  maskSecretValue,
  readAppSettingsForApi,
} from '../appSettings';

describe('appSettings', () => {
  let tmpDir: string;
  let configPath: string;
  const envBackup = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-app-settings-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    process.env = { ...envBackup };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('masks secrets for API', () => {
    expect(maskSecretValue('abcdefgh')).toContain('efgh');
    expect(maskSecretValue('ab')).toBe(APP_SETTINGS_SECRET_PLACEHOLDER);
  });

  it('bootstraps process.env from config.app', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        token: 'secret-token',
        app: { LOG_LEVEL: 'minimal', WEB_SERVER_PORT: '3999' },
      }),
      'utf8'
    );

    bootstrapAppSettings(configPath);

    expect(process.env.token).toBe('secret-token');
    expect(process.env.LOG_LEVEL).toBe('minimal');
    expect(process.env.WEB_SERVER_PORT).toBe('3999');
  });

  it('saves settings and keeps masked secrets unchanged', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        app: { WEB_DASHBOARD_API_KEY: 'my-secret-key' },
      }),
      'utf8'
    );

    const snapshot = readAppSettingsForApi(configPath);
    expect(snapshot.settings.WEB_DASHBOARD_API_KEY).toContain('••••');

    const result = applyAppSettingsFromInput(
      {
        settings: {
          WEB_DASHBOARD_API_KEY: snapshot.settings.WEB_DASHBOARD_API_KEY,
          LOG_LEVEL: 'normal',
        },
      },
      configPath
    );

    const file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(file.app.WEB_DASHBOARD_API_KEY).toBe('my-secret-key');
    expect(file.app.LOG_LEVEL).toBe('normal');
    expect(result.settings.LOG_LEVEL).toBe('normal');
  });

  it('excludes hidden fields from API snapshot', () => {
    const snapshot = readAppSettingsForApi(configPath);
    const hiddenKeys = new Set(
      snapshot.fields.filter((field) => field.hidden).map((field) => field.key)
    );
    expect(hiddenKeys.size).toBe(0);
    expect(snapshot.fields.some((field) => field.key === 'TWITCH_CLIENT_INTEGRITY')).toBe(false);
    expect(snapshot.fields.some((field) => field.key === 'TWITCH_INTEGRITY_SOURCE')).toBe(true);
  });

  it('updates token when provided', () => {
    const result = applyAppSettingsFromInput({ token: 'new-token-value' }, configPath);
    const file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(file.token).toBe('new-token-value');
    expect(result.tokenSet).toBe(true);
    expect(result.restartRequired).toBe(true);
  });
});
