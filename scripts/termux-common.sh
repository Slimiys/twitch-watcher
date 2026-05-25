#!/usr/bin/env bash
# Общие функции: PID бота, Termux wake-lock (работа при блокировке экрана)
# Подключается: source "$(dirname "$0")/termux-common.sh"

# shellcheck disable=SC2034
TERMUX_COMMON_LOADED=1

# Повторный source после git pull: иначе kill/stop используют старые функции из памяти shell
termux_reload_common() {
  # shellcheck disable=SC1091
  source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
}

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

# Порт дашборда из .env (WEB_SERVER_PORT) или 3001
resolve_bot_web_port() {
  local port="3001"
  if [ -f "${ROOT}/.env" ]; then
    local line val
    line="$(grep -E '^[[:space:]]*WEB_SERVER_PORT=' "${ROOT}/.env" 2>/dev/null | tail -n 1 || true)"
    if [ -n "$line" ]; then
      val="${line#*=}"
      val="$(echo "$val" | tr -d ' \r\"'"'"'')"
      if [[ "$val" =~ ^[0-9]+$ ]]; then
        port="$val"
      fi
    fi
  fi
  echo "$port"
}

# PID из env / pid-файла
resolve_bot_pid() {
  local pid="${TWITCH_WATCHER_PID:-}"
  if [ -z "$pid" ] && [ -n "${TWITCH_WATCHER_PID_FILE:-}" ] && [ -f "$TWITCH_WATCHER_PID_FILE" ]; then
    pid="$(tr -d ' \n\r' <"$TWITCH_WATCHER_PID_FILE" 2>/dev/null || true)"
  fi
  if [ -z "$pid" ] && [ -f "${ROOT}/.twitch-watcher.pid" ]; then
    pid="$(tr -d ' \n\r' <"${ROOT}/.twitch-watcher.pid" 2>/dev/null || true)"
  fi
  echo "$pid"
}

# Команданая строка процесса (Linux / Termux /proc)
_bot_proc_cmdline() {
  local pid="$1"
  if [ -r "/proc/${pid}/cmdline" ]; then
    tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null || true
  fi
}

# Похож ли процесс на twitch-watcher (node dist/app.js или ts-node app.ts в ROOT)
_is_twitch_watcher_process() {
  local pid="$1"
  local cmd
  cmd="$(_bot_proc_cmdline "$pid")"
  if [ -z "$cmd" ]; then
    return 1
  fi
  case "$cmd" in
    *"${ROOT}/dist/app.js"*|*"dist/app.js"*)
      return 0
      ;;
    *"${ROOT}/src/app.ts"*|*"src/app.ts"*)
      return 0
      ;;
  esac
  return 1
}

# Добавить PID в список (без nameref — на Termux иначе circular name reference)
# $2 = 1 — доверенный источник (pid-файл / env), иначе проверка cmdline
_bot_pids_add() {
  local pid="$1"
  local trusted="${2:-0}"

  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  case " ${_BOT_PIDS_SEEN} " in
    *" ${pid} "*) return 0 ;;
  esac
  if [ "$trusted" = "1" ] || _is_twitch_watcher_process "$pid"; then
    _BOT_PIDS_SEEN="${_BOT_PIDS_SEEN} ${pid}"
    echo "$pid"
  fi
  return 0
}

# PID слушателей TCP-порта (ss / netstat)
_list_pids_on_port() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp 2>/dev/null | grep -E ":${port}([^0-9]|$)" | grep -oE 'pid=[0-9]+' | cut -d= -f2
    return 0
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -tlnp 2>/dev/null | grep -E ":${port}([^0-9]|$)" | awk '{print $7}' | cut -d/ -f1 | grep -E '^[0-9]+$'
  fi
}

# Все PID бота в этом проекте
collect_all_bot_pids() {
  _BOT_PIDS_SEEN=""
  local pid port

  pid="$(resolve_bot_pid)"
  if [ -n "$pid" ]; then
    _bot_pids_add "$pid" 1 || true
  fi

  if [ -f "${ROOT}/.twitch-watcher.pid" ]; then
    pid="$(tr -d ' \n\r' <"${ROOT}/.twitch-watcher.pid" 2>/dev/null || true)"
    [ -n "$pid" ] && _bot_pids_add "$pid" 1 || true
  fi

  if command -v pgrep >/dev/null 2>&1; then
    while read -r pid; do
      [ -n "$pid" ] && _bot_pids_add "$pid" 0 || true
    done < <(pgrep -f "${ROOT}/dist/app.js" 2>/dev/null || true)
    while read -r pid; do
      [ -n "$pid" ] && _bot_pids_add "$pid" 0 || true
    done < <(pgrep -f "${ROOT}/src/app.ts" 2>/dev/null || true)
  fi

  port="$(resolve_bot_web_port)"
  while read -r pid; do
    [ -n "$pid" ] && _bot_pids_add "$pid" 0 || true
  done < <(_list_pids_on_port "$port" 2>/dev/null || true)
}

# SIGTERM → SIGKILL для одного PID
signal_kill_pid() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5; do
    sleep 1
    kill -0 "$pid" 2>/dev/null || return 0
  done
  kill -9 "$pid" 2>/dev/null || true
  sleep 1
  kill -0 "$pid" 2>/dev/null
}

