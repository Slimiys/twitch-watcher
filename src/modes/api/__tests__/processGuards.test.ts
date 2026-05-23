import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writeCrashReport, logFatalExit } from '../../../processGuards';

describe('processGuards', () => {
  let tempDir: string;
  let crashLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-crash-'));
    crashLogPath = path.join(tempDir, 'crash.log');
    process.env.CRASH_LOG_PATH = crashLogPath;
  });

  afterEach(() => {
    delete process.env.CRASH_LOG_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writeCrashReport создаёт JSON-запись в crash.log', () => {
    writeCrashReport('testEvent', { foo: 'bar' });

    expect(fs.existsSync(crashLogPath)).toBe(true);
    const content = fs.readFileSync(crashLogPath, 'utf8');
    expect(content).toContain('CRASH REPORT');
    expect(content).toContain('"eventType": "testEvent"');
    expect(content).toContain('"foo": "bar"');
  });

  it('logFatalExit пишет fatalExit с stack', () => {
    const error = new Error('boom');
    logFatalExit('unit-test', 'test fatal', error);

    const content = fs.readFileSync(crashLogPath, 'utf8');
    expect(content).toContain('"eventType": "fatalExit"');
    expect(content).toContain('"source": "unit-test"');
    expect(content).toContain('boom');
    expect(content).toContain('--- stack ---');
  });
});
