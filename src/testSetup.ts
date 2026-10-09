import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll } from 'vitest';

// Set before importing application modules: logger initialization must never touch real logs.
const logDir = mkdtempSync(join(tmpdir(), 'twitch-watcher-test-logs-'));
process.env.LOG_DIR = logDir;
process.env.LOG_TO_FILE = 'false';
process.env.LOG_CLEAR_ON_START = 'false';
afterAll(() => rmSync(logDir, { recursive: true, force: true }));
