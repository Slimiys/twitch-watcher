# Параметры конфигурации

Настройки бота хранятся в **`config.json`** (секция `app` и корневой `token`) и редактируются в dashboard → **«Конфиг бота»**. При старте значения загружаются в `process.env`.

Файл **`.env` не используется** основным приложением. Исключение: скрипт `npm run certs:generate` может читать `.env` для удобства локальной генерации сертификатов.

Шаблон: `config.json.example`.

## Обязательные

| Ключ | Где | Описание |
|------|-----|----------|
| `token` | корень `config.json` | Cookie `auth-token` с twitch.tv |

Список стримеров — в `config.json` → `streamers` или через dashboard (не через переменные окружения).

## Авторизация и Twitch

| Ключ | Описание |
|------|----------|
| `TWITCH_USER_ID` | User ID из `id.twitch.tv` / validate |
| `TWITCH_INTEGRITY_SOURCE` | `auto` / `manual` / `api` |
| `TWITCH_CLIENT_INTEGRITY` | Заголовок Client-Integrity |
| `TWITCH_CLIENT_INTEGRITY_EXPIRES` | Unix timestamp истечения integrity |
| `TWITCH_INTEGRITY_AUTO_REFRESH` | Автообновление integrity (по умолчанию вкл.) |
| `TWITCH_INTEGRITY_AUTO_PERSIST` | Записывать обновлённый integrity в config.json |
| `TWITCH_INTEGRITY_FALLBACK_API` | Устаревший fallback POST /integrity |
| `TWITCH_DEVICE_ID` | Заголовок X-Device-Id (часто = cookie unique_id) |
| `TWITCH_COOKIES` | Доп. cookies: `unique_id=…; api_token=…` |
| `TWITCH_CLIENT_VERSION` | Client-Version из gql |
| `TWITCH_CLIENT_SESSION_ID` | Client-Session-Id из gql |
| `INTEGRITY_BRIDGE_ENABLED` | Приём integrity от расширения Edge (по умолчанию вкл.; `false` — выкл.) |

Расширение: `extensions/edge-integrity-bridge`. Endpoint: `POST /api/integrity/capture`.

## Логирование

| Ключ | По умолчанию | Описание |
|------|--------------|----------|
| `LOG_LEVEL` | `normal` | `verbose` / `normal` / `minimal` |
| `LOG_TO_FILE` | вкл. | Писать в `./logs` |
| `LOG_DIR` | `./logs` | Каталог логов |
| `LOG_FILE_MAX_MB` | `100` | Лимит одного файла |
| `LOG_FILE_BASENAME` | `twitch-watcher` | Имя файлов `*.1.log` / `*.2.log` |
| `LOG_CLEAR_ON_START` | вкл. | Очистить каталог логов при старте |

## Просмотр и claim

| Ключ | Описание |
|------|----------|
| `MAX_SIMULTANEOUS_CHANNELS` | Макс. одновременных каналов (1–10, по умолчанию 2) |
| `WATCH_PREP_INTERVAL_MS` | Обновление стримера перед watch |
| `WATCH_OPERATION_TIMEOUT_MS` | Таймаут watch/spade |
| `CLAIM_CHECK_INTERVAL_MS` | Интервал опроса claim |
| `CLAIM_FAILED_BLOCK_MS` | Blocklist при FORBIDDEN |
| `WATCH_RESUME_MAX_AGE_MS` | Макс. возраст resume-состояния |

Интервал ротации minute-watched — в `config.json` → `watch.cycleIntervalMs` (не в `app`).

## Сеть

| Ключ | Описание |
|------|----------|
| `FETCH_TIMEOUT_MS` | Таймаут HTTP (перезапуск при смене) |
| `proxy` | Прокси host:port или URL |
| `proxyAuth` | `login:password` |
| `userAgent` | User-Agent для HTTP |

## Сервер и dashboard

| Ключ | По умолчанию | Описание |
|------|--------------|----------|
| `HEALTH_CHECK_PORT` | `3000` | HTTP health-check |
| `WEB_SERVER_PORT` | `3001` | Порт dashboard |
| `WEB_SERVER_HTTPS` | выкл. | HTTPS для dashboard |
| `WEB_DASHBOARD_API_KEY` | — | Защита API (`X-API-Key`) |
| `SSL_DIR` | `./certs` | Каталог сертификатов |
| `SSL_CERT_PATH` / `SSL_KEY_PATH` | — | Пути к crt/key |
| `SSL_EXTRA_SANS` | — | Доп. SAN (IP через запятую) |
| `SSL_CERT_CN` | `twitch-watcher` | Common Name |
| `DASHBOARD_UPDATE_ENABLED` | выкл. | Обновление из Git с dashboard (Termux) |
| `DASHBOARD_UPDATE_GIT_BRANCH` | `dev` | Ветка для update |
| `DASHBOARD_UPDATE_GIT_REMOTE` | `origin` | Git remote |

Подробнее про HTTPS: [HTTPS.md](HTTPS.md).

## WebSocket и поведение

| Ключ | Описание |
|------|----------|
| `WS_HEALTH_CHECK_INTERVAL_MS` | Проверка WebSocket |
| `WS_CONNECT_TIMEOUT_MS` | Таймаут подключения WS |
| `AUTO_EXIT_ON_UNHEALTHY` | Выход при unhealthy (`true` / `false` / пусто) |
| `AUTO_EXIT_ON_INVALID_TOKEN` | Выход при невалидном токене |
| `TWITCH_TERMUX_WAKE_LOCK` | Wake-lock в скриптах Termux (`false` — отключить) |

## Устаревшие параметры

Эти ключи **больше не используются** (browser-режим удалён в 0.6+):

- `streamersUrl`, `scrollDelay`, `scrollTimes`
- `watchAlwaysTopStreamer`, `streamerListRefresh`, `streamerListRefreshUnit`
- `channelsWithPriority` (заменён на `config.json` → `streamers`)
- `showBrowser`, `MODE` (только API-режим)

## Пример минимального config.json

```json
{
  "token": "your_auth_token_here",
  "app": {
    "LOG_LEVEL": "normal",
    "MAX_SIMULTANEOUS_CHANNELS": "2"
  },
  "streamers": ["alkaizerx", "mathil1"]
}
```

Перезапуск бота нужен для части полей (порты, прокси, токен, integrity при ручной смене). UI «Конфиг бота» подскажет, если требуется перезапуск.
