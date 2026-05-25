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
git clone -b dev https://github.com/Slimiys/twitch-watcher.git .

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
LOG_LEVEL=normal
MAX_SIMULTANEOUS_CHANNELS=2
token=your_auth_token_here

# Сбор бонусов на Termux — manual integrity из браузера (POST /integrity с телефона обычно не проходит)
TWITCH_INTEGRITY_SOURCE=manual
TWITCH_CLIENT_INTEGRITY=вставьте_из_DevTools
TWITCH_CLIENT_INTEGRITY_EXPIRES=1735689600
TWITCH_DEVICE_ID=uuid-из-cookie-unique_id
# TWITCH_COOKIES=unique_id=...; api_token=...

# Примечание: Список стримеров настраивается в config.json
# или через веб-интерфейс после запуска приложения
```

**Как получить `TWITCH_CLIENT_INTEGRITY`:** на ПК откройте twitch.tv → F12 → Network → любой запрос `gql` → Request Headers → скопируйте `Client-Integrity` и (по возможности) `X-Device-Id` / cookie `unique_id`. Токен живёт несколько часов — при `failed integrity check` обновите и перезапустите бота.

При старте в логе должно быть: `Integrity: manual`. Успешный сбор: `Бонус успешно собран!` и `Reason: CLAIM` в событиях баллов.

**Обновление с телефона (карточка «Версия» в «Статус бота»):** в `.env` добавьте:

```env
DASHBOARD_UPDATE_ENABLED=true
```

Раз в минуту дашборд сравнивает ваш коммит с `origin/dev` (нужен интернет и `git`). Если есть новая ревизия — на карточке **Версия** появится индикатор **NEW** и подпись «Доступно: …». **Нажмите на карточку** → подтвердите → выполнится `git fetch`, `reset` на `origin/dev`, сборка и перезапуск. Лог: `logs/dashboard-update.log`.

В шапке дашборда (при `DASHBOARD_UPDATE_ENABLED=true`): **Остановить** — завершить процесс; **Перезапустить** — stop + `npm start` (лог `logs/update-restart.log`).

Опционально: `WEB_DASHBOARD_API_KEY` — защита REST API; `DASHBOARD_UPDATE_GIT_BRANCH=dev` (по умолчанию dev).

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

### Проблема: Дашборд недоступен при блокировке экрана (сон телефона)

Когда экран гаснет, Android переводит приложения в **Doze** и может **заморозить или завершить** процесс Termux (вместе с Node.js и HTTPS на порту 3001). Браузер тогда не открывает `https://<IP>:3001` — «нет соединения», таймаут или «сайт недоступен». Бот и дашборд работают в **одном процессе** `npm start`; если OS его остановила — падает всё.

**Проверка после разблокировки** (в Termux):

```bash
# Жив ли процесс на порту 3001?
ss -tlnp | grep 3001
# или
cat ~/twitch_watcher/.twitch-watcher.pid
ps -p "$(cat ~/twitch_watcher/.twitch-watcher.pid)"
```

Если процесса нет — смотрите `logs/crash.log` и последние строки `logs/twitch-watcher.1.log`.

**Что сделать (по приоритету):**

1. **Отключить оптимизацию батареи для Termux**  
   Настройки → Приложения → Termux → Батарея → **Без ограничений** / «Не оптимизировать» (названия зависят от прошивки). То же для **Termux:API**, если используете wake-lock.

2. **Не отключать Wi‑Fi в сне**  
   Настройки → Wi‑Fi → Дополнительно → **Не отключать Wi‑Fi в режиме сна** → «Всегда» (или «Только при подключении к сети»).

3. **Wake-lock в Termux** (удерживает CPU активнее при выключенном экране):

   Скрипты **Обновить** (карточка «Версия»), **Перезапустить** и **Остановить** в дашборде вызывают `termux-wake-lock` / `termux-wake-unlock` автоматически (нужен пакет `termux-tools`).

   ```bash
   pkg install termux-tools
   ```

   Ручной запуск:

   ```bash
   termux-wake-lock
   cd ~/twitch_watcher
   npm start
   # после остановки: termux-wake-unlock
   ```

   Отключить wake-lock в скриптах: `TWITCH_TERMUX_WAKE_LOCK=false` в `.env`.

   Либо запуск в `tmux`/`screen` **после** `termux-wake-lock`:

   ```bash
   termux-wake-lock
   screen -S twitch
   cd ~/twitch_watcher && npm start
   # Ctrl+A, D — отсоединиться; экран можно блокировать
   ```

4. **Агрессивные «энергосберегатели»** (Samsung, Xiaomi, Huawei и др.) — в настройках батареи разрешите Termux **работу в фоне** / автозапуск.

5. **Дашборд с другого устройства в той же Wi‑Fi** — если падает только при блокировке **этого** телефона, причина почти наверняка в остановке Termux на нём, а не в адресе HTTPS.

**Важно:** свёрнуть Termux ≠ заблокировать экран. При блокировке ограничения жёстче. Для круглосуточной работы телефон лучше держать на зарядке с пунктами 1–3.

### Проблема: DNS ошибка (EAI_AGAIN, ENOTFOUND, Could not resolve host)

Если вы видите ошибки типа:
- `Error: getaddrinfo EAI_AGAIN pubsub-edge.twitch.tv`
- `Could not resolve host: github.com`
- `DNS ошибка: не удается разрешить домен`

**Решение для Termux (Android):**

1. **Проверьте интернет-соединение:**
```bash
ping -c 3 8.8.8.8
```

2. **Используйте альтернативный DNS:**
```bash
# Установите dnsutils если нужно
pkg install dnsutils

# Проверьте текущий DNS
nslookup github.com

# Попробуйте использовать Google DNS
export DNS_SERVER=8.8.8.8
```

3. **Проверьте разрешения Termux:**
   - Настройки Android → Приложения → Termux → Разрешения
   - Убедитесь, что включен доступ к сети

4. **Если используется VPN/прокси:**
   - Отключите временно или настройте прокси в Termux:
   ```bash
   export http_proxy=http://your-proxy:port
   export https_proxy=http://your-proxy:port
   ```

**Решение для Docker:**

DNS настройки уже добавлены в `docker-compose.yml`:
```yaml
dns:
  - 8.8.8.8
  - 8.8.4.4
  - 1.1.1.1
```

Если проблема сохраняется:
1. Перезапустите контейнер: `docker-compose restart`
2. Проверьте сетевые настройки Docker
3. Убедитесь, что Docker имеет доступ к интернету

## HTTPS для дашборда (уведомления ОС в браузере на ПК)

По `http://IP:3001` браузер не показывает системные уведомления. Включите HTTPS:

```bash
pkg install openssl   # если ещё нет
```

В `.env`:

```env
WEB_SERVER_HTTPS=true
SSL_EXTRA_SANS=192.168.1.145
```

(подставьте IP телефона в LAN). Пересоберите и запустите. На ПК откройте `https://192.168.1.145:3001` и примите сертификат.

Подробнее: [HTTPS.md](./HTTPS.md).

## Альтернатива: Веб-интерфейс

Если добавить простой веб-сервер в приложение, можно будет:
- Запускать на сервере/VPS
- Управлять через браузер на Android
- Видеть статистику и логи

Это можно реализовать как дополнительную функцию.

