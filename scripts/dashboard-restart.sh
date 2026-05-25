#!/usr/bin/env bash
# Перезапуск бота с dashboard (stop + npm start в фоне), как после обновления
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${LOG_DIR:-$ROOT/logs}"
mkdir -p "$LOG_DIR"
exec >> "$LOG_DIR/update-restart.log" 2>&1

echo "========================================"
echo "  Dashboard restart — $(date -Iseconds 2>/dev/null || date)"
echo "  Root: $ROOT"
echo "========================================"

sleep 1

PID="${TWITCH_WATCHER_PID:-}"
if [ -z "$PID" ] && [ -n "${TWITCH_WATCHER_PID_FILE:-}" ] && [ -f "$TWITCH_WATCHER_PID_FILE" ]; then
  PID="$(cat "$TWITCH_WATCHER_PID_FILE")"
fi
if [ -z "$PID" ] && [ -f "$ROOT/.twitch-watcher.pid" ]; then
  PID="$(cat "$ROOT/.twitch-watcher.pid")"
fi

if [ -n "$PID" ]; then
  echo "Stopping PID $PID..."
  kill "$PID" 2>/dev/null || true
  sleep 2
  kill -9 "$PID" 2>/dev/null || true
fi

echo "Starting npm start in background..."
nohup npm start >> "$LOG_DIR/update-restart.log" 2>&1 &
echo "  New PID: $!"
echo "[DONE] Restart complete"
