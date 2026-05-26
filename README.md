# Twitch Watcher (TypeScript)

Автоматический просмотр стримов Twitch для получения канальных баллов и дропов в играх.

[![GitHub](https://img.shields.io/badge/GitHub-Repository-blue?logo=github)](https://github.com/Slimiys/twitch-watcher)

## Особенности

- **API-режим**: Работает без браузера, полностью headless
- Просмотр только приоритетных стримеров из списка
- Автоматический сбор бонусных сундуков канальных баллов
- Статистика просмотра и заработанных баллов
- Авторизация через токен (auth-token)
- Поддержка прокси
- Готов к развертыванию через Docker
- Полностью типизированный код на TypeScript
- Низкое потребление ресурсов
- Мгновенная реакция на события через WebSocket
- Высокая надежность

## Требования

- **Windows или Linux** (основная поддержка)
- **Android** (через Termux, см. [ANDROID_SETUP.md](docs/ANDROID_SETUP.md))
- Node.js 18+ и NPM

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

Данные сохраняются в `config.json` (шаблон: `config.json.example`).

### Настройки

Параметры бота (токен, integrity, порты, логи и т.д.) задаются в **dashboard → «Конфиг бота»** и сохраняются в `config.json` (`token` и секция `app`). Файл `.env` не используется.

**Примечание:** Список стримеров настраивается через веб-интерфейс (http://localhost:3001) или вручную в файле `config.json`:
```json
{
  "streamers": ["alkaizerx", "mathil1"]
}
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

1. Скопируйте `config.json.example` в `config.json` и укажите `token` (или задайте его в dashboard после старта).
2. После запуска откройте dashboard → **«Конфиг бота»** для остальных параметров.
3. Добавьте стримеров через веб-интерфейс или в `config.json`.
4. Запустите: `docker-compose up -d`
5. Просмотр логов: `docker-compose logs -f`

**Важно:** `config.json` содержит секретные данные и не должен попадать в репозиторий (добавьте в `.gitignore`, если ещё нет).

## Решение проблем

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
