#!/usr/bin/env bash
# Остановка бота с dashboard (kill по PID из env или .twitch-watcher.pid)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${LOG_DIR:-$ROOT/logs}"
mkdir -p "$LOG_DIR"
exec >> "$LOG_DIR/dashboard-stop.log" 2>&1

echo "========================================"
echo "  Dashboard stop — $(date -Iseconds 2>/dev/null || date)"
echo "  Root: $ROOT"
echo "========================================"

# Даём API время ответить клиенту
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
  echo "[DONE] Process stopped"
else
  echo "[WARN] PID not found, nothing to stop"
fi