# Занят ли порт дашборда любым процессом
bot_web_port_in_use() {
  local port
  port="$(resolve_bot_web_port)"
  local pid
  while read -r pid; do
    [ -n "$pid" ] && return 0
  done < <(_list_pids_on_port "$port" 2>/dev/null || true)
  return 1
}

# Остались ли процессы бота
bot_processes_remain() {
  if command -v pgrep >/dev/null 2>&1; then
    if pgrep -f "${ROOT}/dist/app.js" >/dev/null 2>&1; then
      return 0
    fi
    if pgrep -f "${ROOT}/src/app.ts" >/dev/null 2>&1; then
      return 0
    fi
  fi
  local port pid
  port="$(resolve_bot_web_port)"
  while read -r pid; do
    if [ -n "$pid" ] && _is_twitch_watcher_process "$pid"; then
      return 0
    fi
  done < <(_list_pids_on_port "$port" 2>/dev/null || true)
  return 1
}

# Завершение всех экземпляров бота (без снятия wake-lock)
kill_bot_process() {
  echo "[kill] Остановка twitch-watcher в ${ROOT}..."

  local pids
  pids="$(collect_all_bot_pids | sort -u -n | tr '\n' ' ')"

  if [ -z "$(echo "$pids" | tr -d ' ')" ]; then
    echo "[kill] PID не найден (файл/env/pgrep/port) — зачистка по маркеру dist/app.js"
  else
    echo "[kill] Найдены PID: $pids"
    local pid
    for pid in $pids; do
      echo "[kill] Stopping PID $pid ($(_bot_proc_cmdline "$pid" | head -c 120))..."
      if ! signal_kill_pid "$pid"; then
        echo "[WARN] PID $pid не завершился после SIGKILL"
      fi
    done
  fi

  if command -v pkill >/dev/null 2>&1; then
    pkill -f "${ROOT}/dist/app.js" 2>/dev/null || true
    sleep 1
    pkill -9 -f "${ROOT}/dist/app.js" 2>/dev/null || true
    pkill -f "${ROOT}/src/app.ts" 2>/dev/null || true
    sleep 1
    pkill -9 -f "${ROOT}/src/app.ts" 2>/dev/null || true
  fi

  rm -f "${ROOT}/.twitch-watcher.pid"
  if [ -n "${TWITCH_WATCHER_PID_FILE:-}" ]; then
    rm -f "$TWITCH_WATCHER_PID_FILE" 2>/dev/null || true
  fi

  sleep 1

  if bot_processes_remain; then
    echo "[ERROR] После остановки остались процессы бота:"
    pgrep -af "${ROOT}/dist/app.js" 2>/dev/null || true
    pgrep -af "${ROOT}/src/app.ts" 2>/dev/null || true
    return 1
  fi

  if bot_web_port_in_use; then
    echo "[ERROR] Порт $(resolve_bot_web_port) всё ещё занят (возможно другим приложением):"
    ss -tlnp 2>/dev/null | grep "$(resolve_bot_web_port)" || netstat -tlnp 2>/dev/null | grep "$(resolve_bot_web_port)" || true
    return 1
  fi

  echo "[kill] Все процессы бота остановлены, порт $(resolve_bot_web_port) свободен"
  return 0
}

# Lock действия dashboard (обновление / stop / restart) — виден новому Node после kill
dashboard_action_lock_acquire() {
  local log_dir="${LOG_DIR:-$ROOT/logs}"
  mkdir -p "$log_dir"
  echo "$$ $(date +%s 2>/dev/null || date)" >"${log_dir}/.dashboard-action.lock"
}

dashboard_action_lock_release() {
  local log_dir="${LOG_DIR:-$ROOT/logs}"
  rm -f "${log_dir}/.dashboard-action.lock"
}

# Запуск npm start в фоне + wake-lock (только если бот полностью остановлен)
start_bot_background() {
  local log_file="${1:-$LOG_DIR/update-restart.log}"

  if bot_processes_remain || bot_web_port_in_use; then
    echo "[ERROR] Нельзя запустить: процесс бота или порт $(resolve_bot_web_port) ещё заняты"
    echo "[ERROR] Сначала выполните kill_bot_process или остановите лишние npm start вручную"
    pgrep -af "${ROOT}/dist/app.js" 2>/dev/null || true
    ss -tlnp 2>/dev/null | grep "$(resolve_bot_web_port)" || true
    return 1
  fi

  termux_acquire_wake_lock
  echo "Starting npm start in background (log: $log_file)..."
  # shellcheck disable=SC2164
  cd "$ROOT"
  nohup npm start >>"$log_file" 2>&1 &
  echo "  Shell job PID (npm wrapper): $!"
  sleep 2
  if [ -f "${ROOT}/.twitch-watcher.pid" ]; then
    echo "  Bot node PID: $(cat "${ROOT}/.twitch-watcher.pid")"
  else
    echo "[WARN] .twitch-watcher.pid ещё не создан (бот может долго стартовать)"
  fi
}
