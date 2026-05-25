import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('getAppVersionLabel', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.GIT_COMMIT;
    delete process.env.GIT_REVISION;
    delete process.env.APP_REVISION;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('формат semver.revision при GIT_COMMIT из env', async () => {
    process.env.GIT_COMMIT = 'deadbeef1234';
    const { getAppVersionLabel } = await import('../appVersion');
    const label = getAppVersionLabel();
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
    ) as { version: string };

    expect(label).toBe(`${pkg.version}.deadbeef1234`);
  });
});
