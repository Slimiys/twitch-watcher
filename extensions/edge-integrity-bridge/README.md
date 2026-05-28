# Twitch Watcher — Integrity Bridge (Edge)

Расширение перехватывает заголовок `Client-Integrity` из запросов к `https://gql.twitch.tv` и отправляет его в локальный бот Twitch Watcher.

## Установка в Edge

1. Соберите и запустите бот (`npm run build`, затем запуск с dashboard на порту 3001 по умолчанию).
2. Откройте `edge://extensions/`.
3. Включите **Режим разработчика**.
4. **Загрузить распакованное** → выберите папку `extensions/edge-integrity-bridge`.
5. Откройте popup расширения, укажите URL бота (`http://127.0.0.1:3001`) и при необходимости `WEB_DASHBOARD_API_KEY` из `config.json`.

## Как это работает

1. Откройте [twitch.tv](https://www.twitch.tv) в Edge (тот же профиль, где установлено расширение).
2. Перейдите на любой канал или обновите страницу — пойдут gql-запросы.
3. Расширение отправит `Client-Integrity` (и `X-Device-Id`, если есть) в `POST /api/integrity/capture`.
4. Бот сохранит токен в `config.json` (если включено **Сохранять integrity**) и применит без перезапуска.

## Настройки бота

| Переменная | Описание |
|------------|----------|
| `INTEGRITY_BRIDGE_ENABLED` | `false` — отключить приём от расширения |
| `WEB_DASHBOARD_API_KEY` | Если задан, укажите тот же ключ в popup |
| `TWITCH_INTEGRITY_AUTO_PERSIST` | Сохранение в config (по умолчанию вкл.) |

## Иконка

При необходимости добавьте `icon128.png` (128×128) в эту папку — иначе Edge покажет стандартную иконку.
