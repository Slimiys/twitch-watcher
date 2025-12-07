# Twitch Watcher (TypeScript)

Автоматический просмотр стримов Twitch для получения канальных баллов и дропов в играх.

[![GitHub](https://img.shields.io/badge/GitHub-Repository-blue?logo=github)](https://github.com/Slimiys/twitch-watcher)

## Особенности

- 🚀 **Два режима работы**: API-режим (без браузера) и Puppeteer-режим (автоматизация браузера)
- 🎯 Просмотр только приоритетных стримеров из списка
- 💰 Автоматический сбор бонусных сундуков канальных баллов
- 📊 Статистика просмотра и заработанных баллов
- 🔐 Авторизация через токен (auth-token)
- 🛡 Поддержка прокси
- 📦 Готов к развертыванию через Docker
- 🧰 Полностью типизированный код на TypeScript

## Режимы работы

### API-режим (рекомендуется)
- ✅ Не требует браузера - работает полностью headless
- ✅ Низкое потребление ресурсов
- ✅ Мгновенная реакция на события через WebSocket
- ✅ Высокая надежность
- ❌ Не поддерживает скриншоты

### Puppeteer-режим
- ✅ Поддержка скриншотов
- ✅ Визуальная проверка статуса стримера
- ❌ Требует браузера (высокое потребление ресурсов)
- ❌ Зависит от структуры DOM

## Требования

- **Windows или Linux** (основная поддержка)
- **Android** (через Termux, см. [ANDROID_SETUP.md](docs/ANDROID_SETUP.md))
- Node.js 18+ и NPM
- Chromium/Chrome браузер (только для Puppeteer-режима, не требуется для API-режима)

## Установка

1. Клонируйте репозиторий:
   ```bash
   git clone https://github.com/Slimiys/twitch-watcher.git
   cd twitch-watcher
   ```
2. Установите зависимости: `npm install`
3. Скомпилируйте проект: `npm run build`
4. Запустите: `npm start`

## Настройка

### Первый запуск

При первом запуске программа запросит:
- **auth-token** - токен авторизации Twitch (можно получить из cookies браузера)
- **Путь к Chromium** - путь к исполняемому файлу браузера

Данные сохраняются в `config.json`.

### Переменные окружения

Создайте файл `.env` для настройки:

```env
# Режим работы: api или puppeteer (по умолчанию puppeteer)
MODE=api

# Обязательные параметры
token=your_auth_token_here
channelsWithPriority=alkaizerx,mathil1

# Параметры для Puppeteer-режима (не используются в API-режиме)
# minWatching=15
# maxWatching=30
# browserScreenshot=false
# screenshotInterval=0
```

Подробнее о настройке см. [CONFIGURATION.md](docs/CONFIGURATION.md)

## Использование

### Разработка

```bash
npm run dev
```

### Сборка и запуск

```bash
npm run build
npm start
```

## Docker

Подробная инструкция по использованию Docker доступна в [DOCKER.md](docs/DOCKER.md)

### Быстрый старт

1. Скопируйте `docker-compose-example.yml` в `docker-compose.yml`
2. Отредактируйте `docker-compose.yml` и укажите:
   - Ваш токен Twitch (`token`)
   - Список приоритетных стримеров (`channelsWithPriority`)
3. Запустите: `docker-compose up -d`
4. Просмотр логов: `docker-compose logs -f`

## Решение проблем

### Стримеры не находятся

1. Увеличьте `scrollDelay` и `scrollTimes` в `.env`
2. Проверьте URL в `streamersUrl`
3. Включите видимый режим браузера в `src/app.ts`: `const showBrowser = true`

Подробнее см. [CONFIGURATION.md](CONFIGURATION.md)

## План развития

Планы по улучшению и развитию проекта доступны в [ROADMAP.md](docs/ROADMAP.md)

## Git Workflow

Проект использует Git Flow workflow с conventional commits. Подробная документация доступна в [GITFLOW.md](docs/GITFLOW.md)

## Лицензия

MIT

## Ссылки

- [GitHub Repository](https://github.com/Slimiys/twitch-watcher)
- [Документация по настройке](docs/CONFIGURATION.md)
- [Переменные окружения](docs/ENV_VARIABLES.md)
- [Docker инструкции](docs/DOCKER.md)
- [Android настройка](docs/ANDROID_SETUP.md)
- [Git Flow Workflow](docs/GITFLOW.md)
- [План развития](docs/ROADMAP.md)
