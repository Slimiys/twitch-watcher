#!/usr/bin/env bash
# Перезапуск бота с dashboard (stop + wake-lock + npm start)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=termux-common.sh
source "$(dirname "$0")/termux-common.sh"
cd "$ROOT"

LOG_DIR="${LOG_DIR:-$ROOT/logs}"
mkdir -p "$LOG_DIR"
dashboard_action_lock_acquire
trap dashboard_action_lock_release EXIT
exec >>"$LOG_DIR/update-restart.log" 2>&1

echo "========================================"
echo "  Dashboard restart — $(date -Iseconds 2>/dev/null || date)"
echo "  Root: $ROOT"
echo "========================================"

sleep 1

kill_bot_process
dashboard_action_lock_release
start_bot_background "$LOG_DIR/update-restart.log"
echo "[DONE] Restart complete"
