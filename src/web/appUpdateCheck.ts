/**
 * Проверка наличия новой ревизии на удалённой ветке (для dashboard)
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getAppVersionParts } from '../appVersion';
import { getProjectRoot } from '../pidFile';

export type AppUpdateCheckStatus = 'current' | 'available' | 'error' | 'skipped';

/** Результат сравнения локальной и удалённой ревизии */
export interface AppUpdateCheckResult {
  branch: string;
  remote: string;
  localRevision: string;
  remoteRevision: string | null;
  localRevisionFull: string;
  remoteRevisionFull: string | null;
  /** ISO 8601 — дата коммита локального HEAD */
  localRevisionCommittedAt: string | null;
  /** ISO 8601 — дата коммита на remote (если объект известен локально) */
  remoteRevisionCommittedAt: string | null;
  updateAvailable: boolean;
  checkStatus: AppUpdateCheckStatus;
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
 * Сравнивает локальный HEAD с refs/heads/&lt;branch&gt; на remote через git ls-remote
 * @param forceRefresh игнорировать кэш (клик по версии)
 */
export function checkAppUpdateAvailable(forceRefresh = false): AppUpdateCheckResult {
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.at < CACHE_MS) {
    return cached.result;
  }

  const branch = getUpdateCheckBranch();
  const remote = getUpdateCheckRemote();
  const fallback = getAppVersionParts();

  if (process.platform === 'win32') {
    return storeCache(now, buildSkipped(branch, remote, fallback.revision, 'Проверка обновлений недоступна на Windows'));
  }

  const projectRoot = getProjectRoot();
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    return storeCache(
      now,
      buildSkipped(branch, remote, fallback.revision, 'Не git-репозиторий')
    );
  }

  try {
    const local = resolveLocalHeadRevision(projectRoot);
    const localRevisionFull = local?.full ?? fallback.revision;
    const localRevision = local?.short ?? shortenRevision(localRevisionFull);

    const remoteFull = resolveRemoteBranchRevisionFull(projectRoot, remote, branch);
    const remoteRevision = remoteFull ? shortenRevision(remoteFull) : null;
    const localRevisionCommittedAt = resolveCommitCommittedAt(projectRoot, localRevisionFull);
    const remoteRevisionCommittedAt = remoteFull
      ? resolveCommitCommittedAt(projectRoot, remoteFull)
      : null;

    const updateAvailable =
      remoteFull != null &&
      localRevisionFull !== 'unknown' &&
      !revisionsMatch(localRevisionFull, remoteFull);

    const checkStatus: AppUpdateCheckStatus = updateAvailable ? 'available' : 'current';

    return storeCache(now, {
      branch,
      remote,
      localRevision,
      remoteRevision,
      localRevisionFull,
      remoteRevisionFull: remoteFull,
      localRevisionCommittedAt,
      remoteRevisionCommittedAt,
      updateAvailable,
      checkStatus,
      checkedAt: now,
      error: null,
      checkSkippedReason: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return storeCache(now, {
      branch,
      remote,
      localRevision: fallback.revision,
      remoteRevision: null,
      localRevisionFull: fallback.revision,
      remoteRevisionFull: null,
      localRevisionCommittedAt: null,
      remoteRevisionCommittedAt: null,
      updateAvailable: false,
      checkStatus: 'error',
      checkedAt: now,
      error: message,
      checkSkippedReason: null,
    });
  }
}

/** Сброс кэша (тесты) */
export function clearAppUpdateCheckCache(): void {
  cached = null;
}

function storeCache(at: number, result: AppUpdateCheckResult): AppUpdateCheckResult {
  cached = { at, result };
  return result;
}

function buildSkipped(
  branch: string,
  remote: string,
  localRevision: string,
  reason: string
): AppUpdateCheckResult {
  return {
    branch,
    remote,
    localRevision,
    remoteRevision: null,
    localRevisionFull: localRevision,
    remoteRevisionFull: null,
    localRevisionCommittedAt: null,
    remoteRevisionCommittedAt: null,
    updateAvailable: false,
    checkStatus: 'skipped',
    checkedAt: Date.now(),
    error: null,
    checkSkippedReason: reason,
  };
}

/**
 * Дата коммита в ISO 8601 (git show)
 */
function resolveCommitCommittedAt(root: string, revision: string): string | null {
  if (!revision || revision === 'unknown') {
    return null;
  }
  try {
    const iso = execFileSync('git', ['show', '-s', '--format=%cI', revision], {
      encoding: 'utf8',
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return iso || null;
  } catch {
    return null;
  }
}

function resolveLocalHeadRevision(root: string): { full: string; short: string } | null {
  try {
    const full = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const short = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { full, short };
  } catch {
    return null;
  }
}

function resolveRemoteBranchRevisionFull(root: string, remote: string, branch: string): string | null {
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
  return sha || null;
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
 * Сравнение ревизий (полный hash или общий префикс коротких)
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
  if (left.length >= 40 && right.length >= 40) {
    return left === right;
  }
  const minLen = Math.min(left.length, right.length, 12);
  if (minLen >= 7) {
    return left.slice(0, minLen) === right.slice(0, minLen);
  }
  return false;
}
