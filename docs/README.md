# Документация Twitch Watcher

## Содержание

### Настройка и эксплуатация

- **[CONFIGURATION.md](CONFIGURATION.md)** — первый запуск, `config.json`, integrity, решение проблем
- **[ENV_VARIABLES.md](ENV_VARIABLES.md)** — поля секции `app` и корневого `token`
- **[HTTPS.md](HTTPS.md)** — HTTPS для dashboard (уведомления ОС по LAN)
- **[ANDROID_SETUP.md](ANDROID_SETUP.md)** — установка на Android через Termux
- **[DATABASE.md](DATABASE.md)** — SQLite, таблицы, API статистики

### Разработка

- **[GITFLOW.md](GITFLOW.md)** — ветки, conventional commits
- **[WEB_UI_ROADMAP.md](WEB_UI_ROADMAP.md)** — план улучшений dashboard

### Расширения

- **[edge-integrity-bridge/README.md](../extensions/edge-integrity-bridge/README.md)** — передача Client-Integrity из Edge

## Быстрый старт

1. [README.md](../README.md) в корне — установка и запуск
2. Dashboard → **«Конфиг бота»** или правка `config.json`
3. Добавьте стримеров, при необходимости настройте integrity и HTTPS

## Версия

Актуальные изменения — в [CHANGELOG.md](../CHANGELOG.md). Текущая версия указана в `package.json`.
