# Git Flow Workflow

Данный проект использует Git Flow workflow для управления версиями и разработкой.

## Структура веток

### Основные ветки

- **`main`** - основная ветка, содержит только production-ready код
  - Защищена от прямых коммитов
  - Обновляется только через merge из `dev` или `hotfix/*`
  - Каждый merge в `main` должен сопровождаться тегом версии

- **`dev`** - ветка разработки, содержит актуальный код разработки
  - Основная ветка для разработки новых функций
  - Все feature и bugfix ветки создаются от `dev`
  - Периодически мержится в `main` при релизах

### Вспомогательные ветки

#### Feature ветки (`feature/*`)
- **Создание:** от `dev`
- **Назначение:** разработка новых функций
- **Название:** `feature/краткое-описание`
- **Примеры:**
  - `feature/telegram-notifications`
  - `feature/statistics-storage`
  - `feature/web-dashboard`

#### Bugfix ветки (`bugfix/*`)
- **Создание:** от `dev`
- **Назначение:** исправление багов в коде разработки
- **Название:** `bugfix/краткое-описание`
- **Примеры:**
  - `bugfix/websocket-reconnection`
  - `bugfix/token-validation`
  - `bugfix/statistics-calculation`

#### Hotfix ветки (`hotfix/*`)
- **Создание:** от `main`
- **Назначение:** срочные исправления в production
- **Название:** `hotfix/краткое-описание` или `hotfix/версия`
- **Примеры:**
  - `hotfix/critical-memory-leak`
  - `hotfix/v2.0.6`
- **Важно:** После завершения мержится обратно в `main` И в `dev`

#### Release ветки (`release/*`) - опционально
- **Создание:** от `dev` при подготовке релиза
- **Назначение:** финальная подготовка к релизу
- **Название:** `release/версия`
- **Примеры:**
  - `release/v2.1.0`

## Conventional Commits

