#!/usr/bin/env bash
# Общие функции: PID бота, Termux wake-lock (работа при блокировке экрана)
# Подключается: source "$(dirname "$0")/termux-common.sh"

# shellcheck disable=SC2034
TERMUX_COMMON_LOADED=1

termux_wake_lock_enabled() {
  [ "${TWITCH_TERMUX_WAKE_LOCK:-true}" != "false" ]
}

# Удержание CPU при выключенном экране (Termux)
termux_acquire_wake_lock() {
  if ! termux_wake_lock_enabled; then
    echo "[INFO] Termux wake-lock отключён (TWITCH_TERMUX_WAKE_LOCK=false)"
    return 0
  fi
  if command -v termux-wake-lock >/dev/null 2>&1; then
    if termux-wake-lock; then
      echo "[OK] termux-wake-lock — бот может работать при заблокированном экране"
    else
      echo "[WARN] termux-wake-lock не удался"
    fi
  else
    echo "[INFO] termux-wake-lock не найден. Termux: pkg install termux-tools"
  fi
}

termux_release_wake_lock() {
  if ! termux_wake_lock_enabled; then
    return 0
  fi
  if command -v termux-wake-unlock >/dev/null 2>&1; then
    if termux-wake-unlock; then
      echo "[OK] termux-wake-unlock"
    else
      echo "[WARN] termux-wake-unlock не удался"
    fi
  fi
}

# PID текущего процесса бота
resolve_bot_pid() {
  local pid="${TWITCH_WATCHER_PID:-}"
  if [ -z "$pid" ] && [ -n "${TWITCH_WATCHER_PID_FILE:-}" ] && [ -f "$TWITCH_WATCHER_PID_FILE" ]; then
    pid="$(cat "$TWITCH_WATCHER_PID_FILE")"
  fi
  if [ -z "$pid" ] && [ -f "${ROOT}/.twitch-watcher.pid" ]; then
    pid="$(cat "${ROOT}/.twitch-watcher.pid")"
  fi
  echo "$pid"
}

# Только завершение процесса (без снятия wake-lock)
kill_bot_process() {
  local pid
  pid="$(resolve_bot_pid)"
  if [ -z "$pid" ]; then
    echo "[WARN] PID не найден, нечего останавливать"
    return 0
  fi
  echo "Stopping PID $pid..."
  kill "$pid" 2>/dev/null || true
  sleep 2
  kill -9 "$pid" 2>/dev/null || true
}

# Запуск npm start в фоне + wake-lock
start_bot_background() {
  local log_file="${1:-$LOG_DIR/update-restart.log}"
  termux_acquire_wake_lock
  echo "Starting npm start in background (log: $log_file)..."
  # shellcheck disable=SC2164
  cd "$ROOT"
  nohup npm start >>"$log_file" 2>&1 &
  echo "  New PID: $!"
}
