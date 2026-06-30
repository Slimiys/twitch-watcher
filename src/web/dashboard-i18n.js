/**
 * Локализация дашборда (русский / английский)
 */
(function initDashboardI18n(global) {
    const STORAGE_KEY = 'dashboardLocale';
    const localeChangeHandlers = [];

    /** @type {Record<string, Record<string, string>>} */
    const MESSAGES = {
        ru: {
            'page.title': 'Twitch Watcher — Дашборд',
            'lang.ru': 'Русский',
            'lang.en': 'English',

            'loading.starting': 'Запуск приложения…',
            'loading.waitingServerStart': 'Ожидание запуска сервера…',
            'loading.waitingServer': 'Ожидание сервера…',
            'loading.initializing': 'Инициализация…',
            'loading.connectingServer': 'Подключение к серверу…',
            'loading.setTokenInConfig': 'Укажите токен в «Конфиг бота»',
            'connection.serviceUnavailable': 'Сервис недоступен',
            'header.title': 'Twitch Watcher Dashboard',
            'header.tagline': 'Мониторинг и статистика в реальном времени',
            'header.uptime': 'Время после запуска: {duration}',
            'header.connecting': 'Подключение…',
            'header.connected': 'Подключён',
            'header.reconnecting': 'Переподключение…',
            'header.disconnected': 'Отключён',
            'header.dataRefresh': 'Обновление данных',
            'header.interval': 'Интервал:',
            'header.colorizeNames': 'Цвет имён:',
            'header.autoUpdate': 'Автообновление:',
            'header.autoUpdateTitle': 'При обнаружении обновления установка запустится без подтверждения',
            'header.actions': 'Действия',
            'header.tests': 'Тесты',
            'header.testsTitle': 'Тестирование',
            'header.update': 'Обновиться',
            'header.updateTitle': 'git pull и run-local.sh (Termux)',
            'header.stop': 'Остановить',
            'header.stopTitle': 'Остановить бота',
            'header.restart': 'Перезапустить',
            'header.restartTitle': 'Перезапустить бота',
            'header.botConfig': 'Конфиг бота',
            'header.botConfigTitle': 'Настройки бота (config.json)',
            'header.settings': 'Настройки',
            'header.settingsTitle': 'Настройки интерфейса',
            'header.export': 'Экспорт',
            'header.exportTitle': 'Экспорт логов',
            'header.exportAllCsv': 'Экспорт всего (CSV)',
            'header.exportAllJson': 'Экспорт всего (JSON)',
            'header.updating': 'Обновление…',

            'stats.activeWatches': 'Активные просмотры',
            'stats.activeWatchesLabel': 'Сейчас смотрим',
            'stats.totalPoints': 'Всего баллов',
            'stats.totalPointsLabel': 'Заработано за сессию',
            'stats.streamers': 'Стримеры',
            'stats.streamersLabel': 'Всего стримеров',
            'stats.lastOnline': 'Последний онлайн',
            'stats.lastOnlineLabel': 'Когда стример вышел в эфир',
            'stats.lastOnlineFormat': '{streamer} · {time} назад',

            'streamers.title': 'Все стримеры',
            'streamers.addPlaceholder': 'Имя стримера',
            'streamers.add': 'Добавить',
            'streamers.columnSettings': 'Настройки колонок',
            'streamers.visibleColumns': 'Видимые колонки',
            'streamers.hideOffline': 'Скрыть офлайн',
            'streamers.showOffline': 'Показать офлайн',

            'col.notify': 'Уведомления',
            'col.streamer': 'Стример',
            'col.status': 'Статус',
            'col.watchTime': 'Время просмотра',
            'col.pointsEarned': 'Заработано',
            'col.currentPoints': 'Текущие баллы',
            'col.game': 'Категория',
            'col.streams': 'Стримы',
            'col.viewers': 'Зрители',
            'col.lastStreamStart': 'Начало стрима',
            'col.lastStreamEnd': 'Конец стрима',
            'col.lastStreamDuration': 'Длительность',
            'col.actions': 'Действия',
            'col.streamsPeriodTitle': 'Правый клик — выбрать период (7d / 14d / 30d / 60d)',
            'col.streamsWindow': 'Стримы ({days}d)',
            'col.notifyAllOn': 'Включить оповещения у всех стримеров',
            'col.notifyAllOff': 'Выключить оповещения у всех стримеров',
            'col.notifyOn': 'Уведомления включены',
            'col.notifyOff': 'Уведомления выключены',

            'status.online': 'ONLINE',
            'status.offline': 'OFFLINE',

            'table.loadFailed': 'Не удалось загрузить статистику',
            'table.noStreamers': 'Стримеры не настроены',
            'table.noOnline': 'Сейчас нет онлайн-стримеров',
            'table.noCategoryFilter': 'Нет стримеров по выбранным категориям',
            'table.remove': 'Удалить',
            'table.streamDatesTitle': 'Показать даты начала стримов',
            'table.streamDatesEmpty': 'Даты появятся после учёта стримов',
            'table.categoryStatsTitle': 'Показать статистику по категориям',
            'table.categoryStatsEmpty': 'Статистика появится после смены категорий в стримах',
            'table.streamsByCategory': 'Стримы по категориям',
            'table.noCategoryData': 'Пока нет данных по категориям',

            'fav.title': 'Избранные категории',
            'fav.placeholder': 'Название категории…',
            'fav.add': 'Добавить',
            'fav.empty': 'Нет избранных категорий',
            'fav.onlineCount': '{count} онлайн',
            'fav.clearFilter': 'Снять фильтр по этой категории',
            'fav.applyFilter': 'Показать стримеров с этой категорией',
            'fav.remove': 'Удалить из избранного',
            'fav.removeAria': 'Удалить категорию',
            'fav.filterHint': 'Фильтр по текущей (онлайн) или последней (офлайн) категории. Офлайн-стримеры скрываются кнопкой «Скрыть офлайн».',

            'streams.noStreams': 'Нет стримов за выбранный период',
            'streams.menuTitle': 'Стримы ({days}d)',

            'export.exporting': 'Экспорт…',

            'testData.confirm': 'Вы уверены, что хотите заполнить приложение тестовыми данными?\n\nЭто действие создаст:\n- Около 1000 тестовых событий различных типов\n- Несколько тестовых стримеров\n\nЭто действие предназначено только для тестирования.',
            'testData.generating': 'Генерация…',
            'testData.success': 'Тестовые данные созданы.\n- {events} событий\n- {streamers} стримеров',
            'testData.failed': 'Не удалось создать тестовые данные',

            'tokenInvalid.confirm': 'Вы уверены, что хотите пометить токен как невалидный?\n\nЭто действие вызовет критическое уведомление и может привести к перезапуску контейнера через healthcheck.\n\nЭто действие предназначено только для тестирования.',
            'tokenInvalid.processing': 'Обработка…',
            'tokenInvalid.success': 'Токен помечен невалидным. Healthcheck перезапустит контейнер.',
            'tokenInvalid.failed': 'Не удалось пометить токен невалидным',

            'appConfig.settingsLoadFailed': 'Не удалось загрузить настройки просмотра с сервера.',
            'appConfig.settingsLoading': 'Загрузка настроек с сервера…',
            'appConfig.settingsLoadError': 'Не удалось загрузить настройки: {error}',

            'settings.osBlocked': 'Уведомления ОС заблокированы. Разрешите в настройках сайта (замок в адресной строке) и обновите страницу.',
            'settings.osAllow': 'Разрешите уведомления в браузере при сохранении настроек.',

            'search.nothingFound': 'Ничего не найдено',

            'table.lastStreamTitle': 'Последний завершённый стрим',

            'health.durationSec': '{n} с',
            'health.durationMin': '{n} мин',
            'health.durationHours': '{hours} ч {minutes} мин',
            'health.durationDays': '{days} д {hours} ч',
            'health.network.websocket': 'WebSocket',
            'health.network.graphqlCb': 'GraphQL CB',

            'integrity.token': 'Токен',
            'integrity.previousToken': 'Прошлый токен',
            'integrity.currentToken': 'Текущий токен',
            'integrity.bonusClaim': 'Сбор бонусов',
            'integrity.cardClickHint': 'Нажмите на карточку для запроса токена',
            'integrity.claim.noAttempts': 'В этой сессии попыток сбора бонусов ещё не было',
            'integrity.claim.ok': 'Бонусы собираются успешно',
            'integrity.claim.tokenNotSet': 'Токен Client-Integrity не задан',
            'integrity.claim.tokenInvalid': 'Токен истёк или недействителен — обновите Client-Integrity',
            'integrity.claim.integrityBlocked': 'Сбор заблокирован: ошибка integrity ({streamer})',
            'integrity.claim.failed': 'Последний claim неудачен ({streamer})',

            'catStats.title': 'Статистика',
            'catStats.loading': 'Загрузка…',
            'catStats.empty': 'Пока нет зафиксированных категорий',
            'catStats.expand': 'Развернуть',
            'catStats.collapse': 'Свернуть',
            'catStats.noStreamers': 'Нет данных по стримерам',
            'catStats.reset': 'Сбросить',
            'catStats.resetTitle': 'Сбросить статистику по категориям',
            'catStats.resetConfirmTitle': 'Сбросить статистику?',
            'catStats.resetConfirmBody': 'Будут удалены все накопленные данные о времени стримов по категориям. Учёт текущих стримов начнётся заново. Это действие нельзя отменить. Продолжить?',
            'catStats.resetting': 'Сброс…',

            'health.title': 'Статус бота',
            'health.loading': 'Загрузка…',
            'health.claimsTitle': 'Последние 5 claim',
            'health.claimsEmpty': 'Пока нет попыток сбора бонусов',
            'health.claimsEmptySession': 'Пока нет попыток сбора бонусов в этой сессии',
            'health.watcherNotRunning': 'Watcher не запущен',
            'health.wsGraphql': 'WebSocket / GraphQL',
            'health.watching': 'Просмотр',
            'health.running': 'Работает',
            'health.stopped': 'Остановлен',
            'health.ws.connected': 'Подключён',
            'health.ws.reconnecting': 'Переподключение',
            'health.ws.disconnected': 'Отключён',
            'health.ws.stopped': 'Остановлен',
            'health.ws.state': 'Состояние: {state}',
            'health.ws.attempt': 'Попытка {current}/{max}',
            'health.cb.closed': 'Закрыт (OK)',
            'health.cb.open': 'Открыт (блокировка)',
            'health.cb.halfOpen': 'Полуоткрыт',
            'health.gql.networkErrors': 'Недавние сетевые ошибки GraphQL',
            'health.gqlHeaders': 'GQL-заголовки',
            'health.updated': 'Обновлено',
            'health.ago': '{duration} назад',
            'health.claim.success': 'Успех',
            'health.claim.error': 'Ошибка',
            'health.integrity.click': 'Нажмите, чтобы запросить Client-Integrity (расширение Edge, twitch.tv)',
            'health.integrity.wait': 'Ожидание передачи Client-Integrity от расширения…',
            'health.integrity.pending': 'Ожидание передачи от расширения…',
            'health.integrity.disabled': 'Приём от расширения отключён (INTEGRITY_BRIDGE_ENABLED=false)',

            'token.title': 'Информация о токене',
            'token.fillTest': 'Тестовые данные',
            'token.fillTestTitle': 'Заполнить тестовыми данными (1000 событий)',
            'token.markInvalid': 'Пометить невалидным',
            'token.markInvalidTitle': 'Пометить токен невалидным (тест перезапуска)',
            'db.title': 'Статус базы данных',

            'modal.close': 'Закрыть',
            'modal.cancel': 'Отмена',
            'modal.confirm': 'Подтвердить',
            'modal.confirmTitle': 'Подтверждение',
            'modal.save': 'Сохранить',

            'test.title': 'Тестирование',
            'test.notifications': 'Уведомления',
            'test.hint': 'Проверка без смены статуса стримера. ОС-уведомления — через браузер на этом ПК. По HTTP с IP браузер их не покажет; на сервере: WEB_SERVER_HTTPS=true, затем https://IP:3001.',
            'test.toast': 'Toast',
            'test.os': 'Уведомления ОС',
            'test.sound': 'Звук',

            'settings.title': 'Настройки',
            'settings.display': 'Отображение',
            'settings.fontSize': 'Размер шрифта:',
            'settings.font.small': 'Маленький',
            'settings.font.medium': 'Средний',
            'settings.font.large': 'Большой',
            'settings.density': 'Плотность отображения:',
            'settings.density.compact': 'Компактный',
            'settings.density.normal': 'Обычный',
            'settings.density.spacious': 'Просторный',
            'settings.events': 'События',
            'settings.autoScroll': 'Автопрокрутка к новым событиям',
            'settings.eventsPageSize': 'Количество событий на странице:',
            'settings.chart': 'График',
            'settings.saveZoom': 'Сохранять состояние зума',
            'settings.autoUpdateChart': 'Автоматическое обновление графика',
            'settings.notifications': 'Уведомления',
            'settings.showToast': 'Показывать toast-уведомления',
            'settings.osNotify': 'Уведомления ОС (браузер)',
            'settings.sound': 'Звуковые уведомления',
            'settings.notifyHint': 'Разрешите уведомления в браузере при сохранении настроек.',
            'settings.manage': 'Управление настройками',
            'settings.export': 'Экспорт настроек',
            'settings.import': 'Импорт настроек',

            'appConfig.title': 'Конфиг бота',
            'appConfig.hint': 'Параметры сохраняются в config.json (секция app и поле token). В подписях в скобках — имена из DevTools (Cookies / Request Headers запроса gql).',
            'appConfig.loading': 'Загрузка…',
            'appConfig.watch': 'Просмотр (minute-watched)',
            'appConfig.watchHint': 'Ротация по очереди: один онлайн-канал за раз.',
            'appConfig.cyclePause': 'Пауза между каналами (сек):',

            'duration.hour': 'час',
            'duration.hoursFew': 'часа',
            'duration.hoursMany': 'часов',
            'duration.minute': 'минута',
            'duration.minutesFew': 'минуты',
            'duration.minutesMany': 'минут',

            'time.justNow': 'только что',
            'time.expired': 'истёк',

            'notify.stopTitle': 'Остановить бота?',
            'notify.stopBody': 'Процесс twitch-watcher будет завершён. Дашборд отключится. Продолжить?',
            'notify.restartTitle': 'Перезапустить бота?',
            'notify.restartBody': 'Будет выполнено: остановка процесса → npm start в фоне. Дашборд отключится на 1–2 минуты. Продолжить?',
            'notify.stopping': 'Остановка…',
            'notify.stopFailed': 'Не удалось остановить',
            'notify.restarting': 'Перезапуск…',
            'notify.restartFailed': 'Не удалось перезапустить',
            'notify.restartDone': 'Перезапуск завершён. Перезагрузка страницы…',
            'notify.updateDone': 'Обновление завершено. Перезагрузка страницы…',
            'notify.reloadPage': 'Перезагрузка страницы…',
            'notify.botOnline': 'Бот снова online. Перезагрузка страницы…',
            'notify.refreshF5': 'Обновите страницу (F5)',
            'notify.botTimeout': 'Бот долго не отвечает. Обновите страницу (F5) или откройте дашборд заново.',
            'notify.updateInterrupted': 'Обновление прервано — обновите страницу (F5)',
            'notify.updateScriptFailed': 'Скрипт обновления завершился, но бот не перезапустился. См. logs/dashboard-update.log',
            'notify.updateRunning': 'Обновление уже выполняется. Лог: logs/dashboard-update.log',
            'notify.checkFailed': 'Не удалось проверить обновления',
            'notify.versionOk': 'Версия актуальна ({remote}/{branch})',
            'notify.updateUnavailable': 'Обновление сейчас недоступно',
            'notify.updateStarting': 'Запуск обновления…',
            'notify.updateFailed': 'Не удалось запустить обновление',
            'notify.settingsSaved': 'Настройки интерфейса сохранены',
            'notify.settingsExported': 'Настройки экспортированы',
            'notify.settingsImported': 'Настройки импортированы',
            'notify.settingsImportError': 'Ошибка при импорте настроек',
            'notify.configLoadFailed': 'Не удалось загрузить конфиг бота',
            'notify.configSaveFailed': 'Не удалось сохранить конфиг',
            'notify.watchSaveFailed': 'Не удалось сохранить интервал просмотра',
            'notify.osFailed': 'Не удалось показать уведомление ОС. Обновите страницу и проверьте настройки сайта.',
            'notify.enterStreamer': 'Введите имя стримера',
            'notify.streamerAdded': 'Стример {name} добавлен',
            'notify.streamerAddFailed': 'Не удалось добавить стримера',
            'notify.streamerRemoved': 'Стример {name} удалён',
            'notify.streamerRemoveFailed': 'Не удалось удалить стримера',
            'notify.removeStreamerTitle': 'Подтверждение удаления',
            'notify.removeStreamerBody': 'Вы уверены, что хотите удалить {name} из отслеживания?',
            'notify.streamerRemoveRetry': 'Не удалось удалить стримера. Попробуйте снова.',
            'notify.categoryHintsFailed': 'Не удалось загрузить подсказки категорий',
            'notify.pickCategory': 'Выберите категорию из списка подсказок',
            'notify.categoryAdded': 'Категория «{name}» добавлена',
            'notify.categoryAddFailed': 'Не удалось добавить категорию',
            'notify.categoryRemoved': 'Категория удалена',
            'notify.categoryRemoveFailed': 'Не удалось удалить категорию',
            'notify.catStatsResetSuccess': 'Статистика по категориям сброшена',
            'notify.catStatsResetFailed': 'Не удалось сбросить статистику',
            'notify.openBotConfig': 'Откройте «Конфиг бота» в шапке и укажите auth-token',

            'lifecycle.update': 'Обновление',
            'lifecycle.restart': 'Перезапуск',
            'lifecycle.checking': 'Проверка…',
            'lifecycle.autoUpdating': 'Автообновление…',

            'version.checkTitle': 'Нажмите, чтобы проверить обновление',
            'version.title': 'Версия',
            'version.availableTitle': 'Доступно обновление с dev — нажмите для установки',
            'version.okTitle': 'Версия совпадает с origin/dev',
            'version.currentLabel': 'Актуальная версия',
            'version.errorLabel': 'Ошибка проверки',
            'version.availableShort': 'Доступно обновление',
            'version.availableWithRevision': 'Доступно: {revision} ({when})',
            'version.availableWithRevisionOnly': 'Доступно: {revision}',
            'version.checkUnavailable': 'Проверка недоступна',
            'version.updatingTitle': 'Идёт обновление…',
            'version.errorTitle': 'Ошибка проверки — нажмите повторить',
            'version.local': 'Локально:',
            'version.enableAutoUpdate': 'Для установки включите DASHBOARD_UPDATE_ENABLED в «Конфиг бота»',
            'version.autoUpdateHint': 'Сохраняет выбор. Чтобы автообновление работало, включите DASHBOARD_UPDATE_ENABLED в «Конфиг бота»',
            'version.autoUpdateEnabled': 'Автообновление включено в интерфейсе. Для запуска установки включите DASHBOARD_UPDATE_ENABLED в «Конфиг бота»',

            'integrity.unknownToken': 'неизвестно (токен из config)',
            'integrity.neverUpdated': 'не обновлялся',
            'integrity.notSet': 'не задан ({source})',
            'integrity.expired': 'истёк ({source})',
            'integrity.valid': 'действует ({source})',
            'integrity.noData': 'нет данных',
            'integrity.approx': ' (прибл.)',
            'integrity.expiresIn': ', истекает через {duration}',
        },
        en: {
            'page.title': 'Twitch Watcher — Dashboard',
            'lang.ru': 'Русский',
            'lang.en': 'English',

            'loading.starting': 'Starting application…',
            'loading.waitingServerStart': 'Waiting for server to start…',
            'loading.waitingServer': 'Waiting for server…',
            'loading.initializing': 'Initializing…',
            'loading.connectingServer': 'Connecting to server…',
            'loading.setTokenInConfig': 'Set token in Bot config',
            'connection.serviceUnavailable': 'Service unavailable',
            'header.title': 'Twitch Watcher Dashboard',
            'header.tagline': 'Real-time monitoring and statistics',
            'header.uptime': 'Uptime: {duration}',
            'header.connecting': 'Connecting…',
            'header.connected': 'Connected',
            'header.reconnecting': 'Reconnecting…',
            'header.disconnected': 'Disconnected',
            'header.dataRefresh': 'Data refresh',
            'header.interval': 'Interval:',
            'header.colorizeNames': 'Colorize names:',
            'header.autoUpdate': 'Auto-update:',
            'header.autoUpdateTitle': 'When an update is detected, install runs without confirmation',
            'header.actions': 'Actions',
            'header.tests': 'Tests',
            'header.testsTitle': 'Testing',
            'header.update': 'Update',
            'header.updateTitle': 'git pull and run-local.sh (Termux)',
            'header.stop': 'Stop',
            'header.stopTitle': 'Stop the bot',
            'header.restart': 'Restart',
            'header.restartTitle': 'Restart the bot',
            'header.botConfig': 'Bot config',
            'header.botConfigTitle': 'Bot settings (config.json)',
            'header.settings': 'Settings',
            'header.settingsTitle': 'UI settings',
            'header.export': 'Export',
            'header.exportTitle': 'Export logs',
            'header.exportAllCsv': 'Export all (CSV)',
            'header.exportAllJson': 'Export all (JSON)',
            'header.updating': 'Updating…',

            'stats.activeWatches': 'Active Watches',
            'stats.activeWatchesLabel': 'Currently watching',
            'stats.totalPoints': 'Total Points',
            'stats.totalPointsLabel': 'Points earned this session',
            'stats.streamers': 'Streamers',
            'stats.streamersLabel': 'Total streamers',
            'stats.lastOnline': 'Last Online',
            'stats.lastOnlineLabel': 'Last streamer went live',
            'stats.lastOnlineFormat': '{streamer} · {time} ago',

            'streamers.title': 'All Streamers',
            'streamers.addPlaceholder': 'Enter streamer name',
            'streamers.add': 'Add',
            'streamers.columnSettings': 'Column settings',
            'streamers.visibleColumns': 'Visible Columns',
            'streamers.hideOffline': 'Hide Offline',
            'streamers.showOffline': 'Show Offline',

            'col.notify': 'Notifications',
            'col.streamer': 'Streamer',
            'col.status': 'Status',
            'col.watchTime': 'Watch Time',
            'col.pointsEarned': 'Points Earned',
            'col.currentPoints': 'Current Points',
            'col.game': 'Category',
            'col.streams': 'Streams',
            'col.viewers': 'Viewers',
            'col.lastStreamStart': 'Last Stream Start',
            'col.lastStreamEnd': 'Last Stream End',
            'col.lastStreamDuration': 'Last Stream Duration',
            'col.actions': 'Actions',
            'col.streamsPeriodTitle': 'Right-click to choose period (7d / 14d / 30d / 60d)',
            'col.streamsWindow': 'Streams ({days}d)',
            'col.notifyAllOn': 'Enable notifications for all streamers',
            'col.notifyAllOff': 'Disable notifications for all streamers',
            'col.notifyOn': 'Notifications enabled',
            'col.notifyOff': 'Notifications disabled',

            'status.online': 'ONLINE',
            'status.offline': 'OFFLINE',

            'table.loadFailed': 'Failed to load statistics',
            'table.noStreamers': 'No streamers configured',
            'table.noOnline': 'No streamers are currently online',
            'table.noCategoryFilter': 'No streamers match selected categories',
            'table.remove': 'Remove',
            'table.streamDatesTitle': 'Show stream start dates',
            'table.streamDatesEmpty': 'Dates appear after streams are tracked',
            'table.categoryStatsTitle': 'Show category statistics',
            'table.categoryStatsEmpty': 'Stats appear after category changes on streams',
            'table.streamsByCategory': 'Streams by category',
            'table.noCategoryData': 'No category data yet',

            'fav.title': 'Favorite categories',
            'fav.placeholder': 'Category name…',
            'fav.add': 'Add',
            'fav.empty': 'No favorite categories',
            'fav.onlineCount': '{count} online',
            'fav.clearFilter': 'Clear filter for this category',
            'fav.applyFilter': 'Show streamers in this category',
            'fav.remove': 'Remove from favorites',
            'fav.removeAria': 'Remove category',
            'fav.filterHint': 'Filter by current (online) or last (offline) category. Offline streamers are hidden with Hide Offline.',

            'streams.noStreams': 'No streams in the selected period',
            'streams.menuTitle': 'Streams ({days}d)',

            'export.exporting': 'Exporting…',

            'testData.confirm': 'Fill the app with test data?\n\nThis will create:\n- About 1000 test events of various types\n- Several test streamers\n\nFor testing only.',
            'testData.generating': 'Generating…',
            'testData.success': 'Test data generated.\n- {events} events\n- {streamers} streamers',
            'testData.failed': 'Failed to generate test data',

            'tokenInvalid.confirm': 'Mark the token as invalid?\n\nThis triggers a critical notification and may restart the container via healthcheck.\n\nFor testing only.',
            'tokenInvalid.processing': 'Processing…',
            'tokenInvalid.success': 'Token marked invalid. Healthcheck will restart the container.',
            'tokenInvalid.failed': 'Failed to mark token as invalid',

            'appConfig.settingsLoadFailed': 'Failed to load watch settings from server.',
            'appConfig.settingsLoading': 'Loading settings from server…',
            'appConfig.settingsLoadError': 'Failed to load settings: {error}',

            'settings.osBlocked': 'OS notifications are blocked. Allow them in site settings (lock icon) and refresh.',
            'settings.osAllow': 'Allow notifications in the browser when saving settings.',

            'search.nothingFound': 'Nothing found',

            'table.lastStreamTitle': 'Last completed stream',

            'health.durationSec': '{n}s',
            'health.durationMin': '{n} min',
            'health.durationHours': '{hours}h {minutes}m',
            'health.durationDays': '{days}d {hours}h',
            'health.network.websocket': 'WebSocket',
            'health.network.graphqlCb': 'GraphQL CB',

            'integrity.token': 'Token',
            'integrity.previousToken': 'Previous token',
            'integrity.currentToken': 'Current token',
            'integrity.bonusClaim': 'Bonus claims',
            'integrity.cardClickHint': 'Click the card to request a token',
            'integrity.claim.noAttempts': 'No bonus claim attempts in this session yet',
            'integrity.claim.ok': 'Bonuses are being claimed successfully',
            'integrity.claim.tokenNotSet': 'Client-Integrity token is not set',
            'integrity.claim.tokenInvalid': 'Token expired or invalid — refresh Client-Integrity',
            'integrity.claim.integrityBlocked': 'Claims blocked: integrity error ({streamer})',
            'integrity.claim.failed': 'Last claim failed ({streamer})',

            'catStats.title': 'Statistics',
            'catStats.loading': 'Loading…',
            'catStats.empty': 'No tracked categories yet',
            'catStats.expand': 'Expand',
            'catStats.collapse': 'Collapse',
            'catStats.noStreamers': 'No streamer data',
            'catStats.reset': 'Reset',
            'catStats.resetTitle': 'Reset category stream statistics',
            'catStats.resetConfirmTitle': 'Reset statistics?',
            'catStats.resetConfirmBody': 'All accumulated category stream duration data will be deleted. Current streams will be tracked from scratch. This cannot be undone. Continue?',
            'catStats.resetting': 'Resetting…',

            'health.title': 'Bot status',
            'health.loading': 'Loading…',
            'health.claimsTitle': 'Last 5 claims',
            'health.claimsEmpty': 'No bonus claim attempts yet',
            'health.claimsEmptySession': 'No bonus claim attempts in this session yet',
            'health.watcherNotRunning': 'Watcher is not running',
            'health.wsGraphql': 'WebSocket / GraphQL',
            'health.watching': 'Watching',
            'health.running': 'Running',
            'health.stopped': 'Stopped',
            'health.ws.connected': 'Connected',
            'health.ws.reconnecting': 'Reconnecting',
            'health.ws.disconnected': 'Disconnected',
            'health.ws.stopped': 'Stopped',
            'health.ws.state': 'State: {state}',
            'health.ws.attempt': 'Attempt {current}/{max}',
            'health.cb.closed': 'Closed (OK)',
            'health.cb.open': 'Open (blocked)',
            'health.cb.halfOpen': 'Half-open',
            'health.gql.networkErrors': 'Recent GraphQL network errors',
            'health.gqlHeaders': 'GQL headers',
            'health.updated': 'Updated',
            'health.ago': '{duration} ago',
            'health.claim.success': 'Success',
            'health.claim.error': 'Error',
            'health.integrity.click': 'Click to request Client-Integrity (Edge extension, twitch.tv)',
            'health.integrity.wait': 'Waiting for Client-Integrity from extension…',
            'health.integrity.pending': 'Waiting for extension transfer…',
            'health.integrity.disabled': 'Extension bridge disabled (INTEGRITY_BRIDGE_ENABLED=false)',

            'token.title': 'Token Information',
            'token.fillTest': 'Fill Test Data',
            'token.fillTestTitle': 'Fill with test data (1000 events)',
            'token.markInvalid': 'Mark Invalid',
            'token.markInvalidTitle': 'Mark token invalid (container restart test)',
            'db.title': 'Database Status',

            'modal.close': 'Close',
            'modal.cancel': 'Cancel',
            'modal.confirm': 'Confirm',
            'modal.confirmTitle': 'Confirmation',
            'modal.save': 'Save',

            'test.title': 'Testing',
            'test.notifications': 'Notifications',
            'test.hint': 'Test without changing streamer status. OS notifications use this PC browser. Over HTTP by IP the browser will not show them; on server set WEB_SERVER_HTTPS=true, then https://IP:3001.',
            'test.toast': 'Toast',
            'test.os': 'OS notifications',
            'test.sound': 'Sound',

            'settings.title': 'Settings',
            'settings.display': 'Display',
            'settings.fontSize': 'Font size:',
            'settings.font.small': 'Small',
            'settings.font.medium': 'Medium',
            'settings.font.large': 'Large',
            'settings.density': 'Display density:',
            'settings.density.compact': 'Compact',
            'settings.density.normal': 'Normal',
            'settings.density.spacious': 'Spacious',
            'settings.events': 'Events',
            'settings.autoScroll': 'Auto-scroll to new events',
            'settings.eventsPageSize': 'Events per page:',
            'settings.chart': 'Chart',
            'settings.saveZoom': 'Save zoom state',
            'settings.autoUpdateChart': 'Auto-update chart',
            'settings.notifications': 'Notifications',
            'settings.showToast': 'Show toast notifications',
            'settings.osNotify': 'OS notifications (browser)',
            'settings.sound': 'Sound notifications',
            'settings.notifyHint': 'Allow notifications in the browser when saving settings.',
            'settings.manage': 'Settings management',
            'settings.export': 'Export settings',
            'settings.import': 'Import settings',

            'appConfig.title': 'Bot config',
            'appConfig.hint': 'Settings are saved to config.json (app section and token field). Labels in parentheses match DevTools (Cookies / gql request headers).',
            'appConfig.loading': 'Loading…',
            'appConfig.watch': 'Watching (minute-watched)',
            'appConfig.watchHint': 'Round-robin: one online channel at a time.',
            'appConfig.cyclePause': 'Pause between channels (sec):',

            'duration.hour': 'hour',
            'duration.hoursFew': 'hours',
            'duration.hoursMany': 'hours',
            'duration.minute': 'minute',
            'duration.minutesFew': 'minutes',
            'duration.minutesMany': 'minutes',

            'time.justNow': 'just now',
            'time.expired': 'expired',

            'notify.stopTitle': 'Stop the bot?',
            'notify.stopBody': 'The twitch-watcher process will exit. The dashboard will go offline. Continue?',
            'notify.restartTitle': 'Restart the bot?',
            'notify.restartBody': 'Stop process → npm start in background. Dashboard offline for 1–2 minutes. Continue?',
            'notify.stopping': 'Stopping…',
            'notify.stopFailed': 'Failed to stop',
            'notify.restarting': 'Restarting…',
            'notify.restartFailed': 'Failed to restart',
            'notify.restartDone': 'Restart complete. Reloading page…',
            'notify.updateDone': 'Update complete. Reloading page…',
            'notify.reloadPage': 'Reloading page…',
            'notify.botOnline': 'Bot is online again. Reloading page…',
            'notify.refreshF5': 'Refresh the page (F5)',
            'notify.botTimeout': 'Bot is not responding. Refresh (F5) or reopen the dashboard.',
            'notify.updateInterrupted': 'Update interrupted — refresh the page (F5)',
            'notify.updateScriptFailed': 'Update script finished but bot did not restart. See logs/dashboard-update.log',
            'notify.updateRunning': 'Update already running. Log: logs/dashboard-update.log',
            'notify.checkFailed': 'Failed to check for updates',
            'notify.versionOk': 'Version is up to date ({remote}/{branch})',
            'notify.updateUnavailable': 'Update is not available now',
            'notify.updateStarting': 'Starting update…',
            'notify.updateFailed': 'Failed to start update',
            'notify.settingsSaved': 'UI settings saved',
            'notify.settingsExported': 'Settings exported',
            'notify.settingsImported': 'Settings imported',
            'notify.settingsImportError': 'Failed to import settings',
            'notify.configLoadFailed': 'Failed to load bot config',
            'notify.configSaveFailed': 'Failed to save config',
            'notify.watchSaveFailed': 'Failed to save watch interval',
            'notify.osFailed': 'Failed to show OS notification. Refresh and check site settings.',
            'notify.enterStreamer': 'Please enter a streamer name',
            'notify.streamerAdded': 'Streamer {name} added',
            'notify.streamerAddFailed': 'Failed to add streamer',
            'notify.streamerRemoved': 'Streamer {name} removed',
            'notify.streamerRemoveFailed': 'Failed to remove streamer',
            'notify.removeStreamerTitle': 'Confirm removal',
            'notify.removeStreamerBody': 'Remove {name} from tracking?',
            'notify.streamerRemoveRetry': 'Failed to remove streamer. Please try again.',
            'notify.categoryHintsFailed': 'Failed to load category suggestions',
            'notify.pickCategory': 'Pick a category from suggestions',
            'notify.categoryAdded': 'Category «{name}» added',
            'notify.categoryAddFailed': 'Failed to add category',
            'notify.categoryRemoved': 'Category removed',
            'notify.categoryRemoveFailed': 'Failed to remove category',
            'notify.catStatsResetSuccess': 'Category statistics reset',
            'notify.catStatsResetFailed': 'Failed to reset statistics',
            'notify.openBotConfig': 'Open Bot config in the header and set auth-token',

            'lifecycle.update': 'Update',
            'lifecycle.restart': 'Restart',
            'lifecycle.checking': 'Checking…',
            'lifecycle.autoUpdating': 'Auto-updating…',

            'version.checkTitle': 'Click to check for updates',
            'version.title': 'Version',
            'version.availableTitle': 'Update available on dev — click to install',
            'version.okTitle': 'Version matches origin/dev',
            'version.currentLabel': 'Up to date',
            'version.errorLabel': 'Check failed',
            'version.availableShort': 'Update available',
            'version.availableWithRevision': 'Available: {revision} ({when})',
            'version.availableWithRevisionOnly': 'Available: {revision}',
            'version.checkUnavailable': 'Check unavailable',
            'version.updatingTitle': 'Updating…',
            'version.errorTitle': 'Check failed — click to retry',
            'version.local': 'Local:',
            'version.enableAutoUpdate': 'Enable DASHBOARD_UPDATE_ENABLED in Bot config to install',
            'version.autoUpdateHint': 'Saves preference. Enable DASHBOARD_UPDATE_ENABLED in Bot config for auto-install',
            'version.autoUpdateEnabled': 'Auto-update enabled in UI. Enable DASHBOARD_UPDATE_ENABLED in Bot config to install',

            'integrity.unknownToken': 'unknown (token from config)',
            'integrity.neverUpdated': 'never updated',
            'integrity.notSet': 'not set ({source})',
            'integrity.expired': 'expired ({source})',
            'integrity.valid': 'valid ({source})',
            'integrity.noData': 'no data',
            'integrity.approx': ' (approx.)',
            'integrity.expiresIn': ', expires in {duration}',
        },
    };

    let locale = 'ru';

    function readStoredLocale() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored === 'en' || stored === 'ru') {
                return stored;
            }
        } catch {
            // ignore
        }
        const nav = (navigator.language || '').toLowerCase();
        return nav.startsWith('ru') ? 'ru' : 'en';
    }

    /**
     * Возвращает перевод по ключу
     * @param {string} key
     * @param {Record<string, string|number>} [params]
     */
    function t(key, params = {}) {
        const dict = MESSAGES[locale] || MESSAGES.en;
        let text = dict[key] ?? MESSAGES.en[key] ?? key;
        Object.entries(params).forEach(([name, value]) => {
            text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
        });
        return text;
    }

    function getLocale() {
        return locale;
    }

    function setLocale(next) {
        const normalized = next === 'en' ? 'en' : 'ru';
        if (locale === normalized) {
            return;
        }
        locale = normalized;
        try {
            localStorage.setItem(STORAGE_KEY, locale);
        } catch {
            // ignore
        }
        document.documentElement.lang = locale;
        applyI18nToDocument();
        localeChangeHandlers.forEach((handler) => {
            try {
                handler(locale);
            } catch (error) {
                console.error('locale change handler failed:', error);
            }
        });
    }

    function onLocaleChange(handler) {
        localeChangeHandlers.push(handler);
    }

    function applyI18nToDocument() {
        document.title = t('page.title');
        document.querySelectorAll('[data-i18n]').forEach((el) => {
            el.textContent = t(el.dataset.i18n);
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
            el.placeholder = t(el.dataset.i18nPlaceholder);
        });
        document.querySelectorAll('[data-i18n-title]').forEach((el) => {
            el.title = t(el.dataset.i18nTitle);
        });
        document.querySelectorAll('[data-i18n-html]').forEach((el) => {
            el.innerHTML = t(el.dataset.i18nHtml);
        });
        document.querySelectorAll('option[data-i18n]').forEach((el) => {
            el.textContent = t(el.dataset.i18n);
        });
        const toggle = document.getElementById('languageToggle');
        if (toggle) {
            toggle.checked = locale === 'en';
            toggle.setAttribute('aria-checked', locale === 'en' ? 'true' : 'false');
        }
        document.querySelectorAll('[data-lang-label]').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.langLabel === locale);
        });
    }

    function initLanguageSwitch() {
        const toggle = document.getElementById('languageToggle');
        if (!toggle || toggle.dataset.bound === '1') {
            applyI18nToDocument();
            return;
        }
        toggle.dataset.bound = '1';
        toggle.checked = locale === 'en';
        toggle.addEventListener('change', () => {
            setLocale(toggle.checked ? 'en' : 'ru');
        });
        applyI18nToDocument();
    }

    /**
     * Склонение для длительности (часы / минуты)
     */
    function pluralizeDuration(value, unit) {
        const n = Math.abs(Math.floor(Number(value) || 0));
        if (locale === 'en') {
            const label = n === 1 ? t(`duration.${unit}`) : t(`duration.${unit}sFew`);
            return `${n} ${label}`;
        }
        const mod10 = n % 10;
        const mod100 = n % 100;
        let key;
        if (mod10 === 1 && mod100 !== 11) {
            key = `duration.${unit}`;
        } else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
            key = `duration.${unit}sFew`;
        } else {
            key = `duration.${unit}sMany`;
        }
        return `${n} ${t(key)}`;
    }

    locale = readStoredLocale();
    document.documentElement.lang = locale;

    global.t = t;
    global.getLocale = getLocale;
    global.setLocale = setLocale;
    global.onLocaleChange = onLocaleChange;
    global.applyI18nToDocument = applyI18nToDocument;
    global.initLanguageSwitch = initLanguageSwitch;
    global.pluralizeDuration = pluralizeDuration;
})(window);
