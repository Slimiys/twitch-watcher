import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PingPongFileLogger } from '../PingPongFileLogger';

describe('PingPongFileLogger', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createLogger(maxBytes: number): PingPongFileLogger {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-log-'));
    tempDirs.push(dir);
    return new PingPongFileLogger(dir, 'test', maxBytes);
  }

  it('пишет в первый файл, пока не достигнут лимит', () => {
    const logger = createLogger(50);
    const [p1, p2] = logger.getLogPaths();

    logger.append('line-a');

    expect(fs.existsSync(p1)).toBe(true);
    expect(fs.readFileSync(p1, 'utf8')).toContain('line-a');
    expect(fs.existsSync(p2)).toBe(false);
  });

  it('переключается на второй файл, затем очищает первый (ping-pong)', () => {
    const logger = createLogger(5);
    const [p1, p2] = logger.getLogPaths();

    logger.append('aaaa');
    logger.append('bb');
    expect(fs.readFileSync(p2, 'utf8')).toContain('bb');

    logger.append('ccccc');
    logger.append('dd');
    logger.append('eee');

    expect(fs.readFileSync(p1, 'utf8')).toContain('eee');
    expect(fs.statSync(p1).size).toBeLessThan(10);
  });
});
