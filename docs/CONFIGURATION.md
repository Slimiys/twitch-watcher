# Настройка Twitch Watcher

## Проблема: Стримеры не находятся

Если вы видите сообщение `⚠️ No streamers found, waiting...`, попробуйте следующие решения:

### 1. Увеличьте параметры прокрутки

Создайте файл `.env` в корне проекта и добавьте:

```env
scrollDelay=5000
scrollTimes=15
```

Где:
- `scrollDelay` - задержка между прокрутками в миллисекундах (по умолчанию 2000)
- `scrollTimes` - количество прокруток страницы (по умолчанию 5)

### 2. Измените URL страницы со стримерами

Если текущий URL не работает, попробуйте другой:

```env
# Для VALORANT
streamersUrl=https://www.twitch.tv/directory/game/VALORANT?sort=VIEWER_COUNT&tl=c2542d6d-cd10-4532-919b-3d19f30a768b

# Для другой игры (например, Rust)
streamersUrl=https://www.twitch.tv/directory/game/Rust?sort=VIEWER_COUNT&tl=c2542d6d-cd10-4532-919b-3d19f30a768b
```

### 3. Проверьте, что вы авторизованы

Убедитесь, что:
- Токен авторизации (`auth-token`) действителен
- Вы вошли в аккаунт Twitch в браузере
- Токен не истек

### 4. Включите видимый режим браузера

В файле `src/app.ts` измените:

```typescript
const showBrowser = true; // Вместо false
```

Это позволит увидеть, что происходит в браузере.

### 5. Используйте переменные окружения

Все настройки можно задать через переменные окружения:

```env
# Основные настройки
streamersUrl=https://www.twitch.tv/directory/game/VALORANT?tl=c2542d6d-cd10-4532-919b-3d19f30a768b
scrollDelay=3000
scrollTimes=10
minWatching=15
maxWatching=30

# Приоритетные каналы
channelsWithPriority=streamer1,streamer2

# Всегда смотреть топ-стримера
watchAlwaysTopStreamer=false

# Прокси (если нужно)
proxy=ip:port
proxyAuth=username:password
```

### 6. Проверьте логи

После запуска проверьте логи:
- `🌐 Opening streamers page:` - открывается ли страница
- `🔍 Found X channel links on page` - сколько ссылок найдено
- `✅ Found X unique streamers` - сколько уникальных стримеров найдено

Если видите `Found 0 channel links`, значит селектор не находит элементы. Попробуйте увеличить `scrollTimes` и `scrollDelay`.

## Пример полного .env файла

```env
streamersUrl=https://www.twitch.tv/directory/game/VALORANT?sort=VIEWER_COUNT&tl=c2542d6d-cd10-4532-919b-3d19f30a768b
scrollDelay=5000
scrollTimes=15
minWatching=10
maxWatching=20
channelsWithPriority=your_favorite_streamer
watchAlwaysTopStreamer=false
```

