#!/usr/bin/env bash
# Обновление с dashboard: git pull, run-local.sh --update-only, перезапуск npm start
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=termux-common.sh
source "$(dirname "$0")/termux-common.sh"
cd "$ROOT"

BRANCH="${DASHBOARD_UPDATE_GIT_BRANCH:-dev}"
LOG_DIR="${LOG_DIR:-$ROOT/logs}"
mkdir -p "$LOG_DIR"
dashboard_action_lock_acquire
trap dashboard_action_lock_release EXIT
exec >>"$LOG_DIR/dashboard-update.log" 2>&1

echo "========================================"
echo "  Dashboard update — $(date -Iseconds 2>/dev/null || date)"
echo "  Root: $ROOT"
echo "  Branch: $BRANCH"
echo "========================================"

echo "[1/4] git fetch + reset to origin/${BRANCH}..."
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git fetch origin "$BRANCH"
  git reset --hard "origin/${BRANCH}"
else
  echo "[WARN] Not a git repository, skipping git sync"
fi

echo "[1b/4] Reload termux-common.sh (после git sync)..."
termux_reload_common

echo "[2/4] run-local.sh --update-only (npm install + build)..."
bash "$ROOT/run-local.sh" --update-only

echo "[3/4] Stopping current process..."
termux_reload_common
kill_bot_process
dashboard_action_lock_release

echo "[4/4] Starting npm start (Termux wake-lock)..."
start_bot_background "$LOG_DIR/update-restart.log"
echo "[DONE] Update complete"
