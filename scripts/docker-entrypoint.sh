#!/bin/sh
set -e

# Ожидание DNS перед стартом Node (типичная проблема Docker Desktop сразу после up)
MAX_WAIT="${TWITCH_DNS_WAIT_MAX_SECONDS:-90}"
TWITCH_HOSTS="${TWITCH_DNS_HOSTS:-id.twitch.tv gql.twitch.tv pubsub-edge.twitch.tv api.twitch.tv}"

echo "🌐  Docker entrypoint: проверка DNS (макс. ${MAX_WAIT} с на хост)..."

for host in $TWITCH_HOSTS; do
  elapsed=0
  ok=0
  while [ "$elapsed" -lt "$MAX_WAIT" ]; do
    if getent ahostsv4 "$host" >/dev/null 2>&1 || nslookup "$host" >/dev/null 2>&1; then
      echo "   ✅  DNS: $host"
      ok=1
      break
    fi
    elapsed=$((elapsed + 1))
    sleep 1
  done
  if [ "$ok" -eq 0 ]; then
    echo "   ⚠️  DNS: $host — не резолвится за ${MAX_WAIT} с (приложение попробует само)"
  fi
done

# Быстрая проверка HTTPS до id.twitch.tv (не блокируем старт при сбое)
if [ -n "$token" ] && [ "${TWITCH_SKIP_STARTUP_VALIDATE:-}" != "true" ]; then
  echo "🔎  Проверка доступа к id.twitch.tv из контейнера..."
  if wget -qO- --timeout=20 --header="Authorization: OAuth ${token}" \
    "https://id.twitch.tv/oauth2/validate" 2>/dev/null | grep -q user_id; then
    echo "   ✅  id.twitch.tv/oauth2/validate отвечает"
  else
    echo "   ⚠️  validate из контейнера не прошёл — проверьте DNS/прокси (TWITCH_USER_ID в .env поможет при старте)"
  fi
fi

exec npm start
