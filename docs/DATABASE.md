# База данных для хранения статистики

Приложение использует SQLite базу данных для хранения статистики о баллах стримеров.

**Важно:** База данных использует `sql.js` - SQLite, скомпилированный в WebAssembly. Это означает, что:
- ✅ **Не требуется компиляция** нативных модулей
- ✅ **Работает на всех платформах**, включая Android
- ✅ **Минимальные зависимости** - только JavaScript/WebAssembly
- ✅ **Полная совместимость** с SQLite

Если модуль `sql.js` не может быть установлен, приложение будет работать без базы данных, используя только файловое хранилище (`StatisticsStorage`).

## Структура базы данных

### Таблица `streamers`

Хранит общую статистику по каждому стримеру:

- `id` - Уникальный идентификатор (INTEGER PRIMARY KEY)
- `username` - Имя стримера (TEXT UNIQUE NOT NULL)
- `total_points` - Общее количество заработанных баллов (INTEGER DEFAULT 0)
- `total_watch_time_ms` - Общее время просмотра в миллисекундах (INTEGER DEFAULT 0)
- `created_at` - Время создания записи (INTEGER - timestamp)
- `updated_at` - Время последнего обновления (INTEGER - timestamp)
- `last_stream_start` - Время начала последнего стрима (INTEGER, timestamp)
- `last_stream_end` - Время окончания последнего стрима (INTEGER, timestamp)
- `last_stream_duration_ms` - Длительность последнего завершённого стрима (INTEGER, мс)

### Таблица `daily_points`

Хранит количество баллов, заработанных за каждый день:

- `id` - Уникальный идентификатор (INTEGER PRIMARY KEY)
- `streamer_id` - ID стримера (INTEGER, FOREIGN KEY)
- `date` - Дата в формате YYYY-MM-DD (TEXT NOT NULL)
- `points_earned` - Количество баллов за день (INTEGER DEFAULT 0)
- `created_at` - Время создания записи (INTEGER - timestamp)

**Уникальный индекс:** `(streamer_id, date)` - гарантирует одну запись на стримера в день

## Автоматическое сохранение

Данные автоматически сохраняются в базу данных при следующих событиях:

1. **Начисление баллов** - при каждом событии `points-earned`, `claim-earned`, `streak-earned`:
   - Обновляется `total_points` в таблице `streamers`
   - Добавляется/обновляется запись в `daily_points` для текущего дня

2. **Завершение сессии просмотра** - при завершении просмотра стрима:
   - Обновляется `total_watch_time_ms` в таблице `streamers`

3. **Окончание трансляции** (offline / WebSocket stream-down):
   - Обновляются `last_stream_end` и `last_stream_duration_ms` (разница с `last_stream_start`)

## Расположение базы данных

По умолчанию база данных создается в файле:
```
./statistics/database.db
```

Путь можно изменить через конфигурацию `StatisticsStorageConfig.storagePath`.

## API эндпоинты

### Получить статистику стримера

```http
GET /api/database/streamer-stats?username=<streamer_name>
```

**Ответ:**
```json
{
  "username": "streamer_name",
  "totalPoints": 15000,
  "totalWatchTimeMs": 3600000,
  "createdAt": 1703123456789,
  "updatedAt": 1703123456789
}
```

### Получить баллы за день

```http
GET /api/database/daily-points?username=<streamer_name>&date=2024-01-15
```

**Ответ:**
```json
{
  "username": "streamer_name",
  "date": "2024-01-15",
  "pointsEarned": 500
}
```

### Получить баллы за период

```http
GET /api/database/daily-points-range?username=<streamer_name>&startDate=2024-01-01&endDate=2024-01-31
```

**Ответ:**
```json
[
  {
    "id": 1,
    "streamerId": 1,
    "date": "2024-01-01",
    "pointsEarned": 300,
    "createdAt": 1704067200000
  },
  {
    "id": 2,
    "streamerId": 1,
    "date": "2024-01-02",
    "pointsEarned": 450,
    "createdAt": 1704153600000
  }
]
```

