# Настройка Twitch Watcher

Приложение работает в **API-режиме** (без браузера). Все параметры бота задаются через **dashboard → «Конфиг бота»** и сохраняются в `config.json` (шаблон: `config.json.example`). Файл `.env` **не используется** при обычном запуске.

## Первый запуск

1. `npm install && npm run build && npm start`
2. Откройте dashboard: http://localhost:3001 (порт — `WEB_SERVER_PORT` в конфиге)
3. **«Конфиг бота»** → укажите **auth-token** (cookie `auth-token` на twitch.tv)
4. Добавьте стримеров в таблице или в `config.json` → `streamers`

После сохранения токена бот запускает просмотр автоматически.

## Структура config.json

```json
{
  "token": "…",
  "app": {
    "LOG_LEVEL": "normal",
    "WEB_SERVER_PORT": "3001",
    "MAX_SIMULTANEOUS_CHANNELS": "2"
  },
  "streamers": ["streamer1", "streamer2"],
  "watch": { "cycleIntervalMs": 60000 },
  "favoriteCategories": [
    { "id": "509658", "name": "Just Chatting", "boxArtUrl": "…" }
  ]
}
```

- **`token`** — обязательный auth-token Twitch
- **`app`** — настройки бота (логи, порты, integrity, прокси и т.д.). Полный список полей — в [ENV_VARIABLES.md](ENV_VARIABLES.md) и в UI «Конфиг бота»
- **`streamers`** — список каналов для отслеживания (можно менять в dashboard)
- **`watch.cycleIntervalMs`** — пауза ротации minute-watched между онлайн-каналами
- **`favoriteCategories`** — избранные категории для фильтра таблицы и подсветки в статистике

`config.json` содержит секреты и в `.gitignore` — не коммитьте его.

## Client-Integrity и сбор бонусов

Для сбора канальных бонусов Twitch требует заголовок `Client-Integrity`.

**Варианты:**

1. **Расширение Edge** (`extensions/edge-integrity-bridge`) — автоматическая передача integrity с открытой вкладки twitch.tv. См. [README расширения](../extensions/edge-integrity-bridge/README.md).
2. **Ручной ввод** — скопировать из DevTools → Network → запрос `gql` → Request Headers (`Client-Integrity`, `X-Device-Id`, cookies).
3. **Автообновление** — `TWITCH_INTEGRITY_AUTO_REFRESH=true` (по умолчанию): бот запрашивает `POST /integrity` до источения срока.

В dashboard: секция **Client-Integrity** и **Bot Health** показывают статус токена и сбор бонусов.

На Termux чаще всего нужен **manual** integrity или расширение на ПК с bridge к боту на телефоне.

## Решение проблем

### Бот не смотрит стримеров

1. Убедитесь, что стримеры добавлены в `config.json` или через dashboard
2. Проверьте, что канал **онлайн** (в таблице статус Online)
3. Проверьте токен: **«Конфиг бота»** → auth-token актуален
4. Смотрите логи: `./logs/twitch-watcher.1.log`

### «No streamers found» / пустая таблица

- Список стримеров пуст — добавьте каналы в dashboard
- После обновления с Git иногда нужна перезагрузка страницы (F5) или дождитесь SSE-обновления

### Ошибки токена / 401

- Обновите `auth-token` в браузере (выйдите и войдите на twitch.tv, скопируйте новый cookie)
- Сохраните в «Конфиг бота» и перезапустите бот при запросе UI

### `failed integrity check` / бонусы не собираются

1. Обновите `Client-Integrity` (вручную или через расширение)
2. Проверьте `TWITCH_DEVICE_ID` / cookie `unique_id`
3. На Termux: `TWITCH_INTEGRITY_SOURCE=manual` и свежий токен с ПК
4. В логе должно быть `Бонус успешно собран!` при успехе

### Сетевые ошибки (DNS, таймауты)

- Проверьте интернет и DNS
- При прокси: `proxy` и `proxyAuth` в «Конфиг бота»
- Увеличьте `FETCH_TIMEOUT_MS` при медленной сети

### Dashboard недоступен с другого устройства

- Откройте `http://<IP>:WEB_SERVER_PORT` в той же сети
- Для уведомлений ОС по IP нужен HTTPS — см. [HTTPS.md](HTTPS.md)
- На Android при блокировке экрана Termux может останавливаться — см. [ANDROID_SETUP.md](ANDROID_SETUP.md)

## Полезные ссылки

- [Переменные и поля config.json](ENV_VARIABLES.md)
- [База данных и статистика](DATABASE.md)
- [HTTPS для dashboard](HTTPS.md)
- [Android / Termux](ANDROID_SETUP.md)
- [План веб-интерфейса](WEB_UI_ROADMAP.md)
