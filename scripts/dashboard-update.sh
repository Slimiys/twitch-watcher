#!/usr/bin/env bash
# Обновление с dashboard: git pull, run-local.sh --update-only, перезапуск npm start
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BRANCH="${DASHBOARD_UPDATE_GIT_BRANCH:-dev}"
LOG_DIR="${LOG_DIR:-$ROOT/logs}"
mkdir -p "$LOG_DIR"
exec >> "$LOG_DIR/dashboard-update.log" 2>&1

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

echo "[2/4] run-local.sh --update-only (npm install + build)..."
bash "$ROOT/run-local.sh" --update-only

echo "[3/4] Stopping current process..."
PID="${TWITCH_WATCHER_PID:-}"
if [ -z "$PID" ] && [ -n "${TWITCH_WATCHER_PID_FILE:-}" ] && [ -f "$TWITCH_WATCHER_PID_FILE" ]; then
  PID="$(cat "$TWITCH_WATCHER_PID_FILE")"
fi
if [ -z "$PID" ] && [ -f "$ROOT/.twitch-watcher.pid" ]; then
  PID="$(cat "$ROOT/.twitch-watcher.pid")"
fi
if [ -n "$PID" ]; then
  kill "$PID" 2>/dev/null || true
  sleep 2
  kill -9 "$PID" 2>/dev/null || true
fi

echo "[4/4] Starting npm start in background..."
nohup npm start >> "$LOG_DIR/update-restart.log" 2>&1 &
echo "  New PID: $!"
echo "[DONE] Update complete"
