# Установка Twitch Watcher на Android

## Вариант 1: Termux (рекомендуется для API-режима)

Termux - это эмулятор Linux-окружения для Android, который позволяет запускать Node.js приложения.

### Требования:
- Android 7.0+ (API 24+)
- Установленное приложение [Termux](https://f-droid.org/packages/com.termux/) (рекомендуется устанавливать с F-Droid, не с Google Play)
- Интернет-соединение
- Минимум 500 МБ свободного места

### Установка:

1. **Установите Termux**:
   - Скачайте с [F-Droid](https://f-droid.org/packages/com.termux/) (рекомендуется)
   - Или с [GitHub Releases](https://github.com/termux/termux-app/releases)

2. **Откройте Termux и выполните команды**:

```bash
# Обновляем пакеты
pkg update && pkg upgrade -y

# Устанавливаем необходимые пакеты
pkg install -y nodejs git

# Проверяем версию Node.js (должна быть 18+)
node --version

# Если версия меньше 18, устанавливаем через nvm или обновляем Termux
```

3. **Клонируем репозиторий** (или копируем файлы вручную):

```bash
# Создаем рабочую директорию
mkdir -p ~/twitch_watcher
cd ~/twitch_watcher

# Если есть git, клонируем:
git clone https://github.com/your-repo/twitch_watcher.git .

# Или копируем файлы вручную через файловый менеджер Android
# в папку ~/twitch_watcher
```

4. **Устанавливаем зависимости**:

```bash
cd ~/twitch_watcher

# Устанавливаем npm пакеты
npm install

# Компилируем TypeScript
npm run build
```

5. **Создаем файл конфигурации**:

```bash
# Создаем .env файл
nano .env
```

Добавьте в файл:
```env
MODE=api
LOG_LEVEL=normal
MAX_SIMULTANEOUS_CHANNELS=2
token=your_auth_token_here

# Примечание: Список стримеров теперь настраивается в config.json
# или через веб-интерфейс после запуска приложения
```

Сохраните файл (Ctrl+O, Enter, Ctrl+X в nano)

6. **Запускаем приложение**:

```bash
npm start
```

### Автозапуск при загрузке Android:

Для автозапуска можно использовать:

1. **Termux:Boot** (плагин для Termux):
   ```bash
   pkg install termux-boot
   ```
   
   Создайте файл `~/.termux/boot/start-twitch-watcher.sh`:
   ```bash
   #!/data/data/com.termux/files/usr/bin/bash
   cd ~/twitch_watcher
   npm start
   ```

2. **Или используйте Tasker** (платное приложение) для автоматизации

### Управление через Termux:

- **Остановить**: `Ctrl+C` в Termux
- **Запустить в фоне**: Используйте `nohup` или `screen`:
  ```bash
  pkg install screen
  screen -S twitch
  npm start
  # Отключиться: Ctrl+A, затем D
  # Подключиться обратно: screen -r twitch
  ```

### Просмотр логов:

```bash
# Если запущено в screen
screen -r twitch

# Или просто запустите снова и смотрите логи
npm start
```

## Вариант 2: Удаленный сервер + Android клиент

Если запуск на Android проблематичен, можно:

1. Запустить приложение на сервере/VPS
2. Использовать Android как клиент для мониторинга через:
   - SSH клиент (JuiceSSH, Termius)
   - Веб-интерфейс (если добавить в приложение)
   - Telegram бот для уведомлений

## Вариант 3: Docker на Android (продвинутый)

Для опытных пользователей можно попробовать запустить Docker через:
- **UserLAnd** - Linux окружение с Docker
- **AnLinux** - эмулятор Linux

Но это более сложный вариант и требует root-доступа или дополнительных настроек.

## Рекомендации:

1. **Используйте API-режим** (`MODE=api`) - он не требует браузера и работает быстрее
2. **Настройте автозапуск** через Termux:Boot, чтобы приложение работало постоянно
3. **Используйте screen/tmux** для фонового запуска
4. **Мониторьте батарею** - приложение будет работать постоянно, что может разряжать батарею
5. **Используйте зарядку** или Power Bank для длительной работы

## Решение проблем:

### Проблема: Node.js версия меньше 18
```bash
# Обновите Termux
pkg update && pkg upgrade -y

# Или установите через nvm
pkg install curl
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 18
```

### Проблема: Недостаточно места
```bash
# Очистите кэш npm
npm cache clean --force

# Удалите node_modules и переустановите
rm -rf node_modules
npm install
```

### Проблема: Приложение останавливается при закрытии Termux
Используйте `screen` или `tmux` для фонового запуска (см. выше)

## Альтернатива: Веб-интерфейс

Если добавить простой веб-сервер в приложение, можно будет:
- Запускать на сервере/VPS
- Управлять через браузер на Android
- Видеть статистику и логи

Это можно реализовать как дополнительную функцию.

