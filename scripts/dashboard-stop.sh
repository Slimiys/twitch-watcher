#!/usr/bin/env bash
# Остановка бота с dashboard (kill + termux-wake-unlock)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=termux-common.sh
source "$(dirname "$0")/termux-common.sh"
cd "$ROOT"

LOG_DIR="${LOG_DIR:-$ROOT/logs}"
mkdir -p "$LOG_DIR"
dashboard_action_lock_acquire
trap dashboard_action_lock_release EXIT
exec >>"$LOG_DIR/dashboard-stop.log" 2>&1

echo "========================================"
echo "  Dashboard stop — $(date -Iseconds 2>/dev/null || date)"
echo "  Root: $ROOT"
echo "========================================"

sleep 1

termux_reload_common
kill_bot_process
termux_release_wake_lock
echo "[DONE] Stop complete"