### Получить всех стримеров

```http
GET /api/database/all-streamers
```

**Ответ:**
```json
[
  {
    "username": "streamer1",
    "totalPoints": 15000,
    "totalWatchTimeMs": 3600000,
    "createdAt": 1703123456789,
    "updatedAt": 1703123456789
  },
  {
    "username": "streamer2",
    "totalPoints": 8000,
    "totalWatchTimeMs": 1800000,
    "createdAt": 1703123456789,
    "updatedAt": 1703123456789
  }
]
```

### Получить суммарные баллы за день (все стримеры)

```http
GET /api/database/total-daily-points?date=2024-01-15
```

**Ответ:**
```json
{
  "date": "2024-01-15",
  "totalPoints": 2500
}
```

## Использование в коде

### Получение экземпляра DatabaseStorage

```typescript
const streamWatcher = new StreamWatcher(...);
const dbStorage = streamWatcher.getDatabaseStorage();

if (dbStorage && dbStorage.isReady()) {
  // Работа с базой данных
  const stats = dbStorage.getStreamerStats('streamer_name');
  const dailyPoints = dbStorage.getDailyPoints('streamer_name', '2024-01-15');
}
```

### Программное добавление данных

```typescript
// Добавить баллы за день
dbStorage.addDailyPoints('streamer_name', 100, '2024-01-15');

// Обновить общее количество баллов
dbStorage.addTotalPoints('streamer_name', 100);

// Обновить время просмотра
dbStorage.addWatchTime('streamer_name', 3600000); // 1 час в миллисекундах
```

## Резервное копирование

Рекомендуется регулярно создавать резервные копии файла базы данных:

```bash
# Копирование базы данных
cp ./statistics/database.db ./statistics/database.db.backup

# Или с датой
cp ./statistics/database.db "./statistics/database.db.backup.$(date +%Y%m%d)"
```

## Производительность

База данных использует:
- **WAL режим** (Write-Ahead Logging) для лучшей производительности при параллельных операциях
- **Индексы** для быстрого поиска по `username` и `(streamer_id, date)`
- **Транзакции** для обеспечения целостности данных

## Миграция данных

Если у вас уже есть данные в JSON формате (через `StatisticsStorage`), их можно мигрировать в базу данных. Для этого можно использовать существующие сессии из `sessions.json` и агрегировать их в данные для базы данных.

## Очистка старых данных

Для удаления старых записей из `daily_points` можно использовать SQL:

```sql
-- Удалить записи старше 90 дней
DELETE FROM daily_points 
WHERE date < date('now', '-90 days');
```

**Внимание:** Будьте осторожны при удалении данных. Рекомендуется сначала создать резервную копию.

## Работа без базы данных

Если `sql.js` не может быть установлен, приложение автоматически отключит функции базы данных и будет работать только с файловым хранилищем (`StatisticsStorage`). Все остальные функции приложения будут работать нормально.

При запуске вы увидите предупреждение:
```
⚠️  sql.js not available: ... Database features will be disabled.
ℹ️  Database storage not available (sql.js not installed or not compatible)
```

Это не критично - приложение продолжит работу, просто статистика будет сохраняться только в JSON файлы через `StatisticsStorage`.

## Преимущества sql.js

По сравнению с `better-sqlite3`, использование `sql.js` дает следующие преимущества:

1. **Нет необходимости в компиляции** - модуль работает полностью на JavaScript/WebAssembly
2. **Работает на Android** - не требует Python, build tools или нативных компиляторов
3. **Меньше зависимостей** - не требует системных библиотек
4. **Кроссплатформенность** - одинаково работает на Windows, Linux, macOS и Android
5. **Простая установка** - `npm install sql.js` работает везде

Единственным недостатком является немного меньшая производительность по сравнению с нативными модулями, но для данного приложения это не критично.

