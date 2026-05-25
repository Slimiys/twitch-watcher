import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { upsertEnvFileKeys } from '../envFile';

describe('upsertEnvFileKeys', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-watcher-env-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds new keys', () => {
    const envPath = path.join(tmpDir, '.env');
    upsertEnvFileKeys(envPath, { WATCH_MODE: 'sequential', WATCH_CYCLE_INTERVAL_MS: '60000' });
    const content = fs.readFileSync(envPath, 'utf8');
    expect(content).toContain('WATCH_MODE=sequential');
    expect(content).toContain('WATCH_CYCLE_INTERVAL_MS=60000');
  });

  it('updates existing keys without removing other lines', () => {
    const envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath, 'FOO=bar\n# comment\nWATCH_MODE=batch\n', 'utf8');
    upsertEnvFileKeys(envPath, { WATCH_MODE: 'sequential' });
    const content = fs.readFileSync(envPath, 'utf8');
    expect(content).toContain('FOO=bar');
    expect(content).toContain('# comment');
    expect(content).toMatch(/WATCH_MODE=sequential/);
    expect(content).not.toMatch(/WATCH_MODE=batch/);
  });
});
