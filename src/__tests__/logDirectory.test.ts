import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearLogDirectoryOnStartup } from '../logDirectory';

describe('logDirectory', () => {
  const envBackup = { ...process.env };
  let tempDir: string;

  afterEach(() => {
    process.env = { ...envBackup };
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('удаляет все файлы в каталоге при LOG_CLEAR_ON_START', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-logs-'));
    fs.writeFileSync(path.join(tempDir, 'twitch-watcher.1.log'), 'old');
    fs.writeFileSync(path.join(tempDir, 'dashboard-update.log'), 'old');
    fs.writeFileSync(path.join(tempDir, 'crash.log'), 'old');

    delete process.env.LOG_CLEAR_ON_START;
    const removed = clearLogDirectoryOnStartup(tempDir);

    expect(removed).toBe(3);
    expect(fs.readdirSync(tempDir)).toHaveLength(0);
  });

  it('не удаляет файлы при LOG_CLEAR_ON_START=false', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-logs-'));
    fs.writeFileSync(path.join(tempDir, 'keep.log'), 'stay');

    process.env.LOG_CLEAR_ON_START = 'false';
    const removed = clearLogDirectoryOnStartup(tempDir);

    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(tempDir, 'keep.log'))).toBe(true);
  });
});
