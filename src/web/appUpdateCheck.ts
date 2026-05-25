/**
 * Проверка наличия новой ревизии на удалённой ветке (для dashboard)
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getAppVersionParts } from '../appVersion';
import { getProjectRoot } from '../pidFile';

/** Результат сравнения локальной и удалённой ревизии */
export interface AppUpdateCheckResult {
  branch: string;
  remote: string;
  localRevision: string;
  remoteRevision: string | null;
  updateAvailable: boolean;
  checkedAt: number;
  error: string | null;
  checkSkippedReason: string | null;
}

let cached: { at: number; result: AppUpdateCheckResult } | null = null;

const CACHE_MS = 45_000;
const LS_REMOTE_TIMEOUT_MS = 20_000;

/**
 * Ветка для проверки обновлений (как при git pull)
 */
export function getUpdateCheckBranch(): string {
  return process.env.DASHBOARD_UPDATE_GIT_BRANCH?.trim() || 'dev';
}

/**
 * Удалённый репозиторий (по умолчанию origin)
 */
export function getUpdateCheckRemote(): string {
  return process.env.DASHBOARD_UPDATE_GIT_REMOTE?.trim() || 'origin';
}

/**
 * Сравнивает HEAD с refs/heads/&lt;branch&gt; на remote через git ls-remote
 * @param forceRefresh игнорировать кэш (клик по версии)
 */
export function checkAppUpdateAvailable(forceRefresh = false): AppUpdateCheckResult {
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.at < CACHE_MS) {
    return cached.result;
  }

  const branch = getUpdateCheckBranch();
  const remote = getUpdateCheckRemote();
  const { revision: localRevision } = getAppVersionParts();

  if (process.platform === 'win32') {
    const result: AppUpdateCheckResult = {
      branch,
      remote,
      localRevision,
      remoteRevision: null,
      updateAvailable: false,
      checkedAt: now,
      error: null,
      checkSkippedReason: 'Проверка обновлений недоступна на Windows',
    };
    cached = { at: now, result };
    return result;
  }

  const projectRoot = getProjectRoot();
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    const result: AppUpdateCheckResult = {
      branch,
      remote,
      localRevision,
      remoteRevision: null,
      updateAvailable: false,
      checkedAt: now,
      error: null,
      checkSkippedReason: 'Не git-репозиторий',
    };
    cached = { at: now, result };
    return result;
  }

  try {
    const remoteRevision = resolveRemoteBranchRevision(projectRoot, remote, branch);
    const updateAvailable =
      remoteRevision != null &&
      localRevision !== 'unknown' &&
      !revisionsMatch(localRevision, remoteRevision);

    const result: AppUpdateCheckResult = {
      branch,
      remote,
      localRevision,
      remoteRevision,
      updateAvailable,
      checkedAt: now,
      error: null,
      checkSkippedReason: null,
    };
    cached = { at: now, result };
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: AppUpdateCheckResult = {
      branch,
      remote,
      localRevision,
      remoteRevision: null,
      updateAvailable: false,
      checkedAt: now,
      error: message,
      checkSkippedReason: null,
    };
    cached = { at: now, result };
    return result;
  }
}

/** Сброс кэша (тесты) */
export function clearAppUpdateCheckCache(): void {
  cached = null;
}

function resolveRemoteBranchRevision(root: string, remote: string, branch: string): string | null {
  const ref = `refs/heads/${branch}`;
  const out = execFileSync(
    'git',
    ['ls-remote', remote, ref],
    {
      encoding: 'utf8',
      cwd: root,
      timeout: LS_REMOTE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  ).trim();

  if (!out) {
    return null;
  }

  const sha = out.split(/\s+/)[0]?.trim();
  if (!sha) {
    return null;
  }

  return shortenRevision(sha);
}

function shortenRevision(revision: string): string {
  const normalized = revision.trim().replace(/^sha:/i, '');
  if (normalized.length <= 12) {
    return normalized;
  }
  try {
    return execFileSync('git', ['rev-parse', '--short=12', normalized], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return normalized.slice(0, 12);
  }
}

/**
 * Сравнение коротких hash (общий префикс 7+ символов)
 */
export function revisionsMatch(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  const minLen = Math.min(left.length, right.length, 12);
  if (minLen >= 7) {
    return left.slice(0, minLen) === right.slice(0, minLen);
  }
  return false;
}
