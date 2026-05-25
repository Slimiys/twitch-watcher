import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Корень проекта (package.json, .git) */
const projectRoot = path.join(__dirname, '..');

let cachedVersionLabel: string | null = null;

/**
 * Semver, git revision и полная метка версии
 */
export function getAppVersionParts(): { semver: string; revision: string; label: string } {
  const semver = readPackageVersion();
  const revision = resolveGitRevision();
  return { semver, revision, label: `${semver}.${revision}` };
}

/**
 * Возвращает метку версии приложения: semver и короткий hash коммита (например 0.5.2.a1b2c3d4e5f6).
 */
export function getAppVersionLabel(): string {
  if (cachedVersionLabel) {
    return cachedVersionLabel;
  }
  cachedVersionLabel = getAppVersionParts().label;
  return cachedVersionLabel;
}

function readPackageVersion(): string {
  try {
    const packagePath = path.join(projectRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: string };
    return pkg.version?.trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function resolveGitRevision(): string {
  const fromEnv =
    process.env.GIT_COMMIT?.trim() ||
    process.env.GIT_REVISION?.trim() ||
    process.env.APP_REVISION?.trim();

  if (fromEnv) {
    return fromEnv.replace(/^sha:/i, '');
  }

  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}
