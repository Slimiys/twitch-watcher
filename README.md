# Twitch Watcher (TypeScript)

Автоматический просмотр стримов Twitch для получения канальных баллов и дропов в играх.

[![GitHub](https://img.shields.io/badge/GitHub-Repository-blue?logo=github)](https://github.com/Slimiys/twitch-watcher)

## Особенности

- **API-режим**: работает без браузера, полностью headless
- **Веб-dashboard** с управлением стримерами, настройками и статистикой
- Локализация дашборда **RU/EN**
- Автоматический сбор бонусных сундуков (Client-Integrity, расширение Edge)
- Статистика баллов, стримов, категорий; избранные категории Twitch
- **Bot Health**, SSE-обновления, уведомления (toast / ОС / звук)
- Обновление и перезапуск бота с dashboard (Termux)
- Авторизация через auth-token; настройки в `config.json`
- WebSocket для событий Twitch; низкое потребление ресурсов

## Требования

- **Windows или Linux** (основная поддержка)
- **Android** через Termux — [ANDROID_SETUP.md](docs/ANDROID_SETUP.md)
- Node.js 18+ и npm

## Установка

```bash
git clone https://github.com/Slimiys/twitch-watcher.git
cd twitch-watcher
npm install
npm run build
npm start
```

## Настройка

1. Откройте dashboard: http://localhost:3001
2. **«Конфиг бота»** → укажите **auth-token** (cookie на twitch.tv)
3. Добавьте стримеров в таблице или в `config.json`

Шаблон конфигурации: `config.json.example`. Секреты хранятся в `config.json` (в `.gitignore`), не в `.env`.

```json
{
  "streamers": ["alkaizerx", "mathil1"]
}
```

Подробнее: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

### Integrity Bridge (опционально)

Расширение Microsoft Edge передаёт `Client-Integrity` с twitch.tv в бот: `extensions/edge-integrity-bridge/`.

## Использование

```bash
npm run dev      # разработка (ts-node)
npm run build    # сборка
npm start        # запуск
```

Health-check: http://localhost:3000 (порт `HEALTH_CHECK_PORT`).

## Решение проблем

См. [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — токен, integrity, сеть, dashboard.

## Документация

| Документ | Описание |
|----------|----------|
| [docs/README.md](docs/README.md) | Индекс документации |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Настройка и troubleshooting |
| [docs/ENV_VARIABLES.md](docs/ENV_VARIABLES.md) | Поля `config.json` / «Конфиг бота» |
| [docs/DATABASE.md](docs/DATABASE.md) | SQLite-статистика |
| [docs/HTTPS.md](docs/HTTPS.md) | HTTPS для dashboard |
| [docs/ANDROID_SETUP.md](docs/ANDROID_SETUP.md) | Termux |
| [docs/WEB_UI_ROADMAP.md](docs/WEB_UI_ROADMAP.md) | План развития UI |
| [docs/GITFLOW.md](docs/GITFLOW.md) | Git Flow и коммиты |
| [CHANGELOG.md](CHANGELOG.md) | История версий |

## Лицензия

MIT

## Ссылки

- [GitHub Repository](https://github.com/Slimiys/twitch-watcher)
- [Релизы](https://github.com/Slimiys/twitch-watcher/releases)