Все коммиты должны следовать формату [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Типы коммитов

- **`feat`** - новая функция
- **`fix`** - исправление бага
- **`refactor`** - рефакторинг кода
- **`test`** - добавление или изменение тестов
- **`docs`** - изменения в документации
- **`chore`** - обновление зависимостей, настройка инструментов
- **`style`** - форматирование кода (не влияет на функциональность)
- **`perf`** - улучшение производительности
- **`ci`** - изменения в CI/CD конфигурации

### Scope (опционально)

Область изменений:
- `api` - изменения в API режиме
- `puppeteer` - изменения в Puppeteer режиме
- `config` - изменения конфигурации
- `logger` - изменения логирования
- и т.д.

### Примеры коммитов

```bash
# Новая функция
feat(api): add telegram notifications support

# Исправление бага
fix(websocket): handle reconnection errors properly

# Рефакторинг
refactor: extract statistics storage to separate module

# Документация
docs: update README with installation instructions

# Тесты
test(api): add unit tests for StreamWatcher

# Конфигурация
chore: update dependencies to latest versions

# Исправление в production (hotfix)
fix(hotfix): critical memory leak in WebSocket manager
```

### Правила написания

1. **Subject** (первая строка):
   - Максимум 50 символов
   - Начинается с маленькой буквы
   - Без точки в конце
   - В повелительном наклонении ("add" вместо "added" или "adds")

2. **Body** (опционально):
   - Отделяется пустой строкой от subject
   - Объясняет "что" и "почему", а не "как"
   - Может быть многострочным

3. **Footer** (опционально):
   - Для breaking changes: `BREAKING CHANGE: описание`
   - Для закрытия issues: `Closes #123`

## Workflow примеры

### Разработка новой функции

```bash
# 1. Переключиться на dev и обновить
git checkout dev
git pull origin dev

# 2. Создать feature ветку
git checkout -b feature/telegram-notifications

# 3. Разработка и коммиты
git add .
git commit -m "feat(notifications): add telegram bot integration"
git commit -m "test(notifications): add unit tests for telegram module"
git commit -m "docs: update README with telegram setup"

# 4. Запушить ветку
git push -u origin feature/telegram-notifications

# 5. Создать Pull Request в dev (через GitHub)

# 6. После мержа удалить локальную ветку
git checkout dev
git pull origin dev
git branch -d feature/telegram-notifications
```

### Исправление бага

```bash
# 1. Переключиться на dev
git checkout dev
git pull origin dev

# 2. Создать bugfix ветку
git checkout -b bugfix/websocket-reconnection

# 3. Исправление и коммиты
git commit -m "fix(websocket): handle connection timeout errors"
git commit -m "test(websocket): add reconnection test cases"

# 4. Запушить и создать PR в dev
git push -u origin bugfix/websocket-reconnection
```

### Срочное исправление (Hotfix)

```bash
# 1. Переключиться на main
git checkout main
git pull origin main

# 2. Создать hotfix ветку
git checkout -b hotfix/critical-memory-leak

# 3. Исправление
git commit -m "fix(hotfix): resolve memory leak in WebSocket manager"

# 4. Запушить
git push -u origin hotfix/critical-memory-leak

# 5. После мержа в main:
git checkout main
git pull origin main
git tag -a v2.0.6 -m "Release v2.0.6"
git push origin v2.0.6

# 6. Мерж обратно в dev
git checkout dev
git pull origin dev
git merge main
git push origin dev

# 7. Удалить hotfix ветку
git branch -d hotfix/critical-memory-leak
git push origin --delete hotfix/critical-memory-leak
```

### Релиз новой версии

```bash
# 1. Убедиться, что dev готова к релизу
git checkout dev
git pull origin dev

# 2. Мерж dev в main
git checkout main
git pull origin main
git merge dev

# 3. Создать тег версии
git tag -a v2.1.0 -m "Release v2.1.0: Add statistics storage and notifications"
git push origin v2.1.0
git push origin main

# 4. Вернуться на dev
git checkout dev
```

## Pull Request процесс

1. **Создание PR:**
   - Feature/Bugfix → `dev`
   - Hotfix → `main`
   - Указать тип: `[Feature]`, `[Bugfix]`, `[Hotfix]`
   - Описать изменения

2. **Review:**
   - Минимум 1 approval для мержа
   - Все проверки CI должны пройти
   - Конфликты должны быть разрешены

3. **Мерж:**
   - Использовать "Squash and merge" для feature/bugfix
   - Использовать "Merge commit" для hotfix (сохраняет историю)

## Теги версий

Версии следуют [Semantic Versioning](https://semver.org/):
- **MAJOR** - несовместимые изменения API
- **MINOR** - новая функциональность (обратно совместимая)
- **PATCH** - исправления багов

Формат: `vMAJOR.MINOR.PATCH`

Примеры:
- `v2.0.5` → `v2.0.6` (patch)
- `v2.0.6` → `v2.1.0` (minor)
- `v2.1.0` → `v3.0.0` (major)

## Полезные команды

```bash
# Просмотр всех веток
git branch -a

# Удаление локальной ветки
git branch -d branch-name

# Удаление удаленной ветки
git push origin --delete branch-name

# Просмотр коммитов в формате conventional commits
git log --oneline --decorate

# Просмотр изменений между ветками
git diff dev..main

# Обновление всех веток
git fetch --all --prune
```

## Чеклист перед мержем в main

- [ ] Все тесты проходят
- [ ] Код прошел review
- [ ] Документация обновлена
- [ ] Версия обновлена в package.json
- [ ] CHANGELOG обновлен (если используется)
- [ ] Тег версии создан

## Исключения

В некоторых случаях можно коммитить напрямую в `dev`:
- Исправление опечаток в документации
- Обновление .gitignore
- Мелкие форматирования кода

Но предпочтительно использовать ветки даже для мелких изменений.

