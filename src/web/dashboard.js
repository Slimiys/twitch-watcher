const API_BASE = '/api';
let updateInterval = null;

/**
 * Безопасное получение значения из localStorage
 * @param {string} key Ключ
 * @param {any} defaultValue Значение по умолчанию
 * @returns {any} Значение из localStorage или значение по умолчанию
 */
function safeGetLocalStorage(key, defaultValue = null) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        // Tracking Prevention или другие ограничения браузера
        return defaultValue;
    }
}

/**
 * Безопасная установка значения в localStorage
 * @param {string} key Ключ
 * @param {string} value Значение
 */
function safeSetLocalStorage(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        // Tracking Prevention или другие ограничения браузера - игнорируем
    }
}

// Загружаем состояние из localStorage или используем значения по умолчанию
let showOffline = safeGetLocalStorage('showOffline') !== 'false'; // По умолчанию показываем всех стримеров
let updateIntervalMs = parseInt(safeGetLocalStorage('updateIntervalMs')) || 5000; // Интервал обновления в миллисекундах
let updateMode = safeGetLocalStorage('updateMode') || 'interval'; // 'interval' или 'event'
let eventSource = null; // Server-Sent Events — push с сервера
let lastEventCheckTimestamp = 0; // Timestamp последнего проверенного события
/** Таймер отложенного refresh по SSE */
let dashboardRefreshDebounceTimer = null;
/** Fallback-опрос, когда вкладка в фоне и setInterval троттлится */
let hiddenTabFallbackTimer = null;
const DASHBOARD_SSE_DEBOUNCE_MS = 400;
const HIDDEN_TAB_FALLBACK_POLL_MS = 15_000;
const EVENT_MODE_POLL_VISIBLE_MS = 2000;
const EVENT_MODE_POLL_HIDDEN_MS = 15_000;
/** Полное обновление UI после инициализации уже выполнено */
let applicationDataRefreshStarted = false;
let colorizeStreamerNames = safeGetLocalStorage('colorizeStreamerNames') === 'true'; // Цветовая кодировка имен стримеров
/** Автоустановка при обнаружении обновления (без подтверждения и toast) */
let dashboardAutoUpdateEnabled = safeGetLocalStorage('dashboardAutoUpdateEnabled') === 'true';
/** Уже запущено автообновление на эту remote-ревизию (не дублировать) */
let autoUpdateTriggeredForRevision = null;
/** dashboardUpdateEnabled с последнего server-info */
let dashboardUpdateFeatureEnabled = false;
/** PID процесса бота для таймера uptime */
let botUptimePid = null;
/** Время старта процесса бота (мс), сбрасывается при смене pid */
let botUptimeStartedAt = null;
let botUptimeTickTimer = null;
const BOT_UPTIME_SYNC_MS = 30_000;
let botUptimeSyncTimer = null;

// Настройки видимых колонок таблицы стримеров
let visibleColumns = {};
try {
    const columns = safeGetLocalStorage('visibleColumns') || '{"notify": true, "streamer": true, "status": true, "watchTime": true, "pointsEarned": true, "currentPoints": true, "game": true, "streamsLast30Days": true, "viewersCount": true, "lastStreamStart": true, "lastStreamEnd": true, "lastStreamDuration": true, "actions": true}';
    visibleColumns = JSON.parse(columns);
    if (visibleColumns.lastStreamDuration === undefined) {
        visibleColumns.lastStreamDuration = true;
    }
} catch (e) {
    visibleColumns = {notify: true, streamer: true, status: true, watchTime: true, pointsEarned: true, currentPoints: true, game: true, lastStreamStart: true, lastStreamEnd: true, lastStreamDuration: true, actions: true};
}

/** Допустимые периоды для колонки Streams (сутки) */
const STREAMS_COUNT_WINDOW_OPTIONS = [7, 14, 30, 60];
let streamsCountWindowDays = 30;
try {
    const savedStreamsWindow = Number(safeGetLocalStorage('streamsCountWindowDays'));
    if (STREAMS_COUNT_WINDOW_OPTIONS.includes(savedStreamsWindow)) {
        streamsCountWindowDays = savedStreamsWindow;
    }
} catch (e) {
    streamsCountWindowDays = 30;
}

/**
 * Количество стримов стримера за выбранный период
 * @param {object} stat Строка статистики из API
 * @returns {number}
 */
function getStreamerStreamCount(stat) {
    if (!stat) {
        return 0;
    }
    const counts = stat.streamCounts;
    if (counts && counts[streamsCountWindowDays] != null) {
        return Number(counts[streamsCountWindowDays]) || 0;
    }
    if (streamsCountWindowDays === 30 && stat.streamsLast30Days != null) {
        return Number(stat.streamsLast30Days) || 0;
    }
    return 0;
}

/**
 * Даты начала стримов стримера за выбранный период
 * @param {object} stat
 * @returns {number[]}
 */
function getStreamerStreamSessionStarts(stat) {
    if (!stat?.streamSessionStarts) {
        return [];
    }
    const dates = stat.streamSessionStarts[streamsCountWindowDays];
    return Array.isArray(dates) ? dates : [];
}

/**
 * Подпись колонки Streams с текущим периодом
 * @returns {string}
 */
function getStreamsCountColumnLabel() {
    return `Streams (${streamsCountWindowDays}d)`;
}

/**
 * Форматирует число зрителей для таблицы
 * @param {number|null|undefined} count
 * @returns {string}
 */
function formatViewerCount(count) {
    if (count == null || Number.isNaN(Number(count))) {
        return '-';
    }
    return Number(count).toLocaleString('ru-RU');
}

/**
 * Форматирует число зрителей с разницей к прошлому обновлению
 * @param {number|null|undefined} count
 * @param {number|null|undefined} previousCount
 * @returns {string}
 */
function formatViewerCountWithDiff(count, previousCount) {
    if (count == null || Number.isNaN(Number(count))) {
        return '-';
    }

    const current = Number(count);
    const formatted = current.toLocaleString('ru-RU');

    if (previousCount == null || Number.isNaN(Number(previousCount))) {
        return formatted;
    }

    const previous = Number(previousCount);
    if (previous === current) {
        return formatted;
    }

    const diff = current - previous;
    const diffFormatted =
        diff > 0 ? `+${diff.toLocaleString('ru-RU')}` : diff.toLocaleString('ru-RU');
    const diffClass = diff > 0 ? 'diff-positive' : 'diff-negative';
    return `${formatted} <span class="points-diff ${diffClass}">(${diffFormatted})</span>`;
}

/**
 * Закрывает меню выбора периода для колонки Streams
 */
function hideStreamsCountWindowMenu() {
    const menu = document.getElementById('streamsCountWindowMenu');
    if (menu) {
        menu.remove();
    }
}

/**
 * Показывает меню выбора периода Streams у курсора
 * @param {number} clientX
 * @param {number} clientY
 */
function showStreamsCountWindowMenu(clientX, clientY) {
    hideStreamsCountWindowMenu();

    const menu = document.createElement('div');
    menu.id = 'streamsCountWindowMenu';
    menu.className = 'streams-window-menu show';
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    STREAMS_COUNT_WINDOW_OPTIONS.forEach((days) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'streams-window-menu-item' + (days === streamsCountWindowDays ? ' active' : '');
        item.textContent = days === streamsCountWindowDays ? `${days}d ✓` : `${days}d`;
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            setStreamsCountWindowDays(days);
        });
        menu.appendChild(item);
    });

    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
    }
}

/**
 * Устанавливает период подсчёта стримов для колонки
 * @param {number} days
 */
function setStreamsCountWindowDays(days) {
    if (!STREAMS_COUNT_WINDOW_OPTIONS.includes(days)) {
        return;
    }
    streamsCountWindowDays = days;
    safeSetLocalStorage('streamsCountWindowDays', String(days));
    hideStreamsCountWindowMenu();
    updateStatistics({ skipFetch: true });
}

/** Открытое меню статистики категорий (имя стримера) */
let openCategoryStreamStatsStreamer = null;
/** Открытое меню дат стримов (имя стримера) */
let openStreamSessionsMenuStreamer = null;

/**
 * Закрывает меню статистики категорий стримера
 */
function hideCategoryStreamStatsMenu() {
    const menu = document.getElementById('categoryStreamStatsMenu');
    if (menu) {
        menu.remove();
    }
    openCategoryStreamStatsStreamer = null;
}

/**
 * Закрывает меню списка дат стримов
 */
function hideStreamSessionsMenu() {
    const menu = document.getElementById('streamSessionsMenu');
    if (menu) {
        menu.remove();
    }
    openStreamSessionsMenuStreamer = null;
}

/**
 * Строит HTML списка дат начала стримов
 * @param {number[]} startedAtList
 * @returns {string}
 */
function buildStreamSessionsMenuItems(startedAtList) {
    if (!Array.isArray(startedAtList) || startedAtList.length === 0) {
        return '<div class="stream-sessions-empty">Нет стримов за выбранный период</div>';
    }

    return startedAtList.map((startedAt) => {
        const label = formatTimeHHMM(startedAt);
        return `<div class="stream-sessions-item">${escapeHtml(label)}</div>`;
    }).join('');
}

/**
 * Открывает или закрывает меню дат стримов под ячейкой Streams
 * @param {string} streamerName
 * @param {HTMLElement} anchorEl
 */
function toggleStreamSessionsMenu(streamerName, anchorEl) {
    if (openStreamSessionsMenuStreamer === streamerName) {
        hideStreamSessionsMenu();
        return;
    }

    hideStreamSessionsMenu();
    hideCategoryStreamStatsMenu();
    hideStreamsCountWindowMenu();

    const stat = (cachedStatisticsRows || []).find((row) => row.streamerName === streamerName);
    const dates = getStreamerStreamSessionStarts(stat);
    const itemsHtml = buildStreamSessionsMenuItems(dates);

    const menu = document.createElement('div');
    menu.id = 'streamSessionsMenu';
    menu.className = 'stream-sessions-menu show';
    menu.innerHTML = `
        <div class="stream-sessions-title">Стримы (${streamsCountWindowDays}d)</div>
        ${itemsHtml}
    `;

    document.body.appendChild(menu);

    const anchorRect = anchorEl.getBoundingClientRect();
    let left = anchorRect.left;
    let top = anchorRect.bottom + 4;

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        left = Math.max(8, window.innerWidth - rect.width - 8);
        menu.style.left = `${left}px`;
    }
    if (rect.bottom > window.innerHeight) {
        top = Math.max(8, anchorRect.top - rect.height - 4);
        menu.style.top = `${top}px`;
    }

    openStreamSessionsMenuStreamer = streamerName;
}

/**
 * Рендерит ячейку количества стримов
 * @param {object} stat
 * @returns {string}
 */
function renderStreamerStreamsCell(stat) {
    const count = getStreamerStreamCount(stat);
    const safeAttr = String(stat.streamerName)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
    const dates = getStreamerStreamSessionStarts(stat);
    const title = dates.length > 0
        ? 'Показать даты начала стримов'
        : 'Даты появятся после учёта стримов';

    return `<td class="stream-sessions-cell">
        <button type="button" class="stream-sessions-button" data-streamer="${safeAttr}" title="${title}">${count}</button>
    </td>`;
}

/**
 * Строит HTML пунктов меню категорий
 * @param {Array<{category:string, streamCount:number}>} categoryStreamCounts
 * @param {string|null|undefined} currentCategory Текущая категория стримера
 * @param {boolean} highlightCurrent Подсветить текущую категорию (только для ONLINE)
 * @returns {string}
 */
function buildCategoryStreamStatsMenuItems(
    categoryStreamCounts,
    currentCategory,
    highlightCurrent
) {
    if (!Array.isArray(categoryStreamCounts) || categoryStreamCounts.length === 0) {
        return '<div class="category-stream-stats-empty">Пока нет данных по категориям</div>';
    }

    const normalizedCurrent =
        highlightCurrent && currentCategory?.trim()
            ? currentCategory.trim().toLowerCase()
            : null;

    return categoryStreamCounts
        .map((entry) => {
            const category = entry.category || '—';
            const categoryEscaped = escapeHtml(category);
            const count = Number(entry.streamCount) || 0;
            const isCurrent =
                normalizedCurrent != null &&
                category.trim().toLowerCase() === normalizedCurrent;
            const nameClass = isCurrent
                ? 'category-stream-stats-name current'
                : 'category-stream-stats-name';
            return `<div class="category-stream-stats-item"><span class="${nameClass}">${categoryEscaped}</span><span class="category-stream-stats-count">${count}</span></div>`;
        })
        .join('');
}

/**
 * Открывает или закрывает меню статистики категорий под ячейкой
 * @param {string} streamerName
 * @param {HTMLElement} anchorEl
 */
function toggleCategoryStreamStatsMenu(streamerName, anchorEl) {
    if (openCategoryStreamStatsStreamer === streamerName) {
        hideCategoryStreamStatsMenu();
        return;
    }

    hideCategoryStreamStatsMenu();
    hideStreamsCountWindowMenu();
    hideStreamSessionsMenu();

    const stat = (cachedStatisticsRows || []).find((row) => row.streamerName === streamerName);
    const itemsHtml = buildCategoryStreamStatsMenuItems(
        stat?.categoryStreamCounts,
        stat?.game,
        stat?.status === 'ONLINE'
    );

    const menu = document.createElement('div');
    menu.id = 'categoryStreamStatsMenu';
    menu.className = 'category-stream-stats-menu show';
    menu.innerHTML = `
        <div class="category-stream-stats-title">Стримы по категориям</div>
        ${itemsHtml}
    `;

    document.body.appendChild(menu);

    const anchorRect = anchorEl.getBoundingClientRect();
    let left = anchorRect.left;
    let top = anchorRect.bottom + 4;

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        left = Math.max(8, window.innerWidth - rect.width - 8);
        menu.style.left = `${left}px`;
    }
    if (rect.bottom > window.innerHeight) {
        top = Math.max(8, anchorRect.top - rect.height - 4);
        menu.style.top = `${top}px`;
    }

    openCategoryStreamStatsStreamer = streamerName;
}

/**
 * Рендерит ячейку текущей категории стримера
 * @param {object} stat
 * @returns {string}
 */
function renderStreamerCategoryCell(stat) {
    const game = stat?.game?.trim();
    if (!game) {
        return '<td>-</td>';
    }

    const safeAttr = String(stat.streamerName)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
    const hasStats = Array.isArray(stat.categoryStreamCounts) && stat.categoryStreamCounts.length > 0;
    const title = hasStats
        ? 'Показать статистику по категориям'
        : 'Статистика появится после смены категорий в стримах';

    return `<td class="streamer-category-cell">
        <button type="button" class="streamer-category-button" data-streamer="${safeAttr}" title="${title}">${escapeHtml(game)}</button>
    </td>`;
}

/**
 * Инициализирует клик по категории стримера
 */
function initCategoryStreamStatsMenu() {
    const tableHost = document.getElementById('watchesTable');
    if (!tableHost || tableHost.dataset.categoryStatsMenuBound === '1') {
        return;
    }
    tableHost.dataset.categoryStatsMenuBound = '1';

    tableHost.addEventListener('click', (e) => {
        const button = e.target.closest('.streamer-category-button');
        if (!button) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const streamerName = button.getAttribute('data-streamer');
        if (!streamerName) {
            return;
        }
        toggleCategoryStreamStatsMenu(streamerName, button);
    });
}

/**
 * Инициализирует клик по количеству стримов
 */
function initStreamSessionsMenu() {
    const tableHost = document.getElementById('watchesTable');
    if (!tableHost || tableHost.dataset.streamSessionsMenuBound === '1') {
        return;
    }
    tableHost.dataset.streamSessionsMenuBound = '1';

    tableHost.addEventListener('click', (e) => {
        const button = e.target.closest('.stream-sessions-button');
        if (!button) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const streamerName = button.getAttribute('data-streamer');
        if (!streamerName) {
            return;
        }
        toggleStreamSessionsMenu(streamerName, button);
    });
}

/**
 * Инициализирует контекстное меню периода колонки Streams
 */
function initStreamsCountWindowMenu() {
    const tableHost = document.getElementById('watchesTable');
    if (!tableHost || tableHost.dataset.streamsWindowMenuBound === '1') {
        return;
    }
    tableHost.dataset.streamsWindowMenuBound = '1';

    tableHost.addEventListener('contextmenu', (e) => {
        const header = e.target.closest('th.streams-count-header');
        if (!header) {
            return;
        }
        e.preventDefault();
        showStreamsCountWindowMenu(e.clientX, e.clientY);
    });
}

// Предыдущий статус стримеров (для уведомлений online/offline)
let previousStreamerStatus = {};
let streamStatusTrackingReady = false;

// Уведомления по стримерам: true = включено (по умолчанию)
let streamerNotifyPrefs = {};
/** Имена всех стримеров из последнего ответа /statistics (для массового переключения уведомлений) */
let lastAllStreamerNames = [];
try {
    const prefs = safeGetLocalStorage('streamerNotifyPrefs');
    if (prefs) {
        streamerNotifyPrefs = JSON.parse(prefs);
    }
} catch (e) {
    streamerNotifyPrefs = {};
}

// Настройки сортировки таблицы
let tableSort = {
    column: null, // 'streamer', 'lastStreamStart', 'lastStreamEnd'
    direction: 'asc' // 'asc' или 'desc'
};
try {
    const sort = safeGetLocalStorage('tableSort');
    if (sort) {
        tableSort = JSON.parse(sort);
    }
} catch (e) {
    // Используем значения по умолчанию
}

/** Снимок баллов на прошлом обновлении таблицы (разница в скобках — только между обновлениями) */
let lastUpdatePointsSnapshot = {};
/** Последний ответ /api/statistics для мгновенного переключения Show/Hide Offline */
let cachedStatisticsRows = null;

/**
 * Last Activity: последний стример, перешедший в онлайн, и сколько времени назад
 * @param {{ lastActivity?: number, lastOnlineStreamer?: string|null }} stats
 */
function formatOverallLastActivity(stats) {
    const streamer = stats?.lastOnlineStreamer;
    const ms = stats?.lastActivity;
    if (!streamer || !Number.isFinite(ms) || ms <= 0) {
        return '—';
    }
    return `${streamer} · ${formatTime(ms)} ago`;
}

function formatTime(ms) {
    // Безопасно обрабатываем некорректные значения
    if (!Number.isFinite(ms) || ms < 0) return '-';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

/**
 * Длительность последнего завершённого стрима (мс) из API или start/end
 * @param {object} stat Строка статистики стримера
 * @returns {number|null}
 */
function resolveLastStreamDurationMs(stat) {
    const stored = Number(stat?.lastStreamDurationMs);
    if (Number.isFinite(stored) && stored > 0) {
        return stored;
    }
    const start = Number(stat?.lastStreamStart);
    const end = Number(stat?.lastStreamEnd);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start && start > 0) {
        return end - start;
    }
    return null;
}

/**
 * Генерирует прогресс-бар для времени просмотра
 * @param {number} elapsedTime Время просмотра в миллисекундах
 * @param {number} maxTime Максимальное время для расчета процента (по умолчанию 24 часа)
 * @returns {string} HTML код прогресс-бара
 */
function generateWatchTimeProgress(elapsedTime, maxTime = 24 * 60 * 60 * 1000) {
    // Защита от NaN/undefined и некорректного maxTime
    const safeElapsed = Number.isFinite(elapsedTime) ? Math.max(0, elapsedTime) : 0;
    const safeMax = Number.isFinite(maxTime) && maxTime > 0 ? maxTime : 24 * 60 * 60 * 1000;
    
    const percentage = Math.min((safeElapsed / safeMax) * 100, 100);
    // Меняем цвет, как только бар добрался до лимита (>=100%), а не только после переполнения
    const isBeyondMax = percentage >= 100;
    const timeText = formatTime(safeElapsed);
    
    return `
        <div class="watch-time-progress">
            <div class="watch-time-bar-container">
                <div class="watch-time-bar${isBeyondMax ? ' gold' : ''}" style="width: ${percentage}%"></div>
            </div>
            <span class="progress-bar-text">${timeText}</span>
        </div>
    `;
}

/**
 * Определяет категорию баллов и возвращает соответствующий класс
 * @param {number} points Количество баллов
 * @returns {string} Класс для стилизации
 */
function getPointsCategory(points) {
    if (points >= 100001) return 'tier-4'; // 100001 - 1000000
    if (points >= 10001) return 'tier-3';  // 10001 - 100000
    if (points >= 1001) return 'tier-2';    // 1001 - 10000
    return 'tier-1';                        // 0 - 1000
}

/**
 * Генерирует цвет на основе строки (детерминированно)
 * @param {string} str Строка для генерации цвета
 * @returns {string} HSL-цвет
 */
function generateColorFromString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    hash = Math.abs(hash);

    // Золотое сечение — равномернее по всей палитре, чем hash % 360
    const goldenRatioConjugate = 0.618033988749895;
    const hue = Math.round(((hash * goldenRatioConjugate) % 1) * 360);
    const saturation = 52 + (hash % 28); // 52–79%
    const lightness = 56 + ((hash >> 6) % 14); // 56–69%

    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * Генерирует бейдж с цветовым кодированием для баллов
 * @param {number} points Количество баллов
 * @returns {string} HTML код бейджа
 */
function generatePointsBadge(points) {
    const category = getPointsCategory(points);
    return `<span class="points-badge ${category}">${points.toLocaleString()}</span>`;
}

/**
 * Генерирует бейдж с баллами и разницей между текущим и предыдущим значением
 * @param {number} currentPoints Текущее значение
 * @param {number|null|undefined} previousPoints Предыдущее значение (до изменения)
 * @returns {string} HTML с бейджем и разницей
 */
function generatePointsBadgeWithDiff(currentPoints, previousPoints) {
    const category = getPointsCategory(currentPoints);
    const currentFormatted = currentPoints.toLocaleString();
    
    let diffHtml = '';
    if (previousPoints !== null && previousPoints !== undefined && previousPoints !== currentPoints) {
        const diff = currentPoints - previousPoints;
        const diffFormatted = diff > 0 ? `+${diff.toLocaleString()}` : diff.toLocaleString();
        const diffClass = diff > 0 ? 'diff-positive' : 'diff-negative';
        diffHtml = ` <span class="points-diff ${diffClass}">(${diffFormatted})</span>`;
    }
    
    return `<span class="points-badge ${category}">${currentFormatted}</span>${diffHtml}`;
}

function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
}

/**
 * Форматирует timestamp в читаемую дату и время
 * @param {number} timestamp Timestamp в миллисекундах
 * @returns {string} Отформатированная дата и время
 */
function formatDateTime(timestamp) {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    // Если меньше минуты назад
    if (diff < 60000) {
        return 'Just now';
    }
    // Если меньше часа назад
    if (diff < 3600000) {
        const minutes = Math.floor(diff / 60000);
        return `${minutes}m ago`;
    }
    // Если сегодня
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
    // Если вчера
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
        return `Yesterday ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    }
    // Если меньше недели назад
    if (diff < 7 * 24 * 3600000) {
        return date.toLocaleDateString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    }
    // Иначе полная дата и время
    return date.toLocaleString('en-US', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit' 
    });
}

/**
 * Форматирует timestamp в формат даты и времени dd:MM:yyyy HH:mm
 * @param {number} timestamp Timestamp в миллисекундах
 * @returns {string} Дата и время в формате dd:MM:yyyy HH:mm или '-'
 */
function formatTimeHHMM(timestamp) {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${day}.${month}.${year} ${hours}:${minutes}`;
}

/**
 * Форматирует дату и время с разделением по цветам
 * @param {number} timestamp Timestamp
 * @param {string} timeColor Цвет для времени (CSS цвет)
 * @returns {string} HTML с датой (белой) и временем (цветным)
 */
function formatTimeWithColors(timestamp, timeColor) {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `<span style="color: #efeff1;">${day}.${month}.${year}</span> <span style="color: ${timeColor};">${hours}:${minutes}</span>`;
}

/**
 * Форматирует ISO 8601 дату в читаемый формат
 * @param {string|null} isoDate ISO 8601 дата или null
 * @returns {string} Отформатированная дата и время или '-'
 */

/**
 * Генерирует skeleton loader для карточек статистики
 * @returns {string} HTML код skeleton loader
 */
function generateStatsSkeleton() {
    return Array.from({ length: 4 })
        .map(
            () => `
                <div class="skeleton-stat-card">
                    <div class="skeleton skeleton-stat-title"></div>
                    <div class="skeleton skeleton-stat-value"></div>
                    <div class="skeleton skeleton-stat-label"></div>
                </div>
            `
        )
        .join('');
}

/**
 * Генерирует skeleton loader для таблицы стримеров
 * @param {number} rows Количество строк
 * @returns {string} HTML код skeleton loader
 */
function generateTableSkeleton(rows = 5) {
    return `
        <div class="skeleton-table">
            <div class="skeleton-table-header">
                ${Array.from({ length: 6 }).map(() => `
                    <div class="skeleton skeleton-table-header-cell"></div>
                `).join('')}
            </div>
            ${Array.from({ length: rows }).map(() => `
                <div class="skeleton-table-row">
                    ${Array.from({ length: 6 }).map(() => `
                        <div class="skeleton skeleton-table-cell"></div>
                    `).join('')}
                </div>
            `).join('')}
        </div>
    `;
}

/**
 * Плавно заменяет skeleton loader на реальный контент
 * @param {HTMLElement} container Контейнер с skeleton
 * @param {string} newContent Новый контент
 */
function replaceSkeletonWithContent(container, newContent) {
    if (!container) return;
    
    // Добавляем класс для анимации исчезновения
    container.classList.add('skeleton-fade-out');
    
    setTimeout(() => {
        // Заменяем содержимое
        container.innerHTML = newContent;
        // Добавляем класс для анимации появления
        container.classList.remove('skeleton-fade-out');
        container.classList.add('content-fade-in');
        
        // Убираем класс после завершения анимации
        setTimeout(() => {
            container.classList.remove('content-fade-in');
        }, 400);
    }, 300);
}

/**
 * Генерирует детерминированный цвет на основе текста
 * @param {string} text Текст для генерации цвета
 * @returns {string} Цвет в формате HSL для использования в CSS
 */
function generateColorFromText(text) {
    // Простая хеш-функция для преобразования текста в число
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Преобразуем в 32-битное число
    }
    
    // Используем абсолютное значение хеша
    hash = Math.abs(hash);
    
    // Генерируем HSL значения
    // Hue: 0-360 (полный спектр цветов)
    const hue = hash % 360;
    
    // Saturation: 50-80% (достаточно насыщенные, но не слишком яркие)
    const saturation = 50 + (hash % 30);
    
    // Lightness: 35-50% (темные, но читаемые цвета)
    const lightness = 35 + (hash % 15);
    
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * API-ключ dashboard (localStorage, не входит в экспорт appSettings)
 */
function getDashboardApiKey() {
    return safeGetLocalStorage('dashboardApiKey') || '';
}

function setDashboardApiKey(key) {
    safeSetLocalStorage('dashboardApiKey', key || '');
}

async function fetchData(endpoint) {
    try {
        const headers = {};
        const apiKey = getDashboardApiKey();
        if (apiKey) {
            headers['X-API-Key'] = apiKey;
        }

        const response = await fetch(`${API_BASE}${endpoint}`, { headers });
        if (!response.ok) {
            if (response.status === 401) {
                console.warn(`Unauthorized for ${endpoint}: проверьте API-ключ в настройках`);
            }
            // Если сервис недоступен (503), пытаемся получить сообщение об ошибке
            if (response.status === 503) {
                try {
                    const errorData = await response.json();
                    console.warn(`Service unavailable for ${endpoint}:`, errorData.error || errorData.message);
                } catch (e) {
                    // Игнорируем ошибки парсинга JSON
                }
            }
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Error fetching ${endpoint}:`, error);
        return null;
    }
}

/**
 * POST к API dashboard (с API-ключом)
 */
async function postApi(endpoint, body = {}) {
    try {
        const headers = { 'Content-Type': 'application/json' };
        const apiKey = getDashboardApiKey();
        if (apiKey) {
            headers['X-API-Key'] = apiKey;
        }

        const response = await fetch(`${API_BASE}${endpoint}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const msg = data.message || data.error || `HTTP ${response.status}`;
            return { ok: false, message: msg, data };
        }
        return { ok: true, message: data.message || 'OK', data };
    } catch (error) {
        console.error(`Error POST ${endpoint}:`, error);
        return { ok: false, message: error.message || String(error) };
    }
}

/** Опрос обновлений и карточка «Версия» */
const VERSION_UPDATE_POLL_MS = 60_000;
/** Опрос после stop/restart/update (Termux: npm install может занять несколько минут) */
const RECONNECT_POLL_MS = 3_000;
const RECONNECT_MAX_ATTEMPTS = 200;
let versionUpdatePollTimer = null;
let versionUpdateFastPollTimer = null;
let versionUpdateStatus = null;
let lastBotHealthForVersion = null;
let versionCardBusy = false;
/** После reload по завершении update/restart — принудительно обновить карточку «Версия» */
let forceVersionRefreshOnReady = false;
/** Режим ожидания перезапуска: update | restart */
let lifecycleWaitMode = null;
/** PID бота до update/restart (новый процесс = другой pid) */
let lifecycleWaitPreviousPid = null;
/** Время начала ожидания lifecycle (для сброса зависшего «Обновление…») */
let lifecycleWaitStartedAt = 0;
/** Если скрипт завершился, а PID бота не сменился — сброс UI через это время */
const LIFECYCLE_SAME_PID_ABORT_MS = 45_000;
/** Сервер дашборда был недоступен во время update/restart (бот перезапускался) */
let lifecycleServerWasDown = false;

/**
 * Форматирует длительность работы бота
 */
function formatBotUptimeDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    const parts = [];
    if (days > 0) {
        parts.push(`${days}д`);
    }
    if (hours > 0 || days > 0) {
        parts.push(`${hours}ч`);
    }
    if (minutes > 0 || hours > 0 || days > 0) {
        parts.push(`${minutes}м`);
    }
    parts.push(`${seconds}с`);
    return parts.join(' ');
}

/**
 * Обновляет подпись таймера в заголовке
 */
function renderBotUptimeLabel() {
    const el = document.getElementById('botUptimeDisplay');
    if (!el) {
        return;
    }
    if (lifecycleWaitMode || botUptimeStartedAt == null) {
        el.textContent = '';
        return;
    }
    el.textContent = `Время после запуска: ${formatBotUptimeDuration(Date.now() - botUptimeStartedAt)}`;
}

/**
 * Синхронизирует таймер с /api/server-info (новый pid → сброс)
 */
function applyBotUptimeFromServerInfo(info) {
    if (!info || info.processStartedAt == null || !Number.isFinite(info.processStartedAt)) {
        return;
    }
    const pid = info.pid ?? null;
    if (pid != null && botUptimePid !== pid) {
        botUptimePid = pid;
        botUptimeStartedAt = info.processStartedAt;
    } else if (botUptimeStartedAt == null) {
        botUptimePid = pid;
        botUptimeStartedAt = info.processStartedAt;
    }
    renderBotUptimeLabel();
}

async function refreshBotUptimeFromServer() {
    const info = await fetchData('/server-info');
    if (info) {
        applyBotUptimeFromServerInfo(info);
    }
}

function startBotUptimeClock() {
    if (botUptimeTickTimer) {
        return;
    }
    botUptimeTickTimer = setInterval(renderBotUptimeLabel, 1000);
    if (!botUptimeSyncTimer) {
        botUptimeSyncTimer = setInterval(() => {
            void refreshBotUptimeFromServer();
        }, BOT_UPTIME_SYNC_MS);
    }
    void refreshBotUptimeFromServer();
}

/**
 * Кнопка «Обновиться» в шапке скрыта — обновление через карточку «Версия»
 */
async function initAppUpdateButton() {
    const btn = document.getElementById('appUpdateBtn');
    if (btn) {
        btn.style.display = 'none';
    }
}

/**
 * Кнопки «Остановить» и «Перезапустить» (Termux, DASHBOARD_UPDATE_ENABLED)
 */
async function initProcessControlButtons() {
    const stopBtn = document.getElementById('appStopBtn');
    const restartBtn = document.getElementById('appRestartBtn');
    if (!stopBtn && !restartBtn) {
        return;
    }

    const info = await fetchData('/server-info');
    const enabled = info?.dashboardUpdateEnabled === true;
    dashboardUpdateFeatureEnabled = enabled;
    const inProgress = info?.dashboardUpdateInProgress === true;
    const blocked = info?.dashboardUpdateBlockedReason;
    syncAutoUpdateToggleUi({ enabled, inProgress });
    applyBotUptimeFromServerInfo(info);

    if (stopBtn) {
        stopBtn.style.display = enabled ? '' : 'none';
        stopBtn.disabled = inProgress;
        stopBtn.title = blocked || 'Остановить бота (завершить процесс)';
        if (!stopBtn.dataset.bound) {
            stopBtn.dataset.bound = '1';
            stopBtn.addEventListener('click', () => {
                if (stopBtn.disabled) {
                    return;
                }
                showConfirmModal(
                    'Остановить бота?',
                    'Процесс twitch-watcher будет завершён. Дашборд отключится. Продолжить?',
                    () => triggerDashboardStop()
                );
            });
        }
    }

    if (restartBtn) {
        restartBtn.style.display = enabled ? '' : 'none';
        restartBtn.disabled = inProgress;
        restartBtn.title = blocked || 'Перезапуск: stop + npm start (как после обновления)';
        if (!restartBtn.dataset.bound) {
            restartBtn.dataset.bound = '1';
            restartBtn.addEventListener('click', () => {
                if (restartBtn.disabled) {
                    return;
                }
                showConfirmModal(
                    'Перезапустить бота?',
                    'Будет выполнено: остановка процесса → npm start в фоне. ' +
                        'Дашборд отключится на 1–2 минуты. Продолжить?',
                    () => triggerDashboardRestart()
                );
            });
        }
    }
}

async function triggerDashboardStop() {
    if (typeof showNotification === 'function') {
        showNotification('info', 'Остановка…');
    }
    const result = await postApi('/app-stop', {});
    if (result.ok) {
        if (typeof showNotification === 'function') {
            showNotification('success', result.message);
        }
        updateConnectionStatus(false);
        const statusText = document.getElementById('statusText');
        if (statusText) {
            statusText.textContent = 'Остановка…';
        }
    } else if (typeof showNotification === 'function') {
        showNotification('error', result.message || 'Не удалось остановить');
    }
}

async function captureLifecycleWaitPid() {
    const info = await fetchServerInfoForReconnect();
    lifecycleWaitPreviousPid = info?.pid ?? null;
}

async function triggerDashboardRestart() {
    if (typeof showNotification === 'function') {
        showNotification('info', 'Перезапуск…');
    }
    await captureLifecycleWaitPid();
    const result = await postApi('/app-restart', {});
    if (result.ok) {
        if (typeof showNotification === 'function') {
            showNotification('success', result.message);
        }
        beginLifecycleWaitUi('restart');
        startDashboardReconnectWatch('Перезапуск завершён. Перезагрузка страницы…', 'restart');
    } else {
        resetDashboardLifecycleUi('Disconnected');
        if (typeof showNotification === 'function') {
            showNotification('error', result.message || 'Не удалось перезапустить');
        }
    }
}

/**
 * Локальный UI «идёт перезапуск/обновление» до ответа нового процесса
 */
function shouldAbortStaleLifecycleWait(data) {
    if (!lifecycleWaitMode || !data) {
        return false;
    }
    if (data.dashboardUpdateInProgress || data.uiState === 'updating') {
        return false;
    }
    if (hasNewBotPidAfterLifecycle(data.serverPid)) {
        return false;
    }
    if (!lifecycleWaitStartedAt) {
        return false;
    }
    return Date.now() - lifecycleWaitStartedAt >= LIFECYCLE_SAME_PID_ABORT_MS;
}

/**
 * Сброс UI, если обновление на сервере завершилось, но бот не перезапустился (типично: ошибка kill в логе)
 */
function recoverStaleLifecycleIfNeeded(data) {
    if (!shouldAbortStaleLifecycleWait(data)) {
        return false;
    }
    resetDashboardLifecycleUi('Обновление прервано — обновите страницу (F5)');
    if (typeof showNotification === 'function') {
        showNotification(
            'warn',
            'Скрипт обновления завершился, но бот не перезапустился. См. logs/dashboard-update.log'
        );
    }
    void pollVersionUpdateStatus(true);
    return true;
}

function beginLifecycleWaitUi(mode) {
    lifecycleWaitMode = mode;
    lifecycleWaitStartedAt = Date.now();
    lifecycleServerWasDown = false;
    versionCardBusy = true;
    botUptimePid = null;
    botUptimeStartedAt = null;
    renderBotUptimeLabel();
    syncAutoUpdateToggleUi({ inProgress: true });
    const label = mode === 'update' ? 'Обновление' : 'Перезапуск';
    versionUpdateStatus = {
        ...(versionUpdateStatus || {}),
        uiState: 'updating',
        indicatorLabel: `${label}…`,
        dashboardUpdateInProgress: true,
    };
    if (lastBotHealthForVersion) {
        patchBotHealthVersionCard(lastBotHealthForVersion);
    }
    updateConnectionStatus(false);
    setLifecycleHeaderText(`${label}…`);
}

/**
 * Опрос статуса обновления (ветка dev на origin)
 */
async function pollVersionUpdateStatus(forceRefresh = false) {
    if (!forceRefresh && !lifecycleWaitMode) {
        versionUpdateStatus = {
            ...(versionUpdateStatus || {}),
            uiState: 'checking',
            indicatorLabel: 'Проверка…',
        };
        if (lastBotHealthForVersion) {
            patchBotHealthVersionCard(lastBotHealthForVersion);
        }
    }

    const query = forceRefresh ? '?refresh=1' : '';
    const data = await fetchData(`/app-update-check${query}`);
    if (!data) {
        return null;
    }
    if (tryFinishLifecycleIfReady(data)) {
        return data;
    }
    if (recoverStaleLifecycleIfNeeded(data)) {
        return data;
    }
    if (!lifecycleWaitMode && data.uiState !== 'updating') {
        versionCardBusy = false;
    }
    versionUpdateStatus = data;
    if (lastBotHealthForVersion) {
        patchBotHealthVersionCard(lastBotHealthForVersion);
    }
    syncAutoUpdateToggleUi({
        enabled: data.dashboardUpdateEnabled === true,
        inProgress: data.dashboardUpdateInProgress === true,
    });
    maybeTriggerAutoAppUpdate(data);
    return data;
}

/**
 * Состояние переключателя «Автообновление» в шапке
 */
function syncAutoUpdateToggleUi(opts = {}) {
    const toggle = document.getElementById('dashboardAutoUpdateToggle');
    const wrap = document.getElementById('autoUpdateToggleControl');
    if (!toggle) {
        return;
    }

    const featureEnabled =
        opts.enabled !== undefined ? opts.enabled : dashboardUpdateFeatureEnabled;
    const inProgress =
        opts.inProgress !== undefined
            ? opts.inProgress
            : versionUpdateStatus?.dashboardUpdateInProgress === true;

    toggle.disabled = !!lifecycleWaitMode || !!inProgress;
    if (wrap) {
        wrap.classList.toggle('auto-update-toggle--feature-off', !featureEnabled);
        wrap.title = !featureEnabled
            ? 'Сохраняет выбор. Чтобы автообновление работало, включите DASHBOARD_UPDATE_ENABLED в «Конфиг бота»'
            : 'При обнаружении обновления установка запустится без подтверждения';
    }
}

/**
 * Инициализация переключателя автообновления
 */
function initAutoUpdateToggle() {
    const toggle = document.getElementById('dashboardAutoUpdateToggle');
    if (!toggle || toggle.dataset.bound === '1') {
        return;
    }
    toggle.dataset.bound = '1';
    toggle.checked = dashboardAutoUpdateEnabled;
    toggle.addEventListener('change', (e) => {
        dashboardAutoUpdateEnabled = e.target.checked;
        safeSetLocalStorage('dashboardAutoUpdateEnabled', dashboardAutoUpdateEnabled.toString());
        if (!dashboardAutoUpdateEnabled) {
            autoUpdateTriggeredForRevision = null;
        } else if (!dashboardUpdateFeatureEnabled) {
            showNotification(
                'info',
                'Автообновление включено в интерфейсе. Для запуска установки включите DASHBOARD_UPDATE_ENABLED в «Конфиг бота»'
            );
        }
    });
    syncAutoUpdateToggleUi();
}

/**
 * Запускает обновление без диалогов, если включено автообновление
 */
function maybeTriggerAutoAppUpdate(st) {
    if (!dashboardAutoUpdateEnabled) {
        return;
    }
    if (lifecycleWaitMode || versionCardBusy) {
        return;
    }
    if (!st?.updateAvailable || st.uiState !== 'available') {
        if (st?.checkStatus === 'current' || st?.uiState === 'current') {
            autoUpdateTriggeredForRevision = null;
        }
        return;
    }
    if (!st.dashboardUpdateEnabled || !st.dashboardUpdateCanTrigger) {
        return;
    }

    const target = st.remoteRevisionFull || st.remoteRevision;
    if (!target || autoUpdateTriggeredForRevision === target) {
        return;
    }

    autoUpdateTriggeredForRevision = target;
    versionCardBusy = true;
    setLifecycleHeaderText('Автообновление…');
    void triggerDashboardAppUpdate({ silent: true });
}

function versionCardDotKind(uiState) {
    switch (uiState) {
        case 'available':
            return 'warn';
        case 'updating':
        case 'checking':
            return 'off';
        case 'error':
            return 'err';
        case 'unavailable':
            return 'off';
        case 'current':
        default:
            return 'ok';
    }
}

/**
 * Форматирует ISO-дату коммита для отображения (ru-RU)
 */
function formatCommitDateTime(iso) {
    if (!iso) {
        return '';
    }
    try {
        return new Intl.DateTimeFormat('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).format(new Date(iso));
    } catch {
        return iso;
    }
}

/**
 * Строка «ревизия · дата» для карточки версии
 */
function formatRevisionWithCommitDate(revision, committedAtIso) {
    const rev = revision || '—';
    const when = formatCommitDateTime(committedAtIso);
    return when ? `${rev} · ${when}` : rev;
}

/**
 * Карточка «Версия» с индикатором состояния обновления
 */
function renderVersionHealthCard(health) {
    const st = versionUpdateStatus;
    const uiState = st?.uiState || 'checking';
    const dotKind = versionCardDotKind(uiState);
    const indicatorLabel = st?.indicatorLabel || 'Проверка…';

    let title = 'Нажмите, чтобы проверить обновление';
    if (uiState === 'available') {
        title = 'Доступно обновление с dev — нажмите для установки';
    } else if (uiState === 'current') {
        title = 'Версия совпадает с origin/dev';
    } else if (uiState === 'updating') {
        title = 'Идёт обновление…';
    } else if (uiState === 'error') {
        title = 'Ошибка проверки — нажмите повторить';
    }

    let valueHtml = escapeHtml(health.appVersion || '—');
    if (uiState === 'available') {
        valueHtml += '<span class="bot-health-update-badge">NEW</span>';
    }

    const localRev = st?.localRevision || health.gitRevision || '—';
    const detailParts = [
        `<span class="version-status-pill version-status-pill--${uiState}">${escapeHtml(indicatorLabel)}</span>`,
        `Локально: <strong>${escapeHtml(localRev)}</strong>` +
            (st?.localRevisionCommittedAt
                ? ` · ${escapeHtml(formatCommitDateTime(st.localRevisionCommittedAt))}`
                : ''),
    ];

    if (st?.remoteRevision) {
        const remoteWhen = st.remoteRevisionCommittedAt
            ? ` · ${escapeHtml(formatCommitDateTime(st.remoteRevisionCommittedAt))}`
            : '';
        detailParts.push(
            `${escapeHtml(st.remote || 'origin')}/${escapeHtml(st.branch || 'dev')}: ` +
                `<strong>${escapeHtml(st.remoteRevision)}</strong>${remoteWhen}`
        );
    }
    if (st?.error) {
        detailParts.push(escapeHtml(st.error));
    }
    if (st?.checkSkippedReason) {
        detailParts.push(escapeHtml(st.checkSkippedReason));
    }
    if (st?.dashboardUpdateEnabled === false && uiState === 'available') {
        detailParts.push('Для установки включите DASHBOARD_UPDATE_ENABLED в «Конфиг бота»');
    }

    const dot = `<span class="bot-health-status-dot ${healthStatusDotClass(dotKind)}"></span>`;
    const busyAttr = versionCardBusy || uiState === 'updating' ? ' aria-busy="true"' : '';

    return `
        <div class="bot-health-card bot-health-card-version" id="botHealthVersionCard" data-state="${escapeHtml(uiState)}" role="button" tabindex="0" title="${escapeHtml(title)}"${busyAttr}>
            <div class="bot-health-card-title">Версия</div>
            <div class="bot-health-card-value">${dot}${valueHtml}</div>
            <div class="bot-health-card-detail">${detailParts.join('<br>')}</div>
        </div>
    `;
}

function bindBotHealthVersionCardClick() {
    const card = document.getElementById('botHealthVersionCard');
    if (!card || card.dataset.bound === '1') {
        return;
    }
    card.dataset.bound = '1';
    const activate = () => {
        handleVersionCardClick();
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
        }
    });
}

function patchBotHealthVersionCard(health) {
    const grid = document.getElementById('botHealthGrid');
    const existing = document.getElementById('botHealthVersionCard');
    if (!grid || !existing) {
        return;
    }
    const wrap = document.createElement('div');
    wrap.innerHTML = renderVersionHealthCard(health).trim();
    const newCard = wrap.firstElementChild;
    if (newCard) {
        grid.replaceChild(newCard, existing);
        bindBotHealthVersionCardClick();
    }
}

/**
 * Клик по «Версия»: проверка и установка последней ревизии dev
 */
async function handleVersionCardClick() {
    if (versionCardBusy) {
        return;
    }

    const st = versionUpdateStatus;
    if (st?.uiState === 'updating' || st?.dashboardUpdateInProgress) {
        if (typeof showNotification === 'function') {
            showNotification('info', 'Обновление уже выполняется. Лог: logs/dashboard-update.log');
        }
        return;
    }

    if (st?.uiState === 'available' && st.updateAvailable) {
        promptInstallAppUpdate(st);
        return;
    }

    versionCardBusy = true;
    try {
        const fresh = await pollVersionUpdateStatus(true);
        if (!fresh) {
            if (typeof showNotification === 'function') {
                showNotification('error', 'Не удалось проверить обновления');
            }
            return;
        }
        if (fresh.checkSkippedReason) {
            if (typeof showNotification === 'function') {
                showNotification('info', fresh.checkSkippedReason);
            }
            return;
        }
        if (fresh.error) {
            if (typeof showNotification === 'function') {
                showNotification('error', fresh.error);
            }
            return;
        }
        if (fresh.uiState === 'available' && fresh.updateAvailable) {
            promptInstallAppUpdate(fresh);
            return;
        }
        if (typeof showNotification === 'function') {
            showNotification('success', `Версия актуальна (${fresh.remote}/${fresh.branch})`);
        }
    } finally {
        versionCardBusy = false;
    }
}

function promptInstallAppUpdate(st) {
    if (!st.dashboardUpdateEnabled) {
        if (typeof showNotification === 'function') {
            showNotification(
                'warn',
                `На ${st.remote}/${st.branch} есть ${formatRevisionWithCommitDate(st.remoteRevision, st.remoteRevisionCommittedAt)}. ` +
                    'Включите DASHBOARD_UPDATE_ENABLED в «Конфиг бота»'
            );
        }
        return;
    }
    if (!st.dashboardUpdateCanTrigger) {
        const msg = st.dashboardUpdateBlockedReason || 'Обновление сейчас недоступно';
        if (typeof showNotification === 'function') {
            showNotification('warn', msg);
        }
        return;
    }

    showConfirmModal(
        'Обновить до последней версии dev?',
        `Локально: ${formatRevisionWithCommitDate(st.localRevision, st.localRevisionCommittedAt)}.\n` +
            `На ${st.remote}/${st.branch}: ${formatRevisionWithCommitDate(st.remoteRevision, st.remoteRevisionCommittedAt)}.\n\n` +
            `Будет выполнено: git fetch → reset на origin/${st.branch} → ` +
            'npm install → build → перезапуск. Локальные изменения в репозитории будут сброшены. ' +
            'Дашборд отключится на 1–3 минуты. Продолжить?',
        () => triggerDashboardAppUpdate()
    );
}

function startVersionUpdatePolling() {
    if (versionUpdatePollTimer) {
        clearInterval(versionUpdatePollTimer);
    }
    pollVersionUpdateStatus(false);
    versionUpdatePollTimer = setInterval(() => pollVersionUpdateStatus(false), VERSION_UPDATE_POLL_MS);
}

function setLifecycleHeaderText(text) {
    const statusText = document.getElementById('statusText');
    if (statusText) {
        statusText.textContent = text;
    }
}

/**
 * server-info без кэша (пока бот перезапускается)
 */
async function fetchServerInfoForReconnect() {
    try {
        const headers = {};
        const apiKey = getDashboardApiKey();
        if (apiKey) {
            headers['X-API-Key'] = apiKey;
        }
        const response = await fetch(`${API_BASE}/server-info?_=${Date.now()}`, {
            headers,
            cache: 'no-store',
        });
        if (!response.ok) {
            return null;
        }
        return await response.json();
    } catch {
        return null;
    }
}

function hasNewBotPidAfterLifecycle(serverPid) {
    if (serverPid == null || lifecycleWaitPreviousPid == null) {
        return false;
    }
    return Number(serverPid) !== Number(lifecycleWaitPreviousPid);
}

function isServerReadyAfterLifecycle(info) {
    if (!info?.pid) {
        return false;
    }
    if (info.dashboardUpdateInProgress === true) {
        return false;
    }
    if (!lifecycleWaitMode) {
        return true;
    }
    if (lifecycleWaitPreviousPid == null) {
        return false;
    }
    applyBotUptimeFromServerInfo(info);
    if (hasNewBotPidAfterLifecycle(info.pid)) {
        return true;
    }
    return lifecycleServerWasDown;
}

function isUpdateCheckReadyAfterLifecycle(data) {
    if (!data || !lifecycleWaitMode) {
        return false;
    }
    if (lifecycleWaitPreviousPid == null) {
        return false;
    }
    if (data.dashboardUpdateInProgress === true || data.uiState === 'updating') {
        return false;
    }
    if (hasNewBotPidAfterLifecycle(data.serverPid)) {
        return true;
    }
    return lifecycleServerWasDown;
}

/**
 * Завершение ожидания: карточка «Версия» + перезагрузка страницы
 */
function finishLifecycleFromServer(data, successMessage) {
    stopDashboardReconnectWatch();
    versionCardBusy = false;
    lifecycleWaitMode = null;
    lifecycleWaitPreviousPid = null;
    lifecycleWaitStartedAt = 0;
    lastBotHealthForVersion = null;
    if (data) {
        versionUpdateStatus = data;
    }
    scheduleDashboardReload(successMessage);
}

function tryFinishLifecycleIfReady(data) {
    if (!lifecycleWaitMode || !data) {
        return false;
    }
    if (!isUpdateCheckReadyAfterLifecycle(data)) {
        return false;
    }
    const msg =
        lifecycleWaitMode === 'update'
            ? 'Обновление завершено. Перезагрузка страницы…'
            : 'Перезапуск завершён. Перезагрузка страницы…';
    finishLifecycleFromServer(data, msg);
    return true;
}

/** Сброс «зависшего» Обновление… на карточке и в шапке */
function resetDashboardLifecycleUi(headerText) {
    versionCardBusy = false;
    lifecycleWaitMode = null;
    lifecycleWaitPreviousPid = null;
    lifecycleWaitStartedAt = 0;
    lifecycleServerWasDown = false;
    updateConnectionStatus(false);
    setLifecycleHeaderText(headerText || 'Disconnected');
    pollVersionUpdateStatus(true);
}

/**
 * Ждёт ответа нового процесса бота перед перезагрузкой страницы
 */
async function waitForNewBotApiReady(maxWaitMs = 120_000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const info = await fetchServerInfoForReconnect();
        if (!info?.pid || info.dashboardUpdateInProgress === true) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
        }
        applyBotUptimeFromServerInfo(info);
        if (
            lifecycleWaitPreviousPid != null &&
            !hasNewBotPidAfterLifecycle(info.pid) &&
            !lifecycleServerWasDown
        ) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
        }
        const remaining = deadline - Date.now();
        if (remaining > 0 && (await waitForBotDashboardDataReady(Math.min(remaining, 15_000)))) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}

function scheduleDashboardReload(successMessage) {
    stopDashboardReconnectWatch();
    versionCardBusy = false;
    lifecycleWaitMode = null;
    lifecycleWaitPreviousPid = null;
    lifecycleWaitStartedAt = 0;
    lifecycleServerWasDown = false;
    if (typeof showNotification === 'function') {
        showNotification('success', successMessage || 'Бот снова online. Перезагрузка страницы…');
    }
    setLifecycleHeaderText('Перезагрузка страницы…');

    void (async () => {
        await waitForNewBotApiReady();
        const url = new URL(window.location.href);
        url.searchParams.set('_', String(Date.now()));
        url.searchParams.set('vrefresh', '1');
        window.location.replace(url.toString());
    })();
}

/**
 * Ожидание поднятия бота после перезапуска / обновления
 * @param successMessage Текст уведомления перед reload
 * @param mode 'update' | 'restart'
 */
let reconnectWatchAttempts = 0;
let reconnectWatchSuccessMessage = '';
let reconnectWatchLabel = 'Перезапуск';

async function runReconnectLifecycleTick() {
    if (!lifecycleWaitMode) {
        return;
    }

    reconnectWatchAttempts += 1;
    setLifecycleHeaderText(
        `${reconnectWatchLabel}… ожидание бота (${reconnectWatchAttempts}/${RECONNECT_MAX_ATTEMPTS})`
    );

    const info = await fetchServerInfoForReconnect();
    if (!info?.pid) {
        lifecycleServerWasDown = true;
    } else {
        applyBotUptimeFromServerInfo(info);
    }
    if (info?.pid && isServerReadyAfterLifecycle(info)) {
        const upd = await fetchData(`/app-update-check?_=${Date.now()}`);
        finishLifecycleFromServer(
            upd || null,
            reconnectWatchSuccessMessage || 'Бот снова online. Перезагрузка страницы…'
        );
        return;
    }

    const updCheck = await fetchData(`/app-update-check?_=${Date.now()}`);
    if (!updCheck) {
        lifecycleServerWasDown = true;
    }
    if (tryFinishLifecycleIfReady(updCheck)) {
        return;
    }
    if (recoverStaleLifecycleIfNeeded(updCheck)) {
        return;
    }

    if (reconnectWatchAttempts >= RECONNECT_MAX_ATTEMPTS) {
        stopDashboardReconnectWatch();
        resetDashboardLifecycleUi('Обновите страницу (F5)');
        if (typeof showNotification === 'function') {
            showNotification(
                'warn',
                'Бот долго не отвечает. Обновите страницу (F5) или откройте дашборд заново.'
            );
        }
        setTimeout(async () => {
            const late = await fetchServerInfoForReconnect();
            if (isServerReadyAfterLifecycle(late)) {
                const upd = await fetchData(`/app-update-check?_=${Date.now()}`);
                finishLifecycleFromServer(
                    upd || null,
                    reconnectWatchSuccessMessage || 'Бот снова online. Перезагрузка страницы…'
                );
            } else if (tryFinishLifecycleIfReady(await fetchData(`/app-update-check?_=${Date.now()}`))) {
                // завершено через app-update-check
            }
        }, 2000);
    }
}

async function startDashboardReconnectWatch(successMessage, mode = 'restart') {
    lifecycleWaitMode = mode;
    reconnectWatchSuccessMessage = successMessage;
    reconnectWatchLabel = mode === 'update' ? 'Обновление' : 'Перезапуск';
    reconnectWatchAttempts = 0;
    lifecycleServerWasDown = false;
    stopDashboardReconnectWatch();

    if (lifecycleWaitPreviousPid == null) {
        await captureLifecycleWaitPid();
    }

    versionUpdateFastPollTimer = setInterval(runReconnectLifecycleTick, RECONNECT_POLL_MS);
    void runReconnectLifecycleTick();
}

function onDashboardVisibilityForLifecycle() {
    if (document.visibilityState === 'visible' && lifecycleWaitMode) {
        runReconnectLifecycleTick();
    }
}

/**
 * Планирует полное обновление дашборда (дебаунс при пачке SSE-событий)
 */
function scheduleDashboardRefresh() {
    if (dashboardRefreshDebounceTimer != null) {
        clearTimeout(dashboardRefreshDebounceTimer);
    }
    dashboardRefreshDebounceTimer = setTimeout(() => {
        dashboardRefreshDebounceTimer = null;
        void updateAll();
    }, DASHBOARD_SSE_DEBOUNCE_MS);
}

/**
 * Мгновенные уведомления по stream-up/down из SSE (не ждём опроса API)
 * @param {{ type?: string, streamer?: string }} data
 */
function handleDashboardStreamEvent(data) {
    if (!data || !data.type) {
        return;
    }
    if (data.type === 'stream-up' || data.type === 'stream-down') {
        const streamer = data.streamer;
        if (streamer) {
            streamStatusTrackingReady = true;
            previousStreamerStatus[streamer] =
                data.type === 'stream-up' ? 'ONLINE' : 'OFFLINE';
            processStreamStatusNotifications([{ streamer, type: data.type }]);
        }
    }
    scheduleDashboardRefresh();
}

/**
 * Подключает SSE-поток событий бота (push, не зависит от троттлинга setInterval)
 */
function startDashboardEventStream() {
    if (typeof EventSource === 'undefined') {
        return;
    }
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    try {
        eventSource = new EventSource(`${API_BASE}/events/stream`);
        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleDashboardStreamEvent(data);
            } catch (e) {
                console.warn('Dashboard SSE parse error:', e);
            }
        };
        eventSource.onerror = () => {
            // EventSource переподключается сам; при ошибке — fallback-опрос в фоне
            ensureHiddenTabFallbackPoll();
        };
    } catch (e) {
        console.warn('Dashboard SSE connect failed:', e);
    }
}

function stopDashboardEventStream() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
}

function stopHiddenTabFallbackPoll() {
    if (hiddenTabFallbackTimer != null) {
        clearInterval(hiddenTabFallbackTimer);
        hiddenTabFallbackTimer = null;
    }
}

/**
 * Дополнительный опрос в фоновой вкладке (setInterval там сильно троттлится)
 */
function ensureHiddenTabFallbackPoll() {
    if (document.visibilityState !== 'hidden' || hiddenTabFallbackTimer != null) {
        return;
    }
    hiddenTabFallbackTimer = setInterval(() => {
        if (document.visibilityState === 'hidden') {
            void updateAll();
            if (updateMode === 'event') {
                void checkForNewEvents();
            }
        } else {
            stopHiddenTabFallbackPoll();
        }
    }, HIDDEN_TAB_FALLBACK_POLL_MS);
}

/**
 * При возврате на вкладку — догоняем данные; в фоне — включаем fallback
 */
function onDashboardVisibilityChange() {
    if (document.visibilityState === 'visible') {
        stopHiddenTabFallbackPoll();
        void updateAll();
        if (updateMode === 'event') {
            void checkForNewEvents();
        }
        onDashboardVisibilityForLifecycle();
    } else {
        ensureHiddenTabFallbackPoll();
    }
}

function stopDashboardReconnectWatch() {
    if (versionUpdateFastPollTimer) {
        clearInterval(versionUpdateFastPollTimer);
        versionUpdateFastPollTimer = null;
    }
}

/**
 * @param {{ silent?: boolean }} [options] silent — без toast (автообновление)
 */
async function triggerDashboardAppUpdate(options = {}) {
    const silent = options.silent === true;

    if (!silent && typeof showNotification === 'function') {
        showNotification('info', 'Запуск обновления…');
    }

    await captureLifecycleWaitPid();
    const result = await postApi('/app-update', {});

    if (result.ok) {
        if (!silent && typeof showNotification === 'function') {
            showNotification('success', result.message);
        }
        beginLifecycleWaitUi('update');
        startDashboardReconnectWatch('Обновление завершено. Перезагрузка страницы…', 'update');
    } else {
        if (silent) {
            autoUpdateTriggeredForRevision = null;
            versionCardBusy = false;
        }
        resetDashboardLifecycleUi('Disconnected');
        syncAutoUpdateToggleUi();
        if (!silent) {
            if (typeof showNotification === 'function') {
                showNotification('error', result.message || 'Не удалось запустить обновление');
            } else {
                alert(result.message || 'Не удалось запустить обновление');
            }
        }
    }
}

function updateConnectionStatus(connected) {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    
    if (connected) {
        statusDot.classList.remove('offline');
        statusDot.classList.add('online');
        statusText.textContent = 'Connected';
    } else {
        statusDot.classList.remove('online');
        statusDot.classList.add('offline');
        statusText.textContent = 'Disconnected';
    }
}

/**
 * Форматирует интервал (мс) для панели здоровья
 */
function formatHealthDuration(ms) {
    if (ms == null || Number.isNaN(ms)) {
        return '—';
    }
    if (ms <= 0) {
        return 'истёк';
    }
    const sec = Math.floor(ms / 1000);
    if (sec < 60) {
        return `${sec} с`;
    }
    const min = Math.floor(sec / 60);
    if (min < 60) {
        return `${min} мин`;
    }
    const hours = Math.floor(min / 60);
    if (hours < 48) {
        return `${hours} ч ${min % 60} мин`;
    }
    const days = Math.floor(hours / 24);
    return `${days} д ${hours % 24} ч`;
}

function formatHealthTimeAgo(timestamp) {
    if (!timestamp) {
        return '—';
    }
    const elapsed = Date.now() - timestamp;
    // «истёк» из formatHealthDuration — для сроков действия, не для «назад»
    if (elapsed < 5000) {
        return 'только что';
    }
    return formatHealthDuration(elapsed) + ' назад';
}

function healthStatusDotClass(kind) {
    if (kind === 'ok') return 'ok';
    if (kind === 'warn') return 'warn';
    if (kind === 'err') return 'err';
    return 'off';
}

function renderBotHealthCard(title, valueHtml, detailHtml, dotKind) {
    const dot = `<span class="bot-health-status-dot ${healthStatusDotClass(dotKind)}"></span>`;
    return `
        <div class="bot-health-card">
            <div class="bot-health-card-title">${escapeHtml(title)}</div>
            <div class="bot-health-card-value">${dot}${valueHtml}</div>
            ${detailHtml ? `<div class="bot-health-card-detail">${detailHtml}</div>` : ''}
        </div>
    `;
}

function describeWebSocketHealth(ws) {
    if (!ws) {
        return { label: '—', kind: 'off', detail: '' };
    }
    const labels = {
        connected: 'Подключён',
        reconnecting: 'Переподключение',
        disconnected: 'Отключён',
        stopped: 'Остановлен',
    };
    let kind = 'off';
    if (ws.status === 'connected') kind = 'ok';
    else if (ws.status === 'reconnecting') kind = 'warn';
    else if (ws.status === 'disconnected') kind = 'err';

    let detail = `Состояние: ${escapeHtml(ws.connectionState || '—')}`;
    if (ws.status === 'reconnecting' && ws.maxReconnectAttempts > 0) {
        detail += `<br>Попытка ${ws.reconnectAttempt}/${ws.maxReconnectAttempts}`;
    }
    if (ws.hasCriticalErrors && ws.lastCriticalError) {
        detail += `<br><span style="color:#ef4444">${escapeHtml(ws.lastCriticalError.error)}</span>`;
        kind = 'err';
    }
    return { label: labels[ws.status] || ws.status, kind, detail };
}

function describeCircuitBreaker(graphql) {
    const state = graphql?.circuitBreaker || 'CLOSED';
    const labels = { CLOSED: 'Закрыт (OK)', OPEN: 'Открыт (блокировка)', HALF_OPEN: 'Полуоткрыт' };
    let kind = 'ok';
    if (state === 'OPEN') kind = 'err';
    else if (state === 'HALF_OPEN') kind = 'warn';
    let detail = '';
    if (graphql?.hadRecentNetworkFailure) {
        detail = 'Недавние сетевые ошибки GraphQL';
        if (kind === 'ok') kind = 'warn';
    }
    return { label: labels[state] || state, kind, detail };
}

/**
 * Карточка Просмотр + WebSocket + GraphQL CB
 */
function renderNetworkHealthCard(health) {
    const ws = health?.websocket;
    const graphql = health?.graphql;
    const wsInfo = describeWebSocketHealth(ws);
    const gqlInfo = describeCircuitBreaker(graphql);
    const watcherKind = health?.watcherRunning ? 'ok' : 'err';
    const watcherLabel = health?.watcherRunning ? 'Работает' : 'Остановлен';
    const watcherDot = `<span class="bot-health-status-dot ${healthStatusDotClass(watcherKind)}"></span>`;
    const wsDot = `<span class="bot-health-status-dot ${healthStatusDotClass(wsInfo.kind)}"></span>`;
    const gqlDot = `<span class="bot-health-status-dot ${healthStatusDotClass(gqlInfo.kind)}"></span>`;

    return `
        <div class="bot-health-card bot-health-card-network">
            <div class="bot-health-card-title">WebSocket / GraphQL</div>
            <div class="bot-health-network-block">
                <div class="bot-health-card-value bot-health-network-value">${watcherDot}<span class="bot-health-network-name">Просмотр</span> ${escapeHtml(watcherLabel)}</div>
            </div>
            <div class="bot-health-network-block">
                <div class="bot-health-card-value bot-health-network-value">${wsDot}<span class="bot-health-network-name">WebSocket</span> ${escapeHtml(wsInfo.label)}</div>
                ${wsInfo.detail ? `<div class="bot-health-card-detail">${wsInfo.detail}</div>` : ''}
            </div>
            <div class="bot-health-network-block">
                <div class="bot-health-card-value bot-health-network-value">${gqlDot}<span class="bot-health-network-name">GraphQL CB</span> ${escapeHtml(gqlInfo.label)}</div>
                ${gqlInfo.detail ? `<div class="bot-health-card-detail">${gqlInfo.detail}</div>` : ''}
            </div>
        </div>
    `;
}

function formatGqlContextFieldRow(label, field) {
    const value = field?.value || '—';
    const updated = field?.lastUpdatedAtMs
        ? formatHealthTimeAgo(field.lastUpdatedAtMs)
        : '—';
    const valueKind = field?.value ? 'ok' : 'muted';
    const updatedKind = field?.lastUpdatedAtMs ? 'ok' : 'muted';
    return `
        <div class="client-integrity-row">
            <dt>${escapeHtml(label)}</dt>
            <dd class="gql-context-value ${integrityPanelStateClass(valueKind)}">${escapeHtml(value)}</dd>
        </div>
        <div class="client-integrity-row client-integrity-row-sub">
            <dt>Обновлено</dt>
            <dd class="${integrityPanelStateClass(updatedKind)}">${escapeHtml(updated)}</dd>
        </div>
    `;
}

/**
 * Карточка Client-Version / Session-Id / Device-Id из браузера
 */
function renderGqlContextHealthCard(gqlContext) {
    const ctx = gqlContext || {};
    return `
        <div class="bot-health-card bot-health-card-gql-context">
            <div class="bot-health-card-title">GQL-заголовки</div>
            <dl class="client-integrity-rows">
                ${formatGqlContextFieldRow('Client-Version', ctx.clientVersion)}
                ${formatGqlContextFieldRow('Client-Session-Id', ctx.clientSessionId)}
                ${formatGqlContextFieldRow('X-Device-Id', ctx.deviceId)}
            </dl>
        </div>
    `;
}

/**
 * Собирает HTML карточки Integrity (вторая в сетке «Статус бота»)
 */
async function renderIntegrityHealthCard(health, captureStatus = null) {
    if (captureStatus == null) {
        captureStatus = await fetchData('/integrity/capture/status');
    }

    const integrity = health?.integrity;
    const lastUp = formatIntegrityLastUpdated(integrity, captureStatus);
    const token = formatIntegrityTokenState(integrity);
    const claim = formatIntegrityClaimState(integrity?.bonusClaim);
    const prevPrefix = integrity?.tokenPreviousPrefix || '';
    const curPrefix = integrity?.tokenCurrentPrefix || '';

    let hintText = '';
    let hintClass = 'integrity-capture-hint';
    if (captureStatus?.captureRequestPending) {
        hintText = 'Ожидание передачи от расширения…';
    } else if (captureStatus?.enabled === false) {
        hintText = 'Приём от расширения отключён (INTEGRITY_BRIDGE_ENABLED=false)';
        hintClass += ' err';
    }

    const captureBusy = Boolean(
        captureStatus?.captureRequestPending || integrityCapturePollTimer != null
    );
    const panelTitle = captureBusy
        ? INTEGRITY_PANEL_CAPTURE_BUSY_TITLE
        : INTEGRITY_PANEL_CAPTURE_TITLE;

    return `
        <div class="bot-health-card bot-health-card-integrity bot-health-card-span-2 client-integrity-panel-clickable" id="clientIntegrityPanel" role="button" tabindex="0" data-state="${captureBusy ? 'requesting' : 'idle'}" data-busy="${captureBusy ? '1' : '0'}" title="${escapeHtml(panelTitle)}" aria-live="polite"${captureBusy ? ' aria-busy="true"' : ''}>
            <div class="bot-health-card-title">Integrity</div>
            <p class="client-integrity-click-hint">Нажмите на карточку для запроса токена</p>
            <dl class="client-integrity-rows">
                <div class="client-integrity-row">
                    <dt>Обновлён</dt>
                    <dd id="integrityLastUpdated" class="${integrityPanelStateClass(lastUp.kind)}">${escapeHtml(lastUp.text)}</dd>
                </div>
                <div class="client-integrity-row">
                    <dt>Токен</dt>
                    <dd id="integrityTokenState" class="${integrityPanelStateClass(token.kind)}">${escapeHtml(token.text)}</dd>
                </div>
                <div class="client-integrity-row">
                    <dt>Прошлый токен</dt>
                    <dd id="integrityPreviousToken" class="integrity-token-prefix ${integrityPanelStateClass(prevPrefix ? 'ok' : 'muted')}">${escapeHtml(prevPrefix || '—')}</dd>
                </div>
                <div class="client-integrity-row">
                    <dt>Текущий токен</dt>
                    <dd id="integrityCurrentToken" class="integrity-token-prefix ${integrityPanelStateClass(curPrefix ? 'ok' : 'muted')}">${escapeHtml(curPrefix || '—')}</dd>
                </div>
                <div class="client-integrity-row">
                    <dt>Сбор бонусов</dt>
                    <dd id="integrityClaimState" class="${integrityPanelStateClass(claim.kind)}">${escapeHtml(claim.text)}</dd>
                </div>
            </dl>
            <p id="integrityCaptureHint" class="${hintClass}">${escapeHtml(hintText)}</p>
        </div>
    `;
}

/**
 * Обновляет панель «Статус бота»
 */
async function updateBotHealth() {
    const grid = document.getElementById('botHealthGrid');
    const claimsEl = document.getElementById('botHealthClaims');
    if (!grid) {
        return;
    }

    const health = await fetchData('/bot-health');
    const integrityCard = await renderIntegrityHealthCard(health);

    if (!health || health.error) {
        grid.innerHTML =
            integrityCard +
            `<p class="bot-health-empty bot-health-grid-message">${escapeHtml(health?.error || 'Watcher не запущен')}</p>`;
        bindClientIntegrityPanelClick();
        if (claimsEl) {
            claimsEl.innerHTML = '<p class="bot-health-empty">—</p>';
        }
        updateConnectionStatus(false);
        return;
    }

    updateConnectionStatus(health.websocket?.status === 'connected');
    lastBotHealthForVersion = health;

    const cards = [
        renderVersionHealthCard(health),
        integrityCard,
        renderGqlContextHealthCard(health.gqlContext),
        renderNetworkHealthCard(health),
    ];

    grid.innerHTML = cards.join('');
    bindBotHealthVersionCardClick();
    bindClientIntegrityPanelClick();

    if (!claimsEl) {
        return;
    }

    const claims = health.claimByStreamer || [];
    if (claims.length === 0) {
        claimsEl.innerHTML = '<p class="bot-health-empty">Пока нет попыток сбора бонусов в этой сессии</p>';
        return;
    }

    claimsEl.innerHTML = claims
        .map((c) => {
            const outcomeClass = c.outcome === 'success' ? 'success' : 'failed';
            const outcomeText = c.outcome === 'success' ? 'Успех' : 'Ошибка';
            let extraBadge = '';
            if (c.failureKind === 'integrity') {
                extraBadge = '<span class="bot-health-badge integrity">integrity</span>';
            } else if (c.failureKind === 'permanent') {
                extraBadge = '<span class="bot-health-badge permanent">permanent</span>';
            }
            return `
                <div class="bot-health-claim-row">
                    <span class="bot-health-claim-streamer">${escapeHtml(c.streamer)}</span>
                    <span class="bot-health-badge ${outcomeClass}">${outcomeText}</span>
                    ${extraBadge}
                    <span style="color:#adadb8">${escapeHtml(formatHealthTimeAgo(c.timestamp))}</span>
                    <span style="color:#6b6b7a;flex:1;min-width:120px">${escapeHtml(c.message)}</span>
                </div>
            `;
        })
        .join('');
}

const DASHBOARD_BRIDGE_MESSAGE_SOURCE = 'twitch-watcher-dashboard';
const INTEGRITY_CAPTURE_REQUEST_POLL_MS = 2000;
const INTEGRITY_CAPTURE_REQUEST_TIMEOUT_MS = 120000;
const INTEGRITY_PANEL_CAPTURE_TITLE =
    'Нажмите, чтобы запросить Client-Integrity (расширение Edge, twitch.tv)';
const INTEGRITY_PANEL_CAPTURE_BUSY_TITLE =
    'Ожидание передачи Client-Integrity от расширения…';
let integrityCapturePollTimer = null;

function isIntegrityCaptureRequestBusy() {
    const panel = document.getElementById('clientIntegrityPanel');
    return panel?.dataset.busy === '1';
}

function setIntegrityPanelCaptureBusy(busy) {
    const panel = document.getElementById('clientIntegrityPanel');
    if (!panel) {
        return;
    }
    panel.dataset.state = busy ? 'requesting' : 'idle';
    panel.dataset.busy = busy ? '1' : '0';
    panel.title = busy ? INTEGRITY_PANEL_CAPTURE_BUSY_TITLE : INTEGRITY_PANEL_CAPTURE_TITLE;
    if (busy) {
        panel.setAttribute('aria-busy', 'true');
    } else {
        panel.removeAttribute('aria-busy');
    }
}

function bindClientIntegrityPanelClick() {
    const panel = document.getElementById('clientIntegrityPanel');
    if (!panel) {
        return;
    }
    const activate = () => {
        if (isIntegrityCaptureRequestBusy()) {
            return;
        }
        void requestIntegrityCaptureFromBridge();
    };
    panel.addEventListener('click', activate);
    panel.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
        }
    });
}

/**
 * Сообщение content script расширения Integrity Bridge
 */
function notifyIntegrityBridgeExtension() {
    window.postMessage(
        {
            source: DASHBOARD_BRIDGE_MESSAGE_SOURCE,
            type: 'REQUEST_INTEGRITY_CAPTURE',
        },
        window.location.origin
    );
}

function stopIntegrityCapturePoll() {
    if (integrityCapturePollTimer != null) {
        clearInterval(integrityCapturePollTimer);
        integrityCapturePollTimer = null;
    }
}

function setIntegrityCaptureHint(text, kind) {
    const hint = document.getElementById('integrityCaptureHint');
    if (!hint) {
        return;
    }
    hint.textContent = text || '';
    hint.className = 'integrity-capture-hint' + (kind ? ` ${kind}` : '');
}

function integrityPanelStateClass(kind) {
    if (kind === 'ok') {
        return 'state-ok';
    }
    if (kind === 'warn') {
        return 'state-warn';
    }
    if (kind === 'err') {
        return 'state-err';
    }
    return 'state-muted';
}

function setIntegrityPanelValue(elementId, text, kind) {
    const el = document.getElementById(elementId);
    if (!el) {
        return;
    }
    el.textContent = text;
    el.className = integrityPanelStateClass(kind);
}

function setIntegrityPanelTokenPrefix(elementId, prefix) {
    const el = document.getElementById(elementId);
    if (!el) {
        return;
    }
    el.textContent = prefix || '—';
    el.className = `integrity-token-prefix ${integrityPanelStateClass(prefix ? 'ok' : 'muted')}`;
}

function formatIntegrityLastUpdated(integrity, captureStatus) {
    const captureAt = captureStatus?.lastCaptureAt ?? 0;
    const atMs = Math.max(captureAt, integrity?.lastUpdatedAtMs ?? 0);
    if (!atMs) {
        if (integrity?.configured) {
            return { text: 'неизвестно (токен из config)', kind: 'warn' };
        }
        return { text: 'не обновлялся', kind: 'muted' };
    }
    const estimated = Boolean(integrity?.lastUpdatedAtEstimated) && captureAt <= 0;
    const suffix = estimated ? ' (прибл.)' : '';
    return { text: `${formatHealthTimeAgo(atMs)}${suffix}`, kind: 'ok' };
}

function formatIntegrityTokenState(integrity) {
    if (!integrity) {
        return { text: '—', kind: 'muted' };
    }
    const sourceLabel = integrity.source === 'manual' ? 'manual' : 'API';
    if (!integrity.configured) {
        return { text: `не задан (${sourceLabel})`, kind: 'err' };
    }
    if (!integrity.valid) {
        return { text: `истёк (${sourceLabel})`, kind: 'err' };
    }
    let text = `действует (${sourceLabel})`;
    if (integrity.expiresInMs != null && integrity.expiresInMs > 0) {
        text += `, истекает через ${formatHealthDuration(integrity.expiresInMs)}`;
    }
    return { text, kind: 'ok' };
}

function formatIntegrityClaimState(bonusClaim) {
    if (!bonusClaim) {
        return { text: 'нет данных', kind: 'muted' };
    }
    const kindByStatus = {
        ok: 'ok',
        no_attempts: 'muted',
        token_invalid: 'err',
        integrity_blocked: 'err',
        claim_failed: 'warn',
    };
    let text = bonusClaim.message;
    if (bonusClaim.lastClaimAtMs) {
        text += ` (${formatHealthTimeAgo(bonusClaim.lastClaimAtMs)})`;
    }
    return { text, kind: kindByStatus[bonusClaim.status] || 'muted' };
}

/**
 * Панель Client Integrity в секции «Статус бота»
 */
async function renderClientIntegrityPanel(health, captureStatus = null) {
    const updatedEl = document.getElementById('integrityLastUpdated');
    if (!updatedEl) {
        return;
    }

    if (captureStatus == null) {
        captureStatus = await fetchData('/integrity/capture/status');
    }

    const integrity = health?.integrity;

    if (captureStatus?.captureRequestPending) {
        setIntegrityCaptureHint('Ожидание передачи от расширения…');
    } else if (captureStatus?.enabled === false) {
        setIntegrityCaptureHint('Приём от расширения отключён (INTEGRITY_BRIDGE_ENABLED=false)', 'err');
    } else {
        setIntegrityCaptureHint('');
    }

    const lastUp = formatIntegrityLastUpdated(integrity, captureStatus);
    setIntegrityPanelValue('integrityLastUpdated', lastUp.text, lastUp.kind);

    const token = formatIntegrityTokenState(integrity);
    setIntegrityPanelValue('integrityTokenState', token.text, token.kind);

    setIntegrityPanelTokenPrefix('integrityPreviousToken', integrity?.tokenPreviousPrefix);
    setIntegrityPanelTokenPrefix('integrityCurrentToken', integrity?.tokenCurrentPrefix);

    const claim = formatIntegrityClaimState(integrity?.bonusClaim);
    setIntegrityPanelValue('integrityClaimState', claim.text, claim.kind);

    const captureBusy = Boolean(
        captureStatus?.captureRequestPending || integrityCapturePollTimer != null
    );
    setIntegrityPanelCaptureBusy(captureBusy);
}

function startIntegrityCapturePoll(requestedAt) {
    stopIntegrityCapturePoll();
    const deadline = Date.now() + INTEGRITY_CAPTURE_REQUEST_TIMEOUT_MS;
    setIntegrityPanelCaptureBusy(true);

    integrityCapturePollTimer = setInterval(async () => {
        const status = await fetchData('/integrity/capture/status');
        if (lastBotHealthForVersion) {
            await renderClientIntegrityPanel(lastBotHealthForVersion, status);
        }
        const last = status?.lastCaptureAt ?? 0;
        if (last >= requestedAt) {
            stopIntegrityCapturePoll();
            setIntegrityPanelCaptureBusy(false);
            await updateBotHealth();
            return;
        }
        if (Date.now() > deadline) {
            stopIntegrityCapturePoll();
            setIntegrityCaptureHint(
                'Таймаут. Откройте twitch.tv в Edge с расширением и обновите страницу.',
                'err'
            );
            setIntegrityPanelCaptureBusy(false);
        }
    }, INTEGRITY_CAPTURE_REQUEST_POLL_MS);
}

async function requestIntegrityCaptureFromBridge() {
    if (isIntegrityCaptureRequestBusy()) {
        return;
    }

    setIntegrityPanelCaptureBusy(true);
    setIntegrityCaptureHint('Ожидание передачи от расширения…');
    notifyIntegrityBridgeExtension();

    const result = await postApi('/integrity/capture/request', {});
    if (!result.ok) {
        setIntegrityCaptureHint(result.message || 'Ошибка запроса', 'err');
        setIntegrityPanelCaptureBusy(false);
        return;
    }

    const requestedAt = result.data?.requestedAt ?? Date.now();
    startIntegrityCapturePoll(requestedAt);
    if (lastBotHealthForVersion) {
        await renderClientIntegrityPanel(lastBotHealthForVersion, {
            captureRequestPending: true,
            captureRequestedAt: requestedAt,
        });
    }
}

// Сохраняем предыдущие значения для анимации изменений
let previousStats = {
    activeWatches: 0,
    totalPointsEarned: 0,
    streamersCount: 0,
    lastActivity: 0,
    lastOnlineStreamer: null,
    lastActivityLabel: '—',
};

/**
 * Контейнер карточек сводной статистики (только основной дашборд)
 */
function getOverallStatsContainer() {
    return (
        document.getElementById('overallStatsGrid') ||
        document.querySelector('#mainContainer .stats-grid')
    );
}

/**
 * Записывает значения /api/overall в карточки заголовка
 */
function applyOverallStatsToDom(stats) {
    const root = getOverallStatsContainer();
    const resolveEl = (id) => (root ? root.querySelector(`#${id}`) : null) || document.getElementById(id);

    const activeEl = resolveEl('activeWatches');
    const pointsEl = resolveEl('totalPoints');
    const streamersEl = resolveEl('streamersCount');
    const activityEl = resolveEl('lastActivity');

    if (activeEl) {
        activeEl.textContent = (stats.activeWatches || 0).toLocaleString();
    }
    if (pointsEl) {
        pointsEl.textContent = (stats.totalPointsEarned || 0).toLocaleString();
    }
    if (streamersEl) {
        streamersEl.textContent = (stats.streamersCount || 0).toLocaleString();
    }
    if (activityEl) {
        activityEl.textContent = formatOverallLastActivity(stats);
    }
}

async function updateOverallStats() {
    const statsContainer = getOverallStatsContainer();
    const hasContent = statsContainer && statsContainer.querySelector('.stat-card');
    const hasSkeleton = statsContainer && statsContainer.querySelector('.skeleton-stat-card');
    
    // Показываем skeleton только при первой загрузке (когда нет контента и нет skeleton)
    if (!hasContent && !hasSkeleton && statsContainer) {
        statsContainer.innerHTML = generateStatsSkeleton();
    }
    
    const stats = await fetchData('/overall');
    if (!stats) {
        updateConnectionStatus(false);
        // Показываем сообщение об ошибке, если сервис недоступен
        const statusText = document.getElementById('statusText');
        if (statusText) {
            statusText.textContent = 'Service unavailable';
        }
        // Если был skeleton, заменяем на сообщение об ошибке
        if (statsContainer && statsContainer.querySelector('.skeleton-stat-card')) {
            statsContainer.innerHTML = '<p style="color: #adadb8; text-align: center; padding: 20px;">Failed to load statistics</p>';
        }
        return;
    }

    updateConnectionStatus(true);

    // Если был skeleton, заменяем плавно
    if (statsContainer && statsContainer.querySelector('.skeleton-stat-card')) {
        const newContent = `
            <div class="stat-card collapsible-card">
                <h3 onclick="toggleCard(this)"><span>Active Watches</span></h3>
                <div class="stat-card-content">
                    <div class="value" id="activeWatches">${(stats.activeWatches || 0).toLocaleString()}</div>
                    <div class="label">Currently watching</div>
                </div>
            </div>
            <div class="stat-card collapsible-card">
                <h3 onclick="toggleCard(this)"><span>Total Points</span></h3>
                <div class="stat-card-content">
                    <div class="value" id="totalPoints">${(stats.totalPointsEarned || 0).toLocaleString()}</div>
                    <div class="label">Points earned this session</div>
                </div>
            </div>
            <div class="stat-card collapsible-card">
                <h3 onclick="toggleCard(this)"><span>Streamers</span></h3>
                <div class="stat-card-content">
                    <div class="value" id="streamersCount">${(stats.streamersCount || 0).toLocaleString()}</div>
                    <div class="label">Total streamers</div>
                </div>
            </div>
            <div class="stat-card collapsible-card">
                <h3 onclick="toggleCard(this)"><span>Last Online</span></h3>
                <div class="stat-card-content">
                    <div class="value" id="lastActivity">${formatOverallLastActivity(stats)}</div>
                    <div class="label">Last streamer went live</div>
                </div>
            </div>
        `;
        replaceSkeletonWithContent(statsContainer, newContent);
    } else {
        const cards = statsContainer
            ? statsContainer.querySelectorAll('.stat-card')
            : document.querySelectorAll('#mainContainer .stat-card');
        cards.forEach((card) => {
            card.classList.add('updating');
            setTimeout(() => card.classList.remove('updating'), 300);
        });

        updateValueWithAnimation('activeWatches', stats.activeWatches || 0, previousStats.activeWatches);
        updateValueWithAnimation('totalPoints', stats.totalPointsEarned || 0, previousStats.totalPointsEarned);
        updateValueWithAnimation('streamersCount', stats.streamersCount || 0, previousStats.streamersCount);

        const lastActivityEl =
            (statsContainer && statsContainer.querySelector('#lastActivity')) ||
            document.getElementById('lastActivity');
        if (lastActivityEl) {
            const newValue = formatOverallLastActivity(stats);
            if (lastActivityEl.textContent !== newValue) {
                lastActivityEl.classList.add('value-change');
                lastActivityEl.textContent = newValue;
                setTimeout(() => lastActivityEl.classList.remove('value-change'), 500);
            } else {
                lastActivityEl.textContent = newValue;
            }
        } else {
            applyOverallStatsToDom(stats);
        }
    }

    lastDataUpdate.overall = Date.now();
    updateStaleDataIndicator('overall', statsContainer);

    // Сохраняем текущие значения
    const lastActivityLabel = formatOverallLastActivity(stats);
    previousStats = {
        activeWatches: stats.activeWatches || 0,
        totalPointsEarned: stats.totalPointsEarned || 0,
        streamersCount: stats.streamersCount || 0,
        lastActivity: stats.lastActivity || 0,
        lastOnlineStreamer: stats.lastOnlineStreamer || null,
        lastActivityLabel,
    };
}

/**
 * Обновляет значение с анимацией изменения
 * @param {string} elementId ID элемента
 * @param {number} newValue Новое значение
 * @param {number} oldValue Старое значение
 */
function updateValueWithAnimation(elementId, newValue, oldValue) {
    const root = getOverallStatsContainer();
    const element =
        (root && root.querySelector(`#${elementId}`)) || document.getElementById(elementId);
    if (!element) return;

    if (newValue !== oldValue) {
        // Определяем направление изменения
        const changeClass = newValue > oldValue ? 'positive' : 'negative';
        element.classList.add('value-change', changeClass);
        element.textContent = newValue.toLocaleString();
        
        setTimeout(() => {
            element.classList.remove('value-change', 'positive', 'negative');
        }, 500);
    } else {
        element.textContent = newValue.toLocaleString();
    }
}

let initializationPollCount = 0;

/**
 * Базовая метка для режима Event: после первого полного refresh не дергаем UI старыми событиями
 */
async function primeEventUpdateBaseline() {
    try {
        const response = await fetchData(`/events?limit=1&offset=0`);
        if (response?.events?.length > 0) {
            lastEventCheckTimestamp = response.events[0].timestamp;
        }
    } catch {
        // оставляем 0 — следующее событие вызовет updateAll
    }
}

/**
 * Ждёт полной инициализации бота и непустой статистики стримеров
 * @param {number} maxWaitMs Максимальное время ожидания
 * @returns {Promise<boolean>}
 */
async function waitForBotDashboardDataReady(maxWaitMs = 120_000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const status = await fetchData(`/initialization-status?_=${Date.now()}`);
        const initDone =
            status?.isInitialized === true || (Number(status?.progress) || 0) >= 100;
        if (initDone && status?.needsToken) {
            return true;
        }
        const stats = await fetchData(`/statistics?includeOffline=true&_=${Date.now()}`);
        if (initDone && Array.isArray(stats) && stats.length > 0) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

/**
 * Полное обновление дашборда после готовности бота (инициализация / перезагрузка страницы)
 */
async function onApplicationInitializationComplete() {
    if (applicationDataRefreshStarted) {
        return;
    }

    const dataReady = await waitForBotDashboardDataReady(120_000);
    if (!dataReady) {
        console.warn('Dashboard data not ready after timeout; refreshing with best effort');
    }

    applicationDataRefreshStarted = true;
    await updateAll();

    const shouldForceVersion = forceVersionRefreshOnReady;
    if (shouldForceVersion) {
        forceVersionRefreshOnReady = false;
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('vrefresh');
        window.history.replaceState({}, '', cleanUrl.toString());
    }
    await pollVersionUpdateStatus(shouldForceVersion);
    await updateBotHealth();

    if (updateMode === 'event') {
        await primeEventUpdateBaseline();
        checkForNewEvents();
    }
}

/**
 * Скрывает экран загрузки и показывает дашборд
 */
function hideLoadingScreen() {
    const loadingScreen = document.getElementById('loadingScreen');
    const mainContainer = document.getElementById('mainContainer');
    if (!loadingScreen || !mainContainer) {
        return;
    }
    loadingScreen.classList.add('hidden');
    mainContainer.style.display = 'block';
    void onApplicationInitializationComplete();
    setTimeout(() => {
        if (loadingScreen.parentNode) {
            loadingScreen.remove();
        }
    }, 500);
}

/**
 * Проверяет статус инициализации приложения
 */
async function checkInitializationStatus() {
    const loadingScreen = document.getElementById('loadingScreen');
    const mainContainer = document.getElementById('mainContainer');
    const statusText = document.getElementById('loadingStatusText');
    const progressBar = document.getElementById('loadingProgressBar');
    const progressText = document.getElementById('loadingProgressText');
    
    if (!loadingScreen || !mainContainer || !statusText || !progressBar || !progressText) {
        return;
    }

    initializationPollCount += 1;
    
    try {
        const response = await fetch(`${API_BASE}/initialization-status`);
        if (!response.ok) {
            if (response.status === 404) {
                statusText.textContent = 'Waiting for server to start...';
            } else {
                statusText.textContent = 'Waiting for server...';
            }
            setTimeout(checkInitializationStatus, 1000);
            return;
        }
        
        const status = await response.json();
        const progress = Number(status.progress) || 0;
        const isReady = status.isInitialized === true || progress >= 100;
        
        statusText.textContent = status.currentAction || 'Initializing...';
        progressBar.style.width = `${Math.min(100, progress)}%`;
        progressText.textContent = `${Math.round(Math.min(100, progress))}%`;
        
        if (isReady) {
            if (status.needsToken) {
                statusText.textContent = status.currentAction || 'Укажите токен в «Конфиг бота»';
            }
            setTimeout(() => {
                hideLoadingScreen();
                if (status.needsToken) {
                    showNotification('info', 'Откройте «Конфиг бота» в шапке и укажите auth-token');
                }
            }, 300);
            return;
        }

        setTimeout(checkInitializationStatus, 500);
    } catch (error) {
        statusText.textContent = 'Connecting to server...';
        setTimeout(checkInitializationStatus, 1000);
    }
}

/**
 * Сравнивает два значения с обработкой пустых значений
 * Пустые значения (null, undefined, пустая строка) всегда идут в конец списка
 * @param {*} valueA Первое значение
 * @param {*} valueB Второе значение
 * @param {Function} compareFn Функция сравнения для непустых значений (опционально)
 * @param {boolean} treatZeroAsEmpty Считать ли 0 пустым значением (по умолчанию false)
 * @returns {number} Результат сравнения (-1, 0, 1)
 */
function compareWithNulls(valueA, valueB, compareFn = null, treatZeroAsEmpty = false) {
    // Проверяем, являются ли значения пустыми
    let isEmptyA = valueA === null || valueA === undefined || valueA === '';
    let isEmptyB = valueB === null || valueB === undefined || valueB === '';
    
    // Для числовых значений проверяем NaN и, опционально, 0
    if (typeof valueA === 'number') {
        isEmptyA = isEmptyA || isNaN(valueA) || (treatZeroAsEmpty && valueA <= 0);
    }
    if (typeof valueB === 'number') {
        isEmptyB = isEmptyB || isNaN(valueB) || (treatZeroAsEmpty && valueB <= 0);
    }

    // Если оба пустые, они равны
    if (isEmptyA && isEmptyB) {
        return 0;
    }
    
    // Если только первое пустое, оно идет в конец
    if (isEmptyA) {
        return 1;
    }
    
    // Если только второе пустое, оно идет в конец
    if (isEmptyB) {
        return -1;
    }
    
    // Если оба не пустые, используем функцию сравнения или числовое сравнение
    if (compareFn) {
        return compareFn(valueA, valueB);
    }
    
    // По умолчанию числовое сравнение
    return Number(valueA) - Number(valueB);
}

/**
 * Сортирует данные таблицы по указанной колонке и направлению
 * @param {Array} data Массив данных для сортировки
 * @param {Object} sort Объект с полями column и direction
 * @returns {Array} Отсортированный массив
 */
function sortTableData(data, sort) {
    if (!sort.column) {
        const result = data.sort((a, b) => {
            if (a.status === 'ONLINE' && b.status === 'OFFLINE') return -1;
            if (a.status === 'OFFLINE' && b.status === 'ONLINE') return 1;
            return a.streamerName.localeCompare(b.streamerName);
        });
        return result;
    }

    const direction = sort.direction === 'desc' ? -1 : 1;

    const result = data.sort((a, b) => {
        if (a.status === 'ONLINE' && b.status === 'OFFLINE') return -1;
        if (a.status === 'OFFLINE' && b.status === 'ONLINE') return 1;
        
        let valueA, valueB, treatZeroAsEmpty = false;
        
        switch (sort.column) {
            case 'streamer':
                valueA = a.streamerName;
                valueB = b.streamerName;
                break;
            case 'lastStreamStart':
                valueA = a.lastStreamStart ? Number(a.lastStreamStart) : null;
                valueB = b.lastStreamStart ? Number(b.lastStreamStart) : null;
                treatZeroAsEmpty = true;
                break;
            case 'lastStreamEnd':
                valueA = a.lastStreamEnd ? Number(a.lastStreamEnd) : null;
                valueB = b.lastStreamEnd ? Number(b.lastStreamEnd) : null;
                treatZeroAsEmpty = true;
                break;
            case 'lastStreamDuration':
                valueA = resolveLastStreamDurationMs(a);
                valueB = resolveLastStreamDurationMs(b);
                treatZeroAsEmpty = true;
                break;
            case 'game':
                valueA = a.game;
                valueB = b.game;
                break;
            case 'watchTime':
                valueA = a.elapsedTime;
                valueB = b.elapsedTime;
                break;
            case 'pointsEarned':
                valueA = a.pointsEarned;
                valueB = b.pointsEarned;
                break;
            case 'currentPoints':
                valueA = a.currentPoints;
                valueB = b.currentPoints;
                break;
            case 'streamsLast30Days':
                valueA = getStreamerStreamCount(a);
                valueB = getStreamerStreamCount(b);
                break;
            case 'viewersCount':
                valueA = a.viewersCount != null ? Number(a.viewersCount) : null;
                valueB = b.viewersCount != null ? Number(b.viewersCount) : null;
                break;
            case 'status':
                valueA = a.status;
                valueB = b.status;
                break;
            default:
                valueA = a.streamerName;
                valueB = b.streamerName;
                break;
        }

        let isEmptyA = valueA === null || valueA === undefined || valueA === '';
        let isEmptyB = valueB === null || valueB === undefined || valueB === '';
        
        if (typeof valueA === 'number') {
            isEmptyA = isEmptyA || isNaN(valueA) || (treatZeroAsEmpty && valueA <= 0);
        }
        if (typeof valueB === 'number') {
            isEmptyB = isEmptyB || isNaN(valueB) || (treatZeroAsEmpty && valueB <= 0);
        }

        if (isEmptyA && isEmptyB) return 0;
        if (isEmptyA) return 1;
        if (isEmptyB) return -1;

        let comparison = 0;
        
        switch (sort.column) {
            case 'streamer':
                comparison = valueA.localeCompare(valueB);
                break;
            case 'lastStreamStart':
            case 'lastStreamEnd':
            case 'lastStreamDuration':
                comparison = Number(valueA) - Number(valueB);
                break;
            case 'game':
                comparison = valueA.localeCompare(valueB);
                break;
            case 'watchTime':
            case 'pointsEarned':
            case 'currentPoints':
            case 'streamsLast30Days':
            case 'viewersCount':
                comparison = Number(valueA) - Number(valueB);
                break;
            case 'status':
                const statusOrder = { 'ONLINE': 0, 'OFFLINE': 1 };
                comparison = (statusOrder[valueA] || 2) - (statusOrder[valueB] || 2);
                break;
        }

        return comparison * direction;
    });

    return result;
}

/**
 * Обработчик клика на заголовок таблицы для сортировки
 * @param {string} column Ключ колонки для сортировки
 */
window.handleTableSort = function(column) {
    // Определяем, является ли колонка временной (для временных колонок начальное направление - desc)
    const isTimeColumn =
        column === 'lastStreamStart' || column === 'lastStreamEnd' || column === 'lastStreamDuration';
    const isNumericDescDefault = isTimeColumn || column === 'streamsLast30Days' || column === 'viewersCount';
    
    // Если кликнули на ту же колонку, меняем направление сортировки
    if (tableSort.column === column) {
        tableSort.direction = tableSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        // Если кликнули на другую колонку, устанавливаем новую колонку и направление по умолчанию
        tableSort.column = column;
        // Для временных колонок начальное направление - desc, для остальных - asc
        tableSort.direction = isNumericDescDefault ? 'desc' : 'asc';
    }

    // Сохраняем настройки сортировки в localStorage
    safeSetLocalStorage('tableSort', JSON.stringify(tableSort));

    // Обновляем таблицу
    updateStatistics();
};

async function updateStatistics(options = {}) {
    const skipFetch = options.skipFetch === true;
    hideCategoryStreamStatsMenu();
    hideStreamSessionsMenu();
    const table = document.getElementById('watchesTable');
    const hasContent = table && table.querySelector('table');
    const hasSkeleton = table && table.querySelector('.skeleton-table');
    
    // Показываем skeleton только при первой загрузке (когда нет контента и нет skeleton)
    if (!skipFetch && !hasContent && !hasSkeleton && table) {
        table.innerHTML = generateTableSkeleton(5);
    }
    
    let stats;
    if (skipFetch && cachedStatisticsRows) {
        stats = cachedStatisticsRows;
    } else {
        stats = await fetchData('/statistics?includeOffline=true');
        if (stats) {
            cachedStatisticsRows = stats;
        }
    }
    
    if (!stats) {
        // Если был skeleton, заменяем на сообщение об ошибке
        if (table && table.querySelector('.skeleton-table')) {
            table.innerHTML = '<p style="color: #adadb8; text-align: center; padding: 20px;">Failed to load statistics</p>';
        }
        return;
    }

    if (stats.length === 0) {
        lastAllStreamerNames = [];
        const emptyMessage = '<p style="color: #adadb8; text-align: center; padding: 20px;">No streamers configured</p>';
        if (table && table.querySelector('.skeleton-table')) {
            replaceSkeletonWithContent(table, emptyMessage);
        } else {
            table.innerHTML = emptyMessage;
        }
        streamStatusTrackingReady = false;
        previousStreamerStatus = {};
        return;
    }

    lastAllStreamerNames = stats.map((s) => s.streamerName).filter(Boolean);

    if (!skipFetch) {
        try {
            const statusChanges = detectStreamerStatusChanges(stats);
            if (statusChanges.length > 0) {
                processStreamStatusNotifications(statusChanges);
            }
        } catch (e) {
            console.warn('Stream status notifications failed:', e);
        }
    }

    // Фильтруем офлайн стримеров, если они скрыты
    let filteredStats = stats;
    if (!showOffline) {
        filteredStats = stats.filter(s => s.status === 'ONLINE');
    }

    // Разница в скобках: только между прошлым и текущим обновлением (Event / interval)
    const currentPreviousStats = {};
    stats.forEach((s) => {
        if (!s.streamerName) {
            return;
        }
        const snap = lastUpdatePointsSnapshot[s.streamerName];
        if (!snap) {
            return;
        }
        const currentPointsEarned = s.pointsEarned || 0;
        const currentCurrentPoints = s.currentPoints || 0;
        const currentViewersCount =
            s.viewersCount != null && !Number.isNaN(Number(s.viewersCount))
                ? Number(s.viewersCount)
                : null;
        const entry = {};
        if (snap.pointsEarned !== currentPointsEarned) {
            entry.pointsEarned = snap.pointsEarned;
        }
        if (snap.currentPoints !== currentCurrentPoints) {
            entry.currentPoints = snap.currentPoints;
        }
        if (snap.viewersCount !== currentViewersCount) {
            entry.viewersCount = snap.viewersCount;
        }
        if (
            entry.pointsEarned !== undefined ||
            entry.currentPoints !== undefined ||
            entry.viewersCount !== undefined
        ) {
            currentPreviousStats[s.streamerName] = entry;
        }
    });
    
    // Сортируем данные
    const sortedStats = sortTableData([...filteredStats], tableSort);

    // Если офлайн стримеры скрыты и нет онлайн стримеров, показываем сообщение
    if (!showOffline && sortedStats.length === 0) {
        const offlineMessage = '<p style="color: #adadb8; text-align: center; padding: 20px;">No streamers are currently online</p>';
        if (table && table.querySelector('.skeleton-table')) {
            replaceSkeletonWithContent(table, offlineMessage);
        } else {
            table.classList.add('updating');
            table.innerHTML = offlineMessage;
            setTimeout(() => table.classList.remove('updating'), 300);
        }
        lastDataUpdate.stats = Date.now();
        updateStaleDataIndicator('stats', table);
        return;
    }

    // Определяем колонки с их видимостью
    const allNotifyOn = areAllStreamerNotificationsEnabled(lastAllStreamerNames);
    const notifyHeaderTitle = allNotifyOn
        ? 'Выключить оповещения у всех стримеров'
        : 'Включить оповещения у всех стримеров';
    const columns = [
        { key: 'notify', label: allNotifyOn ? '🔔' : '🔕', visible: visibleColumns.notify !== false },
        { key: 'streamer', label: 'Streamer', visible: visibleColumns.streamer !== false },
        { key: 'status', label: 'Status', visible: visibleColumns.status !== false },
        { key: 'watchTime', label: 'Watch Time', visible: visibleColumns.watchTime !== false },
        { key: 'pointsEarned', label: 'Points Earned', visible: visibleColumns.pointsEarned !== false },
        { key: 'currentPoints', label: 'Current Points', visible: visibleColumns.currentPoints !== false },
        { key: 'game', label: 'Category', visible: visibleColumns.game !== false },
        {
            key: 'streamsLast30Days',
            label: getStreamsCountColumnLabel(),
            visible: visibleColumns.streamsLast30Days !== false,
        },
        {
            key: 'viewersCount',
            label: 'Viewers',
            visible: visibleColumns.viewersCount !== false,
        },
        { key: 'lastStreamStart', label: 'Last Stream Start', visible: visibleColumns.lastStreamStart !== false },
        { key: 'lastStreamEnd', label: 'Last Stream End', visible: visibleColumns.lastStreamEnd !== false },
        {
            key: 'lastStreamDuration',
            label: 'Last Stream Duration',
            visible: visibleColumns.lastStreamDuration !== false,
        },
        { key: 'actions', label: 'Actions', visible: visibleColumns.actions !== false }
    ];
    
    const visibleColumnsList = columns.filter(c => c.visible);
    
    const tableContent = `
        <table>
            <thead>
                <tr>
                    ${visibleColumnsList.map(col => {
                        // Определяем, можно ли сортировать эту колонку
                        const isSortable = ['streamer', 'streamsLast30Days', 'viewersCount', 'lastStreamStart', 'lastStreamEnd', 'lastStreamDuration'].includes(col.key);
                        const isSorted = tableSort.column === col.key;
                        const sortIcon = isSorted 
                            ? (tableSort.direction === 'asc' ? ' ▲' : ' ▼')
                            : (isSortable ? ' ↕' : '');
                        const sortClass = isSorted ? ` sort-${tableSort.direction}` : '';
                        const clickHandler = col.key === 'notify'
                            ? ' onclick="toggleAllStreamerNotifications()"'
                            : (isSortable ? ` onclick="handleTableSort('${col.key}')"` : '');
                        const cursorStyle = col.key === 'streamsLast30Days'
                            ? ' style="cursor: context-menu; user-select: none;"'
                            : ((col.key === 'notify' || isSortable)
                                ? ' style="cursor: pointer; user-select: none;"'
                                : '');
                        const notifyClass = col.key === 'notify' ? ' notify-header notify-header-clickable' : '';
                        const notifyTitle = col.key === 'notify' ? ` title="${notifyHeaderTitle}"` : '';
                        const streamsHeaderClass =
                            col.key === 'streamsLast30Days' ? ' streams-count-header' : '';
                        const streamsHeaderTitle =
                            col.key === 'streamsLast30Days'
                                ? ' title="Правый клик — выбрать период (7d / 14d / 30d / 60d)"'
                                : '';
                        const categoryHeaderClass = col.key === 'game' ? ' category-column-header' : '';
                        
                        return `<th class="table-header${notifyClass}${streamsHeaderClass}${categoryHeaderClass}${isSortable ? ' sortable' : ''}${sortClass}"${clickHandler}${cursorStyle}${notifyTitle}${streamsHeaderTitle}>${col.label}${sortIcon}</th>`;
                    }).join('')}
                </tr>
            </thead>
            <tbody>
                ${sortedStats.map(s => `
                    <tr>
                        ${visibleColumns.notify !== false ? (() => {
                            const notifyOn = isStreamerNotifyEnabled(s.streamerName);
                            const safeAttr = String(s.streamerName)
                                .replace(/&/g, '&amp;')
                                .replace(/"/g, '&quot;');
                            return `<td class="notify-cell">
                                <span role="button" tabindex="0"
                                    class="streamer-notify-toggle ${notifyOn ? 'streamer-notify-on' : 'streamer-notify-off'}"
                                    data-streamer="${safeAttr}"
                                    onclick="toggleStreamerNotify(this)"
                                    onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleStreamerNotify(this);}"
                                    title="${notifyOn ? 'Уведомления включены' : 'Уведомления выключены'}">${notifyOn ? '🔔' : '🔕'}</span>
                            </td>`;
                        })() : ''}
                        ${visibleColumns.streamer !== false ? (() => {
                            const streamerColor = colorizeStreamerNames ? generateColorFromString(s.streamerName) : null;
                            const colorStyle = streamerColor ? `style="color: ${streamerColor};"` : '';
                            return `<td class="streamer-name"><a href="https://www.twitch.tv/${s.streamerName}" target="_blank" rel="noopener noreferrer" class="streamer-link" ${colorStyle}>${s.streamerName}</a></td>`;
                        })() : ''}
                        ${visibleColumns.status !== false ? `
                            <td>
                                <span class="status-badge ${s.status === 'ONLINE' ? 'online' : 'offline'}">
                                    <span class="status-indicator ${s.status === 'ONLINE' ? 'status-online' : 'status-offline'}"></span>
                                    ${s.status}
                                </span>
                            </td>
                        ` : ''}
                        ${visibleColumns.watchTime !== false ? `<td>${generateWatchTimeProgress(s.elapsedTime)}</td>` : ''}
                        ${visibleColumns.pointsEarned !== false ? (() => {
                            const prevPointsEarned = currentPreviousStats[s.streamerName]?.pointsEarned;
                            const currentPointsEarned = s.pointsEarned || 0;
                            return `<td>${generatePointsBadgeWithDiff(currentPointsEarned, prevPointsEarned)}</td>`;
                        })() : ''}
                        ${visibleColumns.currentPoints !== false ? (() => {
                            const prevCurrentPoints = currentPreviousStats[s.streamerName]?.currentPoints;
                            const currentCurrentPoints = s.currentPoints || 0;
                            return `<td>${generatePointsBadgeWithDiff(currentCurrentPoints, prevCurrentPoints)}</td>`;
                        })() : ''}
                        ${visibleColumns.game !== false ? renderStreamerCategoryCell(s) : ''}
                        ${visibleColumns.streamsLast30Days !== false ? renderStreamerStreamsCell(s) : ''}
                        ${visibleColumns.viewersCount !== false ? (() => {
                            const prevViewersCount = currentPreviousStats[s.streamerName]?.viewersCount;
                            return `<td>${formatViewerCountWithDiff(s.viewersCount, prevViewersCount)}</td>`;
                        })() : ''}
                        ${visibleColumns.lastStreamStart !== false ? `<td>${s.lastStreamStart ? formatTimeWithColors(s.lastStreamStart, '#00d166') : '-'}</td>` : ''}
                        ${visibleColumns.lastStreamEnd !== false ? (() => {
                            const endTime = s.lastStreamEnd;
                            const startTime = s.lastStreamStart;
                            
                            // Если нет времени окончания, показываем прочерк
                            if (!endTime) return '<td>-</td>';
                            
                            const end = Number(endTime);
                            if (isNaN(end) || end <= 0) return '<td>-</td>';
                            
                            // Если есть время окончания, но нет времени начала, показываем полупрозрачным
                            if (!startTime) {
                                return `<td class="invalid-time">${formatTimeWithColors(endTime, '#ef4444')}</td>`;
                            }
                            
                            const start = Number(startTime);
                            if (isNaN(start) || start <= 0) {
                                // Если время начала некорректное, но есть время окончания, показываем полупрозрачным
                                return `<td class="invalid-time">${formatTimeWithColors(endTime, '#ef4444')}</td>`;
                            }
                            
                            // Если время окончания меньше времени начала (некорректное состояние), показываем полупрозрачным
                            if (end < start) {
                                return `<td class="invalid-time">${formatTimeWithColors(endTime, '#ef4444')}</td>`;
                            }
                            
                            // Все корректно - показываем с красным временем
                            return `<td>${formatTimeWithColors(endTime, '#ef4444')}</td>`;
                        })() : ''}
                        ${visibleColumns.lastStreamDuration !== false ? (() => {
                            const durationMs = resolveLastStreamDurationMs(s);
                            if (durationMs == null) {
                                return '<td>-</td>';
                            }
                            return `<td title="Последний завершённый стрим">${formatTime(durationMs)}</td>`;
                        })() : ''}
                        ${visibleColumns.actions !== false ? `
                            <td>
                                <button onclick="removeStreamer('${s.streamerName}')" 
                                        class="remove-btn" 
                                        style="padding: 4px 12px; background: #ef4444; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;"
                                        title="Remove streamer">
                                    Remove
                                </button>
                            </td>
                        ` : ''}
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    // Если был skeleton, заменяем плавно, иначе обычное обновление
    if (table && table.querySelector('.skeleton-table')) {
        replaceSkeletonWithContent(table, tableContent);
    } else {
        table.classList.add('updating');
        table.innerHTML = tableContent;
        setTimeout(() => table.classList.remove('updating'), 300);
    }
    
    lastDataUpdate.stats = Date.now();
    updateStaleDataIndicator('stats', table);

    const nextSnapshot = {};
    stats.forEach((s) => {
        if (s.streamerName) {
            nextSnapshot[s.streamerName] = {
                pointsEarned: s.pointsEarned || 0,
                currentPoints: s.currentPoints || 0,
                viewersCount:
                    s.viewersCount != null && !Number.isNaN(Number(s.viewersCount))
                        ? Number(s.viewersCount)
                        : null,
            };
        }
    });
    lastUpdatePointsSnapshot = nextSnapshot;
}


// Timestamp последнего обновления данных
let lastDataUpdate = {
    stats: 0,
    overall: 0
};

const STALE_DATA_THRESHOLD = 30000; // 30 секунд

/**
 * Помечает контейнер, если данные давно не обновлялись
 * @param {'stats'|'overall'} key Ключ в lastDataUpdate
 * @param {Element|null} container DOM-контейнер
 */
function updateStaleDataIndicator(key, container) {
    if (!container) {
        return;
    }
    const ts = lastDataUpdate[key] || 0;
    const stale = ts > 0 && Date.now() - ts > STALE_DATA_THRESHOLD;
    container.classList.toggle('stale-data', stale);
}

// Настройки приложения
const defaultSettings = {
    fontSize: 'medium',
    density: 'normal',
    showToastNotifications: true,
    osNotifications: false,
    soundNotifications: false
};

/** @type {AudioContext | null} */
let notificationAudioContext = null;

/**
 * Загружает настройки из localStorage
 */
function loadSettings() {
    const saved = safeGetLocalStorage('appSettings');
    if (saved) {
        try {
            return { ...defaultSettings, ...JSON.parse(saved) };
        } catch (e) {
            console.error('Error loading settings:', e);
        }
    }
    return { ...defaultSettings };
}

/**
 * Сохраняет настройки в localStorage
 */
function saveSettingsToStorage(settings) {
    safeSetLocalStorage('appSettings', JSON.stringify(settings));
}

/**
 * Применяет настройки к интерфейсу
 */
function applySettings(settings) {
    if (!settings) return;
    // Размер шрифта
    document.documentElement.style.setProperty('--font-size', 
        settings.fontSize === 'small' ? '12px' : 
        settings.fontSize === 'large' ? '16px' : '14px');
    
    // Плотность
    if (document.body) {
        document.body.className = document.body.className.replace(/density-\w+/g, '');
        document.body.classList.add(`density-${settings.density}`);
    }
    
    // Количество событий на странице
}

/**
 * Обновляет список доступных тегов из событий
 * @param events Массив событий
 */
function escapeHtml(text) {
    if (text == null) {
        return '';
    }
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

/**
 * Включены ли уведомления для стримера (online/offline)
 */
function isStreamerNotifyEnabled(streamerName) {
    if (!streamerName) {
        return true;
    }
    const key = streamerName.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(streamerNotifyPrefs, key)) {
        return streamerNotifyPrefs[key] !== false;
    }
    return true;
}

/**
 * Сохраняет настройку уведомлений для стримера
 */
function setStreamerNotifyEnabled(streamerName, enabled) {
    const key = streamerName.toLowerCase();
    streamerNotifyPrefs[key] = enabled;
    safeSetLocalStorage('streamerNotifyPrefs', JSON.stringify(streamerNotifyPrefs));
}

/**
 * Проверяет, включены ли уведомления у всех указанных стримеров
 */
function areAllStreamerNotificationsEnabled(streamerNames) {
    if (!streamerNames?.length) {
        return true;
    }
    return streamerNames.every((name) => isStreamerNotifyEnabled(name));
}

/**
 * Включает или выключает уведомления у всех стримеров (клик по заголовку колонки)
 */
function toggleAllStreamerNotifications() {
    if (!lastAllStreamerNames.length) {
        return;
    }

    const enableAll = !areAllStreamerNotificationsEnabled(lastAllStreamerNames);
    lastAllStreamerNames.forEach((name) => setStreamerNotifyEnabled(name, enableAll));
    updateStatistics();
}

/**
 * Переключает уведомления для стримера (кнопка в таблице)
 */
function toggleStreamerNotify(buttonEl) {
    const streamerName = buttonEl?.dataset?.streamer;
    if (!streamerName) {
        return;
    }
    const next = !isStreamerNotifyEnabled(streamerName);
    setStreamerNotifyEnabled(streamerName, next);
    updateStreamerNotifyButton(buttonEl, next);
}

/**
 * Обновляет вид кнопки уведомлений в таблице
 */
function updateStreamerNotifyButton(buttonEl, enabled) {
    if (!buttonEl) {
        return;
    }
    buttonEl.classList.toggle('streamer-notify-off', !enabled);
    buttonEl.classList.toggle('streamer-notify-on', enabled);
    buttonEl.textContent = enabled ? '🔔' : '🔕';
    buttonEl.title = enabled
        ? 'Уведомления при старте/остановке стрима включены'
        : 'Уведомления при старте/остановке стрима выключены';
}

/** Время последнего предупреждения о разрешении ОС (чтобы не дублировать toast) */
let lastOsPermissionWarningAt = 0;

/**
 * Проверяет, доступны ли Web Notifications в текущем контексте страницы
 * @returns {{ ok: boolean, reason?: string, message?: string }}
 */
function getOsNotificationAvailability() {
    if (!('Notification' in window)) {
        return {
            ok: false,
            reason: 'unsupported',
            message: 'Браузер не поддерживает уведомления ОС',
        };
    }
    if (!window.isSecureContext) {
        const host = window.location.hostname;
        const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
        if (!isLocalHost) {
            return {
                ok: false,
                reason: 'insecure',
                message: 'Уведомления ОС недоступны по HTTP с IP-адреса (например http://192.168.x.x). '
                    + 'Включите HTTPS в «Конфиг бота» на сервере и откройте https://IP:3001, '
                    + 'или используйте http://localhost:3001 через SSH-туннель.',
            };
        }
    }
    return { ok: true, permission: Notification.permission };
}

/**
 * Показывает предупреждение о разрешении ОС без дублей подряд
 */
function showOsPermissionWarning(message) {
    const now = Date.now();
    if (now - lastOsPermissionWarningAt < 2500) {
        return;
    }
    lastOsPermissionWarningAt = now;
    showNotification('warning', message);
}

/**
 * Запрашивает разрешение на уведомления ОС
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
async function ensureOsNotificationPermission() {
    const availability = getOsNotificationAvailability();
    if (!availability.ok) {
        return { ok: false, message: availability.message };
    }

    if (Notification.permission === 'granted') {
        return { ok: true };
    }

    if (Notification.permission === 'denied') {
        return {
            ok: false,
            message: 'Уведомления для этого сайта заблокированы. '
                + 'Замок слева от адреса → Уведомления → «Разрешить», затем обновите страницу (F5).',
        };
    }

    try {
        const result = await Notification.requestPermission();
        if (result === 'granted' || Notification.permission === 'granted') {
            return { ok: true };
        }
    } catch (e) {
        console.warn('Notification.requestPermission failed:', e);
    }

    if (Notification.permission === 'denied') {
        return {
            ok: false,
            message: 'Уведомления заблокированы. Разрешите их в настройках сайта и обновите страницу (F5).',
        };
    }

    return {
        ok: false,
        message: 'Разрешите уведомления во всплывающем запросе браузера или в настройках сайта (замок в адресной строке).',
    };
}

/**
 * Запрашивает разрешение на уведомления ОС (совместимость)
 */
async function requestOsNotificationPermission() {
    const result = await ensureOsNotificationPermission();
    return result.ok;
}

/**
 * Воспроизводит короткий звук уведомления
 */
function playNotificationSound(isOnline) {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
            return;
        }
        if (!notificationAudioContext) {
            notificationAudioContext = new AudioCtx();
        }
        const ctx = notificationAudioContext;
        if (ctx.state === 'suspended') {
            ctx.resume();
        }
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = isOnline ? 880 : 440;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.2);
    } catch (e) {
        console.warn('Notification sound failed:', e);
    }
}

/** Имя стримера для тестовых уведомлений */
const NOTIFICATION_TEST_STREAMER = 'TestStreamer';

/**
 * Показывает toast для смены статуса стрима
 */
function showStreamToast(isOnline, streamerName) {
    const settings = loadSettings();
    if (!settings.showToastNotifications) {
        return;
    }
    const type = isOnline ? 'stream-up' : 'stream-down';
    const message = isOnline
        ? `${streamerName} — начал стрим`
        : `${streamerName} — завершил стрим`;
    showNotification(type, message, 6000);
}

/**
 * Параметры ОС-уведомления (уникальный tag — иначе Windows заменяет без нового toast)
 */
function buildOsNotificationOptions(streamerName, isOnline) {
    const safeName = String(streamerName || 'unknown').toLowerCase();
    return {
        body: isOnline
            ? `${streamerName} начал трансляцию`
            : `${streamerName} завершил трансляцию`,
        tag: `tw-${safeName}-${isOnline ? 'up' : 'down'}-${Date.now()}`,
        renotify: true,
        silent: false,
    };
}

/**
 * Показывает системное уведомление браузера
 * @param {number} delayMs задержка (для пачки уведомлений под Windows)
 */
function showStreamOsNotification(isOnline, streamerName, delayMs = 0) {
    const settings = loadSettings();
    if (!settings.osNotifications || !('Notification' in window)) {
        return;
    }
    if (Notification.permission !== 'granted') {
        return;
    }
    const title = isOnline ? '📺 Стрим онлайн' : '📴 Стрим офлайн';
    const options = buildOsNotificationOptions(streamerName, isOnline);

    const fire = () => {
        try {
            new Notification(title, options);
        } catch (e) {
            console.warn('OS notification failed:', e);
        }
    };

    if (delayMs > 0) {
        setTimeout(fire, delayMs);
    } else {
        fire();
    }
}

/**
 * Обрабатывает уведомления о смене статуса стрима
 * @param {Array<{streamer: string, type: string}>} items
 */
function processStreamStatusNotifications(items) {
    if (!items || items.length === 0) {
        return;
    }
    const settings = loadSettings();
    const anyChannelEnabled = settings.showToastNotifications
        || settings.osNotifications
        || settings.soundNotifications;
    if (!anyChannelEnabled) {
        return;
    }

    items.forEach((item, index) => {
        const streamerName = item.streamer || item.streamerName;
        if (!streamerName || !isStreamerNotifyEnabled(streamerName)) {
            return;
        }
        const isOnline = item.type === 'stream-up';
        const osDelayMs = index * 400;
        showStreamToast(isOnline, streamerName);
        showStreamOsNotification(isOnline, streamerName, osDelayMs);
        if (settings.soundNotifications) {
            if (osDelayMs > 0) {
                setTimeout(() => playNotificationSound(isOnline), osDelayMs);
            } else {
                playNotificationSound(isOnline);
            }
        }
    });
}

/**
 * Сравнивает статистику и возвращает смены ONLINE/OFFLINE
 */
function detectStreamerStatusChanges(stats) {
    const changes = [];
    if (!stats || !Array.isArray(stats)) {
        return changes;
    }

    if (!streamStatusTrackingReady) {
        stats.forEach((s) => {
            if (s.streamerName) {
                previousStreamerStatus[s.streamerName] = s.status;
            }
        });
        streamStatusTrackingReady = true;
        return changes;
    }

    stats.forEach((s) => {
        const name = s.streamerName;
        if (!name) {
            return;
        }
        const prev = previousStreamerStatus[name];
        const current = s.status;
        if (prev && prev !== current) {
            if (current === 'ONLINE') {
                changes.push({ streamer: name, type: 'stream-up' });
            } else if (current === 'OFFLINE') {
                changes.push({ streamer: name, type: 'stream-down' });
            }
        }
        previousStreamerStatus[name] = current;
    });

    return changes;
}

/**
 * Группирует события по дням
 * @param events Массив событий
 * @returns Map с ключами-днями (timestamp начала дня) и массивами событий
 */
async function updateTokenInfo() {
    const tokenInfo = await fetchData('/token-info');
    if (!tokenInfo) return;

    const section = document.getElementById('tokenInfoSection');
    const content = document.getElementById('tokenInfoContent');
    
    if (!section || !content) return;

    // Показываем секцию только если информация доступна
    section.style.display = 'block';

    const now = Date.now();
    let statusText = '';
    let statusColor = '#adadb8';
    let expiresText = 'Unknown';

    if (tokenInfo.status === 'expired') {
        statusText = 'Expired';
        statusColor = '#ef4444';
        expiresText = 'Token has expired';
    } else if (tokenInfo.status === 'invalid') {
        statusText = 'Invalid';
        statusColor = '#ef4444';
        expiresText = 'Token is invalid';
    } else if (tokenInfo.status === 'unknown') {
        statusText = 'Unknown';
        statusColor = '#adadb8';
        expiresText = 'Token status unknown';
    } else if (tokenInfo.expiresAt) {
        statusText = 'Valid';
        statusColor = '#00d166';
        
        if (tokenInfo.daysRemaining > 0) {
            expiresText = `${tokenInfo.daysRemaining} day(s)`;
        } else if (tokenInfo.hoursRemaining > 0) {
            expiresText = `${tokenInfo.hoursRemaining} hour(s)`;
        } else if (tokenInfo.minutesRemaining > 0) {
            expiresText = `${tokenInfo.minutesRemaining} minute(s)`;
            // Если меньше часа - предупреждение
            if (tokenInfo.minutesRemaining < 60) {
                statusColor = '#f59e0b';
            }
        } else {
            expiresText = 'Expired';
            statusColor = '#ef4444';
        }
    } else {
        statusText = 'Valid (no expiration)';
        statusColor = '#00d166';
        expiresText = 'Token does not expire';
    }

    const expiresDate = tokenInfo.expiresAt ? new Date(tokenInfo.expiresAt).toLocaleString('ru-RU') : 'N/A';

    content.innerHTML = `
        <div style="background: #18181b; padding: 15px; border-radius: 6px; border: 1px solid #26262c;">
            <div style="color: #adadb8; font-size: 12px; margin-bottom: 5px;">Status</div>
            <div style="color: ${statusColor}; font-size: 18px; font-weight: 600;">${statusText}</div>
        </div>
        <div style="background: #18181b; padding: 15px; border-radius: 6px; border: 1px solid #26262c;">
            <div style="color: #adadb8; font-size: 12px; margin-bottom: 5px;">Time Remaining</div>
            <div style="color: #efeff1; font-size: 18px; font-weight: 600;">${expiresText}</div>
        </div>
        ${tokenInfo.expiresAt ? `
        <div style="background: #18181b; padding: 15px; border-radius: 6px; border: 1px solid #26262c;">
            <div style="color: #adadb8; font-size: 12px; margin-bottom: 5px;">Expires At</div>
            <div style="color: #efeff1; font-size: 14px;">${expiresDate}</div>
        </div>
        ` : ''}
        ${tokenInfo.tokenInfo ? `
        <div style="background: #18181b; padding: 15px; border-radius: 6px; border: 1px solid #26262c;">
            <div style="color: #adadb8; font-size: 12px; margin-bottom: 5px;">User ID</div>
            <div style="color: #efeff1; font-size: 14px; font-family: monospace;">${tokenInfo.tokenInfo.user_id || 'N/A'}</div>
        </div>
        ` : ''}
    `;
}

async function updateDatabaseInfo() {
    const dbStatus = await fetchData('/database-status');
    if (!dbStatus) return;

    const section = document.getElementById('databaseInfoSection');
    const content = document.getElementById('databaseInfoContent');
    
    if (!section || !content) return;

    // Показываем секцию всегда
    section.style.display = 'block';

    let statusText = '';
    let statusColor = '#adadb8';
    let reasonText = 'Unknown';

    if (dbStatus.ready) {
        statusText = 'Active';
        statusColor = '#00d166';
        reasonText = 'Database is ready and operational';
    } else if (dbStatus.available) {
        statusText = 'Unavailable';
        statusColor = '#f59e0b';
        reasonText = dbStatus.reason || dbStatus.error || 'Database not ready';
    } else {
        statusText = 'Not Initialized';
        statusColor = '#adadb8';
        reasonText = dbStatus.reason || 'Database storage not initialized';
    }

    content.innerHTML = `
        <div style="background: #18181b; padding: 15px; border-radius: 6px; border: 1px solid #26262c;">
            <div style="color: #adadb8; font-size: 12px; margin-bottom: 5px;">Status</div>
            <div style="color: ${statusColor}; font-size: 18px; font-weight: 600;">${statusText}</div>
        </div>
        <div style="background: #18181b; padding: 15px; border-radius: 6px; border: 1px solid #26262c;">
            <div style="color: #adadb8; font-size: 12px; margin-bottom: 5px;">Reason</div>
            <div style="color: #efeff1; font-size: 14px;">${reasonText}</div>
        </div>
        ${dbStatus.dbPath ? `
        <div style="background: #18181b; padding: 15px; border-radius: 6px; border: 1px solid #26262c;">
            <div style="color: #adadb8; font-size: 12px; margin-bottom: 5px;">Database Path</div>
            <div style="color: #efeff1; font-size: 12px; font-family: monospace; word-break: break-all;">${dbStatus.dbPath}</div>
        </div>
        ` : ''}
        ${!dbStatus.ready ? `
        <div style="background: #1a1a1f; padding: 15px; border-radius: 6px; border: 1px solid #26262c; grid-column: 1 / -1;">
            <div style="color: #adadb8; font-size: 12px; margin-bottom: 8px;">ℹ️ Note</div>
            <div style="color: #adadb8; font-size: 13px; line-height: 1.5;">
                Database features are optional. The application will continue to work using file-based storage (StatisticsStorage) if the database is not available. The application uses sql.js (WebAssembly-based SQLite) which works on all platforms including Android without requiring compilation.
            </div>
        </div>
        ` : ''}
    `;
}

/**
 * Показывает индикатор загрузки
 */
function showLoadingIndicator() {
    const indicator = document.getElementById('loadingIndicator');
    if (indicator) {
        indicator.style.display = 'flex';
    }
}

/**
 * Скрывает индикатор загрузки
 */
function hideLoadingIndicator() {
    const indicator = document.getElementById('loadingIndicator');
    if (indicator) {
        indicator.style.display = 'none';
    }
}

async function updateAll() {
    showLoadingIndicator();
    try {
        await Promise.all([
            updateOverallStats(),
            updateStatistics(),
            updateBotHealth(),
            updateCriticalNotifications(),
            updateTokenInfo(),
            updateDatabaseInfo()
        ]);
    } finally {
        hideLoadingIndicator();
    }
}

async function updateCriticalNotifications() {
    const notifications = await fetchData('/critical-notifications');
    if (!notifications) return;

    const container = document.getElementById('criticalNotifications');
    if (!container) return;

    if (notifications.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    container.innerHTML = notifications.map(notif => `
        <div class="critical-notification ${notif.type}" data-id="${notif.id}">
            <div class="critical-notification-content">
                <div class="critical-notification-title">
                    ${notif.type === 'error' ? '❌' : '⚠️'}
                    ${notif.title}
                </div>
                <div class="critical-notification-message">
                    ${notif.message}
                </div>
            </div>
            <button class="critical-notification-dismiss" onclick="dismissNotification('${notif.id}')" title="Dismiss">
                ×
            </button>
        </div>
    `).join('');
}

async function dismissNotification(id) {
    try {
        const response = await fetch(`${API_BASE}/critical-notifications/${id}/dismiss`, {
            method: 'POST',
        });
        if (response.ok) {
            updateCriticalNotifications();
        }
    } catch (error) {
        console.error('Error dismissing notification:', error);
    }
}

function setUpdateInterval(seconds) {
    // Останавливаем текущее интервальное обновление (SSE остаётся активным)
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
    
    if (seconds === 'event') {
        // Режим обновления по событию
        updateMode = 'event';
        safeSetLocalStorage('updateMode', 'event');
        
        // Обновляем активную кнопку
        document.querySelectorAll('.interval-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.interval === 'event') {
                btn.classList.add('active');
            }
        });
        
        // Запускаем проверку событий
        startEventBasedUpdate();
    } else {
        // Режим периодического обновления
        updateMode = 'interval';
        updateIntervalMs = seconds * 1000;
        safeSetLocalStorage('updateMode', 'interval');
        safeSetLocalStorage('updateIntervalMs', updateIntervalMs.toString());
        
        // Обновляем активную кнопку
        document.querySelectorAll('.interval-btn').forEach(btn => {
            btn.classList.remove('active');
            if (parseInt(btn.dataset.interval) === seconds) {
                btn.classList.add('active');
            }
        });
        
        // Перезапускаем автообновление с новым интервалом
        updateInterval = setInterval(updateAll, updateIntervalMs);
    }
}

async function startEventBasedUpdate() {
    await updateAll();
    await primeEventUpdateBaseline();
    checkForNewEvents();
}

async function checkForNewEvents() {
    if (updateMode !== 'event') return;
    
    try {
        // Проверяем новые события с момента последней проверки
        const response = await fetchData(`/events?limit=1&offset=0`);
        if (response && response.events && response.events.length > 0) {
            const latestEvent = response.events[0];
            
            // Если есть новое событие (с timestamp больше последнего проверенного)
            if (latestEvent.timestamp > lastEventCheckTimestamp) {
                lastEventCheckTimestamp = latestEvent.timestamp;
                // Обновляем все данные при получении нового события
                await updateAll();
            }
        }
    } catch (error) {
        // Игнорируем ошибки, продолжаем проверку
    }
    
    // Проверяем снова (в фоне реже — setTimeout тоже троттлится, есть SSE + fallback)
    if (updateMode === 'event') {
        const delayMs =
            document.visibilityState === 'hidden'
                ? EVENT_MODE_POLL_HIDDEN_MS
                : EVENT_MODE_POLL_VISIBLE_MS;
        setTimeout(checkForNewEvents, delayMs);
    }
}

function startAutoUpdate() {
    updateConnectionStatus(false);

    // Данные подгружаются в onApplicationInitializationComplete после init.
    // В режиме Event опрос событий тоже стартует только после готовности бота.
    if (updateMode === 'event') {
        return;
    }

    updateInterval = setInterval(updateAll, updateIntervalMs);
}

function toggleOfflineStreamers() {
    showOffline = !showOffline;
    
    // Сохраняем состояние в localStorage
    safeSetLocalStorage('showOffline', showOffline.toString());
    
    const toggleBtn = document.getElementById('toggleOfflineBtn');
    const toggleText = document.getElementById('toggleOfflineText');
    
    if (showOffline) {
        toggleText.textContent = 'Hide Offline';
    } else {
        toggleText.textContent = 'Show Offline';
    }
    
    // Перерисовываем таблицу из кэша — без повторного GraphQL на сервере
    updateStatistics({ skipFetch: Boolean(cachedStatisticsRows) });
}

function exportLogs(format, streamerName) {
    const exportBtn = document.getElementById('exportBtn');
    const originalText = exportBtn ? exportBtn.innerHTML : '';
    
    // Показываем индикатор загрузки
    if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.innerHTML = '<span>⏳</span><span>Exporting...</span>';
    }
    
    // Формируем URL для экспорта
    let url = `${API_BASE}/export/${format}`;
    if (streamerName) {
        url += `?streamer=${encodeURIComponent(streamerName)}`;
    }
    
    // Создаем временную ссылку для скачивания
    const link = document.createElement('a');
    link.href = url;
    link.download = `sessions_${streamerName || 'all'}_${new Date().toISOString().split('T')[0]}.${format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Восстанавливаем кнопку через небольшую задержку
    setTimeout(() => {
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.innerHTML = originalText;
        }
    }, 1000);
}

function toggleExportDropdown() {
    const dropdown = document.getElementById('exportDropdown');
    dropdown.classList.toggle('show');
}

function closeExportDropdown() {
    const dropdown = document.getElementById('exportDropdown');
    dropdown.classList.remove('show');
}

/**
 * Переключает видимость колонки таблицы
 * @param {string} columnKey Ключ колонки
 * @param {boolean} visible Видимость колонки
 */
function toggleColumnVisibility(columnKey, visible) {
    visibleColumns[columnKey] = visible;
    safeSetLocalStorage('visibleColumns', JSON.stringify(visibleColumns));
    updateStatistics();
}

/**
 * Открывает/закрывает меню настроек колонок
 */
function toggleColumnSettings() {
    const dropdown = document.getElementById('columnSettingsDropdown');
    dropdown.classList.toggle('show');
}

/**
 * Закрывает меню настроек колонок
 */
function closeColumnSettings() {
    const dropdown = document.getElementById('columnSettingsDropdown');
    dropdown.classList.remove('show');
}

/**
 * Инициализация раздела событий (больше не требуется вычисление высоты)
 */
function setupStickyEventsSection() {
    // Функция больше не нужна, так как используется CSS Grid
    // Оставляем пустую функцию для совместимости
}

/** Запуск опроса API и автообновления (не ждём Chart.js CDN и window.load) */
let dashboardCoreStarted = false;

function startDashboardCore() {
    if (dashboardCoreStarted) {
        return;
    }
    dashboardCoreStarted = true;
    forceVersionRefreshOnReady =
        new URL(window.location.href).searchParams.get('vrefresh') === '1';
    checkInitializationStatus();
    initAppUpdateButton();
    initProcessControlButtons();
    startBotUptimeClock();
    startVersionUpdatePolling();
    startAutoUpdate();
    startDashboardEventStream();
    if (!document.documentElement.dataset.dashboardVisibilityBound) {
        document.documentElement.dataset.dashboardVisibilityBound = '1';
        document.addEventListener('visibilitychange', onDashboardVisibilityChange);
    }
    if (document.visibilityState === 'hidden') {
        ensureHiddenTabFallbackPoll();
    }
}

document.addEventListener('DOMContentLoaded', startDashboardCore);

window.addEventListener('load', () => {
    // Применяем настройки при загрузке (только если DOM готов)
    try {
        const settings = loadSettings();
        if (document.body) {
            applySettings(settings);
        }
    } catch (error) {
        console.error('Error applying settings on load:', error);
    }
    
    // Восстанавливаем состояние свернутых карточек и секций
    restoreCollapsedState();
    
    // Добавляем обработчики клика для заголовков карточек
    document.querySelectorAll('.collapsible-card h3').forEach(h3 => {
        h3.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            toggleCard(this);
        });
    });
    
    // Добавляем обработчики клика для заголовков секций
    document.querySelectorAll('.section-header-clickable').forEach(header => {
        header.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            const sectionId = this.dataset.section;
            if (sectionId) {
                toggleSection(sectionId);
            }
        });
    });
    
    // Восстанавливаем состояние кнопки показа/скрытия офлайн стримеров
    const toggleText = document.getElementById('toggleOfflineText');
    if (toggleText) {
        toggleText.textContent = showOffline ? 'Hide Offline' : 'Show Offline';
    }
    
    // Восстанавливаем активную кнопку интервала обновления
    document.querySelectorAll('.interval-btn').forEach(btn => {
        btn.classList.remove('active');
        if (updateMode === 'event' && btn.dataset.interval === 'event') {
            btn.classList.add('active');
        } else if (updateMode === 'interval') {
            const savedIntervalSeconds = updateIntervalMs / 1000;
            if (parseInt(btn.dataset.interval) === savedIntervalSeconds) {
                btn.classList.add('active');
            }
        }
    });
    
    // Восстанавливаем состояние переключателя цветовой кодировки
    const colorizeToggle = document.getElementById('colorizeStreamerNamesToggle');
    if (colorizeToggle) {
        colorizeToggle.checked = colorizeStreamerNames;
        colorizeToggle.addEventListener('change', (e) => {
            colorizeStreamerNames = e.target.checked;
            safeSetLocalStorage('colorizeStreamerNames', colorizeStreamerNames.toString());
            updateStatistics(); // Обновляем таблицу для применения цветов
        });
    }

    initAutoUpdateToggle();
    
    // Обработчик для кнопки настроек
    const testBtn = document.getElementById('testBtn');
    if (testBtn) {
        testBtn.addEventListener('click', showTestModal);
    }

    const appConfigBtn = document.getElementById('appConfigBtn');
    if (appConfigBtn) {
        appConfigBtn.addEventListener('click', showAppConfigModal);
    }

    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', showSettingsModal);
    }

    bindClientIntegrityPanelClick();
    
    // Раздел событий удален
    
    // Добавляем обработчик для кнопки заполнения тестовыми данными
    const fillTestDataBtn = document.getElementById('fillTestDataBtn');
    if (fillTestDataBtn) {
        fillTestDataBtn.addEventListener('click', fillTestData);
    }
    
    // Добавляем обработчик для кнопки пометки токена как невалидного
    const markTokenInvalidBtn = document.getElementById('markTokenInvalidBtn');
    if (markTokenInvalidBtn) {
        markTokenInvalidBtn.addEventListener('click', markTokenAsInvalid);
    }
    
    // Добавляем обработчик для кнопки переключения офлайн стримеров
    const toggleBtn = document.getElementById('toggleOfflineBtn');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleOfflineStreamers);
    }
    
    // Добавляем обработчики для кнопок интервала обновления
    document.querySelectorAll('.interval-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const interval = btn.dataset.interval;
            if (interval === 'event') {
                setUpdateInterval('event');
            } else {
                setUpdateInterval(parseInt(interval));
            }
        });
    });
    
    // Добавляем обработчики для кнопки экспорта
    const exportBtn = document.getElementById('exportBtn');
    const exportDropdown = document.getElementById('exportDropdown');
    
    if (exportBtn) {
        exportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleExportDropdown();
        });
    }
    
    // Обработчики для элементов меню экспорта
    document.querySelectorAll('.export-dropdown-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const format = item.dataset.format;
            const streamerName = item.dataset.streamer || null;
            exportLogs(format, streamerName);
            closeExportDropdown();
        });
    });
    
    // Обработчик для Enter в поле добавления стримера
    const addStreamerInput = document.getElementById('addStreamerInput');
    if (addStreamerInput) {
        addStreamerInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                addStreamer();
            }
        });
    }

    initFavoriteCategoriesSection();
    
    // Закрываем меню при клике вне его
    document.addEventListener('click', (e) => {
        if (exportDropdown && !exportDropdown.contains(e.target) && exportBtn && !exportBtn.contains(e.target)) {
            closeExportDropdown();
        }
        
        const columnSettingsBtn = document.getElementById('columnSettingsBtn');
        const columnSettingsDropdown = document.getElementById('columnSettingsDropdown');
        if (columnSettingsDropdown && !columnSettingsDropdown.contains(e.target) && columnSettingsBtn && !columnSettingsBtn.contains(e.target)) {
            closeColumnSettings();
        }

        const streamsCountWindowMenu = document.getElementById('streamsCountWindowMenu');
        if (streamsCountWindowMenu && !streamsCountWindowMenu.contains(e.target)) {
            hideStreamsCountWindowMenu();
        }

        const categoryStreamStatsMenu = document.getElementById('categoryStreamStatsMenu');
        if (
            categoryStreamStatsMenu &&
            !categoryStreamStatsMenu.contains(e.target) &&
            !e.target.closest('.streamer-category-button')
        ) {
            hideCategoryStreamStatsMenu();
        }

        const streamSessionsMenu = document.getElementById('streamSessionsMenu');
        if (
            streamSessionsMenu &&
            !streamSessionsMenu.contains(e.target) &&
            !e.target.closest('.stream-sessions-button')
        ) {
            hideStreamSessionsMenu();
        }
    });

    initStreamsCountWindowMenu();
    initCategoryStreamStatsMenu();
    initStreamSessionsMenu();
    
    // Инициализируем чекбоксы для колонок
    const columnCheckboxes = document.querySelectorAll('#columnSettingsDropdown input[type="checkbox"]');
    columnCheckboxes.forEach(checkbox => {
        const columnKey = checkbox.dataset.column;
        checkbox.checked = visibleColumns[columnKey] !== false;
        
        checkbox.addEventListener('change', (e) => {
            toggleColumnVisibility(columnKey, e.target.checked);
        });
    });
    
    // Обработчик для кнопки настроек колонок
    const columnSettingsBtn = document.getElementById('columnSettingsBtn');
    if (columnSettingsBtn) {
        columnSettingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleColumnSettings();
        });
    }
});

/**
 * Заполняет приложение тестовыми данными
 */
async function fillTestData() {
    const btn = document.getElementById('fillTestDataBtn');
    if (!btn) return;
    
    // Подтверждение действия
    if (!confirm('Вы уверены, что хотите заполнить приложение тестовыми данными?\n\nЭто действие создаст:\n- Около 1000 тестовых событий различных типов\n- Несколько тестовых стримеров\n\nЭто действие предназначено только для тестирования.')) {
        return;
    }
    
    // Отключаем кнопку на время запроса
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '⏳ Generating...';
    
    try {
        const response = await fetch(`${API_BASE}/test/fill-data`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification('success', `Test data generated successfully!\n- ${result.eventsCount || 0} events created\n- ${result.streamersCount || 0} streamers added`);
            // Обновляем все данные
            await Promise.all([
                updateStatistics(),
                updateOverallStats()
            ]);
        } else {
            showNotification('error', result.message || 'Failed to generate test data');
        }
    } catch (error) {
        console.error('Error filling test data:', error);
        showNotification('error', 'Failed to generate test data');
    } finally {
        // Восстанавливаем кнопку
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

/**
 * Помечает токен как невалидный (для тестирования перезапуска контейнера)
 */
async function markTokenAsInvalid() {
    const btn = document.getElementById('markTokenInvalidBtn');
    if (!btn) return;
    
    // Подтверждение действия
    if (!confirm('Вы уверены, что хотите пометить токен как невалидный?\n\nЭто действие вызовет критическое уведомление и может привести к перезапуску контейнера через healthcheck.\n\nЭто действие предназначено только для тестирования.')) {
        return;
    }
    
    // Отключаем кнопку на время запроса
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '⏳ Processing...';
    
    try {
        const response = await fetch(`${API_BASE}/token/mark-invalid`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification('success', 'Token marked as invalid. Container restart will be triggered by healthcheck.');
            // Обновляем информацию о токене
            await updateTokenInfo();
            // Обновляем критические уведомления
            await updateCriticalNotifications();
        } else {
            showNotification('error', result.message || 'Failed to mark token as invalid');
        }
    } catch (error) {
        console.error('Error marking token as invalid:', error);
        showNotification('error', 'Failed to mark token as invalid');
    } finally {
        // Восстанавливаем кнопку
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

/**
 * Добавляет стримера для отслеживания
 */
async function addStreamer() {
    const input = document.getElementById('addStreamerInput');
    if (!input) return;
    
    const username = input.value.trim();
    if (!username) {
        showNotification('warning', 'Please enter a streamer name');
        return;
    }

    // Отключаем кнопку и поле ввода
    input.disabled = true;
    const addBtn = input.nextElementSibling;
    if (addBtn) addBtn.disabled = true;

    try {
        const response = await fetch(`${API_BASE}/streamers`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ username }),
        });

        const result = await response.json();

        if (result.success) {
            // Очищаем поле ввода
            input.value = '';
            
            // Обновляем статистику
            await updateStatistics();
            await updateOverallStats();
            
            // Показываем уведомление об успехе
            showNotification('success', `Streamer ${username} added successfully`);
        } else {
            showNotification('error', result.message || 'Failed to add streamer');
        }
    } catch (error) {
        console.error('Error adding streamer:', error);
        showNotification('error', 'Failed to add streamer. Please try again.');
    } finally {
        // Включаем кнопку и поле ввода
        input.disabled = false;
        if (addBtn) addBtn.disabled = false;
        input.focus();
    }
}

/**
 * Показывает модальное окно подтверждения
 * @param {string} title Заголовок модального окна
 * @param {string} message Сообщение
 * @param {Function} onConfirm Функция, вызываемая при подтверждении
 */
function showConfirmModal(title, message, onConfirm) {
    const modal = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmModalTitle');
    const messageEl = document.getElementById('confirmModalMessage');
    const confirmBtn = document.getElementById('confirmModalConfirmBtn');
    
    if (!modal || !titleEl || !messageEl || !confirmBtn) return;
    
    titleEl.textContent = title;
    messageEl.textContent = message;
    
    // Удаляем старые обработчики
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    
    // Добавляем новый обработчик
    newConfirmBtn.addEventListener('click', () => {
        closeConfirmModal();
        if (onConfirm) onConfirm();
    });
    
    modal.style.display = 'flex';
    
    // Закрытие по клику на overlay
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeConfirmModal();
        }
    });
    
    // Закрытие по Escape
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            closeConfirmModal();
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

/**
 * Закрывает модальное окно подтверждения
 */
function closeConfirmModal() {
    const modal = document.getElementById('confirmModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Привязывает закрытие модального окна по клику на overlay (один раз)
 */
function bindModalOverlayClose(modal, closeFn) {
    if (!modal || modal.dataset.overlayCloseBound === '1') {
        return;
    }
    modal.dataset.overlayCloseBound = '1';
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeFn();
        }
    });
}

/**
 * Показывает панель тестирования
 */
function showTestModal() {
    const modal = document.getElementById('testModal');
    if (!modal) {
        return;
    }
    modal.style.display = 'flex';
    bindModalOverlayClose(modal, closeTestModal);

    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            closeTestModal();
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

/**
 * Закрывает панель тестирования
 */
function closeTestModal() {
    const modal = document.getElementById('testModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Тест toast-уведомления (без проверки настроек)
 */
function testToastNotification(isOnline) {
    const type = isOnline ? 'stream-up' : 'stream-down';
    const message = isOnline
        ? `${NOTIFICATION_TEST_STREAMER} — начал стрим`
        : `${NOTIFICATION_TEST_STREAMER} — завершил стрим`;
    showNotification(type, message, 6000);
}

/**
 * Тест уведомления ОС (без проверки настроек)
 */
async function testOsNotification(isOnline) {
    const permission = await ensureOsNotificationPermission();
    if (!permission.ok) {
        showOsPermissionWarning(permission.message || 'Не удалось получить разрешение на уведомления');
        return;
    }

    const title = isOnline ? '📺 Стрим онлайн' : '📴 Стрим офлайн';
    const body = isOnline
        ? `${NOTIFICATION_TEST_STREAMER} начал трансляцию`
        : `${NOTIFICATION_TEST_STREAMER} завершил трансляцию`;
    try {
        const notification = new Notification(title, buildOsNotificationOptions(NOTIFICATION_TEST_STREAMER, isOnline));
        if (!notification) {
            throw new Error('Notification constructor returned empty');
        }
    } catch (e) {
        console.warn('Test OS notification failed:', e);
        const availability = getOsNotificationAvailability();
        if (!availability.ok && availability.message) {
            showOsPermissionWarning(availability.message);
        } else {
            showNotification('error', 'Не удалось показать уведомление ОС. Обновите страницу и проверьте настройки сайта.');
        }
    }
}

/**
 * Тест звукового уведомления (без проверки настроек)
 */
function testSoundNotification(isOnline) {
    playNotificationSound(isOnline);
}

/**
 * Загружает настройки minute-watched с бота
 */
async function loadWatchSettingsIntoForm() {
    const hint = document.getElementById('watchSettingsHint');
    const intervalInput = document.getElementById('watchCycleIntervalSetting');
    if (!intervalInput) {
        return;
    }

    const data = await fetchData('/watch-settings');
    if (!data) {
        if (hint) {
            hint.textContent = 'Не удалось загрузить настройки просмотра с сервера.';
        }
        return;
    }

    intervalInput.value = String(data.cycleIntervalSec ?? 60);
    if (data.minCycleIntervalSec != null) {
        intervalInput.min = String(data.minCycleIntervalSec);
    }
    if (data.maxCycleIntervalSec != null) {
        intervalInput.max = String(data.maxCycleIntervalSec);
    }

    updateWatchSettingsHint(data);
}

/**
 * Обновляет подсказку по режиму minute-watched
 */
function updateWatchSettingsHint(data) {
    const hint = document.getElementById('watchSettingsHint');
    if (!hint || !data) {
        return;
    }

    const sec = data.cycleIntervalSec ?? 60;
    const online = data.onlineCount ?? 0;
    const last = data.lastSequentialStreamer;
    const cycleMin = online > 0 ? Math.round((online * sec) / 60) : 0;
    const queue = last ? ` Сейчас в очереди: ${last}.` : '';
    hint.textContent =
        `Ротация: пауза ${sec} с между каналами. Онлайн: ${online}.` +
        (online > 0 ? ` Полный круг ≈ ${cycleMin} мин.${queue}` : ' Нет онлайн-каналов.');
}

/**
 * Сохраняет настройки minute-watched на сервере (.env + runtime)
 */
async function saveWatchSettingsFromForm() {
    const intervalInput = document.getElementById('watchCycleIntervalSetting');
    if (!intervalInput) {
        return { ok: true };
    }

    const cycleIntervalSec = parseInt(intervalInput.value, 10);
    if (!Number.isFinite(cycleIntervalSec)) {
        return { ok: false, message: 'Укажите корректный интервал в секундах' };
    }

    const result = await postApi('/watch-settings', { cycleIntervalSec });

    if (result.ok && result.data) {
        updateWatchSettingsHint(result.data);
    }

    return result;
}

const APP_CONFIG_SECRET_PLACEHOLDER = '••••••••';

/** Boolean в конфиге: LOG_TO_FILE и LOG_CLEAR_ON_START включены по умолчанию */
const APP_CONFIG_BOOLEAN_DEFAULT_TRUE = new Set([
    'LOG_TO_FILE',
    'LOG_CLEAR_ON_START',
    'TWITCH_INTEGRITY_AUTO_REFRESH',
    'TWITCH_INTEGRITY_AUTO_PERSIST',
]);

function isAppConfigBooleanChecked(field, value) {
    if (APP_CONFIG_BOOLEAN_DEFAULT_TRUE.has(field.key)) {
        return value !== 'false' && value !== '0';
    }
    return value === 'true' || value === '1';
}

/**
 * ID поля формы конфига бота
 */
function appConfigFieldId(key) {
    return `appCfg_${key}`;
}

/**
 * Рендерит форму настроек бота по метаданным с сервера
 */
function renderAppConfigForm(data) {
    const root = document.getElementById('appConfigFormRoot');
    if (!root || !data?.fields) {
        return;
    }

    const settings = data.settings || {};
    const bySection = new Map();

    for (const field of data.fields) {
        if (field.key === 'token') {
            continue;
        }
        if (!bySection.has(field.section)) {
            bySection.set(field.section, []);
        }
        bySection.get(field.section).push(field);
    }

    let html = '';

    const tokenMeta = data.fields?.find((f) => f.key === 'token');
    const tokenLabel = tokenMeta?.label ?? 'Токен (cookie: auth-token)';
    const tokenHint = tokenMeta?.hint ?? 'Application → Cookies → auth-token';

    html += '<div class="settings-section"><h4 class="settings-section-title">Авторизация (Application → Cookies)</h4>';
    html += '<div class="settings-item">';
    html += `<label class="settings-label" for="appCfg_token">${escapeHtml(tokenLabel)}</label>`;
    html += `<input type="password" id="appCfg_token" class="settings-select" style="width:100%" autocomplete="off" placeholder="${data.tokenSet ? 'Оставьте пустым, чтобы не менять' : 'Вставьте auth-token'}"`;
    if (data.tokenMasked) {
        html += ` data-masked="${escapeHtml(data.tokenMasked)}"`;
    }
    html += '></div>';
    if (tokenHint) {
        html += `<p class="settings-hint">${escapeHtml(tokenHint)}</p>`;
    }
    if (data.tokenMasked) {
        html += `<p class="settings-hint">Текущий: ${escapeHtml(data.tokenMasked)}</p>`;
    }
    html += '</div>';

    for (const [section, fields] of bySection) {
        html += `<div class="settings-section"><h4 class="settings-section-title">${escapeHtml(section)}</h4>`;
        for (const field of fields) {
            const id = appConfigFieldId(field.key);
            const value = settings[field.key] ?? '';
            html += '<div class="settings-item">';
            html += `<label class="settings-label" for="${id}">${escapeHtml(field.label)}</label>`;
            if (field.inputType === 'select' && field.options) {
                html += `<select id="${id}" class="settings-select" style="width:100%">`;
                for (const opt of field.options) {
                    const selected = value === opt.value ? ' selected' : '';
                    html += `<option value="${escapeHtml(opt.value)}"${selected}>${escapeHtml(opt.label)}</option>`;
                }
                html += '</select>';
            } else if (field.inputType === 'boolean') {
                const checked = isAppConfigBooleanChecked(field, value) ? ' checked' : '';
                html += `<label class="settings-checkbox-label"><input type="checkbox" id="${id}" class="settings-checkbox"${checked}><span>Включено</span></label>`;
            } else if (field.inputType === 'number') {
                html += `<input type="number" id="${id}" class="settings-select" style="width:100%" value="${escapeHtml(value)}">`;
            } else {
                const type = field.inputType === 'password' ? 'password' : 'text';
                const ph = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
                html += `<input type="${type}" id="${id}" class="settings-select" style="width:100%" value="${escapeHtml(value)}"${ph} autocomplete="off">`;
            }
            if (field.hint) {
                html += `<p class="settings-hint">${escapeHtml(field.hint)}</p>`;
            }
            html += '</div>';
        }
        html += '</div>';
    }

    root.innerHTML = html;
}

/**
 * Собирает значения формы конфига бота
 */
function collectAppConfigPayload() {
    const settings = {};
    const root = document.getElementById('appConfigFormRoot');
    if (!root) {
        return { settings, token: undefined };
    }

    root.querySelectorAll('input, select').forEach((el) => {
        const id = el.id || '';
        if (!id.startsWith('appCfg_')) {
            return;
        }
        const key = id.slice('appCfg_'.length);
        if (key === 'token') {
            return;
        }

        let value;
        if (el.type === 'checkbox') {
            value = el.checked ? 'true' : 'false';
        } else if (el.tagName === 'SELECT') {
            value = el.value;
            if (value === '') {
                settings[key] = '';
                return;
            }
            value = value.trim();
        } else {
            value = el.value.trim();
        }

        if (value === '') {
            return;
        }
        if (
            (el.type === 'password' || el.dataset?.masked)
            && (value === APP_CONFIG_SECRET_PLACEHOLDER || value.startsWith(APP_CONFIG_SECRET_PLACEHOLDER))
        ) {
            return;
        }
        settings[key] = value;
    });

    const tokenEl = document.getElementById('appCfg_token');
    const token = tokenEl?.value?.trim() || undefined;

    return { settings, token };
}

/**
 * Открывает модальное окно конфига бота
 */
async function showAppConfigModal() {
    const modal = document.getElementById('appConfigModal');
    if (!modal) {
        return;
    }

    const hint = document.getElementById('appConfigLoadHint');
    const restartHint = document.getElementById('appConfigRestartHint');
    if (hint) {
        hint.textContent = 'Загрузка настроек с сервера…';
    }
    if (restartHint) {
        restartHint.style.display = 'none';
    }

    modal.style.display = 'flex';
    bindModalOverlayClose(modal, closeAppConfigModal);

    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            closeAppConfigModal();
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);

    try {
        const data = await fetchData('/app-settings');
        if (!data?.fields) {
            throw new Error('Пустой ответ сервера (проверьте API-ключ или перезапустите бота)');
        }
        renderAppConfigForm(data);
        if (hint) {
            hint.textContent = data.configPath ? `Файл: ${data.configPath}` : '';
        }
        const existingKey = getDashboardApiKey();
        const apiKeyField = document.getElementById(appConfigFieldId('WEB_DASHBOARD_API_KEY'));
        if (apiKeyField && !apiKeyField.value && existingKey) {
            apiKeyField.value = existingKey;
        }
        void loadWatchSettingsIntoForm();
    } catch (e) {
        if (hint) {
            hint.textContent = 'Не удалось загрузить настройки: ' + (e.message || e);
        }
        showNotification('error', 'Не удалось загрузить конфиг бота');
    }
}

function closeAppConfigModal() {
    const modal = document.getElementById('appConfigModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Сохраняет конфиг бота на сервере
 */
async function saveAppConfig() {
    const saveBtn = document.getElementById('appConfigSaveBtn');
    if (saveBtn) {
        saveBtn.disabled = true;
    }

    try {
        const payload = collectAppConfigPayload();
        const result = await postApi('/app-settings', payload);

        const apiKey = payload.settings?.WEB_DASHBOARD_API_KEY;
        if (apiKey) {
            setDashboardApiKey(apiKey);
        }

        const watchResult = await saveWatchSettingsFromForm();
        if (!watchResult.ok) {
            showNotification('error', watchResult.message || 'Не удалось сохранить интервал просмотра');
            return;
        }

        const restartHint = document.getElementById('appConfigRestartHint');
        if (restartHint && result.restartRequired) {
            restartHint.style.display = 'block';
            restartHint.textContent =
                'Сохранено. Перезапустите бота для: ' + (result.restartReasons || []).join(', ');
        }

        closeAppConfigModal();
        const parts = [result.message || 'Конфиг сохранён'];
        if (result.watcherMessage && !result.watcherStarted) {
            parts.push(result.watcherMessage);
        }
        if (watchResult.data?.message) {
            parts.push(watchResult.data.message);
        }
        showNotification(result.watcherStarted === false && result.restartRequired ? 'warning' : 'success', parts.join(' '));

        if (result.watcherStarted) {
            setTimeout(() => window.location.reload(), 800);
        }
    } catch (e) {
        showNotification('error', e.message || 'Не удалось сохранить конфиг');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
        }
    }
}

/**
 * Показывает панель настроек
 */
async function showSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    
    const settings = loadSettings();
    
    // Заполняем форму
    document.getElementById('fontSizeSetting').value = settings.fontSize;
    document.getElementById('densitySetting').value = settings.density;
    document.getElementById('autoScrollEventsSetting').checked = settings.autoScrollEvents;
    document.getElementById('eventsPageSizeSetting').value = settings.eventsPageSize.toString();
    document.getElementById('saveChartZoomSetting').checked = settings.saveChartZoom;
    document.getElementById('autoUpdateChartSetting').checked = settings.autoUpdateChart;
    document.getElementById('showToastNotificationsSetting').checked = settings.showToastNotifications;
    document.getElementById('osNotificationsSetting').checked = settings.osNotifications;
    document.getElementById('soundNotificationsSetting').checked = settings.soundNotifications;

    const osHint = document.getElementById('osNotificationsHint');
    if (osHint) {
        const availability = getOsNotificationAvailability();
        const denied = availability.ok && Notification.permission === 'denied';
        const showHint = !availability.ok || denied;
        osHint.style.display = showHint ? 'block' : 'none';
        if (!availability.ok) {
            osHint.textContent = availability.message || '';
        } else if (denied) {
            osHint.textContent = 'Уведомления ОС заблокированы. Разрешите в настройках сайта (замок в адресной строке) и обновите страницу.';
        } else {
            osHint.textContent = 'Разрешите уведомления в браузере при сохранении настроек.';
        }
    }
    
    modal.style.display = 'flex';
    bindModalOverlayClose(modal, closeSettingsModal);

    // Закрытие по Escape
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            closeSettingsModal();
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

/**
 * Закрывает панель настроек
 */
function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Сохраняет настройки
 */
async function saveSettings() {
    const settings = {
        fontSize: document.getElementById('fontSizeSetting').value,
        density: document.getElementById('densitySetting').value,
        autoScrollEvents: document.getElementById('autoScrollEventsSetting').checked,
        eventsPageSize: parseInt(document.getElementById('eventsPageSizeSetting').value),
        saveChartZoom: document.getElementById('saveChartZoomSetting').checked,
        autoUpdateChart: document.getElementById('autoUpdateChartSetting').checked,
        showToastNotifications: document.getElementById('showToastNotificationsSetting').checked,
        osNotifications: document.getElementById('osNotificationsSetting').checked,
        soundNotifications: document.getElementById('soundNotificationsSetting').checked
    };

    if (settings.osNotifications) {
        const permission = await ensureOsNotificationPermission();
        if (!permission.ok) {
            settings.osNotifications = false;
            document.getElementById('osNotificationsSetting').checked = false;
            showOsPermissionWarning(permission.message || 'Разрешение на уведомления ОС не получено');
        }
    }
    
    saveSettingsToStorage(settings);
    applySettings(settings);

    closeSettingsModal();
    showNotification('success', 'Настройки интерфейса сохранены');
}

/**
 * Экспортирует настройки в JSON файл
 */
function exportSettings() {
    const settings = loadSettings();
    const dataStr = JSON.stringify(settings, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `twitch-watcher-settings-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showNotification('success', 'Настройки экспортированы');
}

/**
 * Импортирует настройки из JSON файла
 */
function importSettings() {
    document.getElementById('settingsFileInput').click();
}

/**
 * Обрабатывает импорт настроек
 */
function handleSettingsImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const imported = JSON.parse(e.target.result);
            // Валидация настроек
            const validSettings = {};
            Object.keys(defaultSettings).forEach(key => {
                if (imported.hasOwnProperty(key)) {
                    validSettings[key] = imported[key];
                } else {
                    validSettings[key] = defaultSettings[key];
                }
            });
            
            saveSettingsToStorage(validSettings);
            applySettings(validSettings);
            
            // Обновляем форму
            document.getElementById('fontSizeSetting').value = validSettings.fontSize;
            document.getElementById('densitySetting').value = validSettings.density;
            document.getElementById('autoScrollEventsSetting').checked = validSettings.autoScrollEvents;
            document.getElementById('eventsPageSizeSetting').value = validSettings.eventsPageSize.toString();
            document.getElementById('saveChartZoomSetting').checked = validSettings.saveChartZoom;
            document.getElementById('autoUpdateChartSetting').checked = validSettings.autoUpdateChart;
            document.getElementById('showToastNotificationsSetting').checked = validSettings.showToastNotifications;
            document.getElementById('osNotificationsSetting').checked = validSettings.osNotifications;
            document.getElementById('soundNotificationsSetting').checked = validSettings.soundNotifications;
            
            showNotification('success', 'Настройки импортированы');
        } catch (error) {
            console.error('Error importing settings:', error);
            showNotification('error', 'Ошибка при импорте настроек');
        }
    };
    reader.readAsText(file);
    event.target.value = ''; // Сбрасываем input
}

/**
 * Удаляет стримера из отслеживания
 * @param {string} username Имя стримера
 */
async function removeStreamer(username) {
    showConfirmModal(
        'Подтверждение удаления',
        `Вы уверены, что хотите удалить ${username} из отслеживания?`,
        async () => {
            try {
                const response = await fetch(`${API_BASE}/streamers/${encodeURIComponent(username)}`, {
                    method: 'DELETE',
                });

                const result = await response.json();

                if (result.success) {
                    // Обновляем статистику
                    await updateStatistics();
                    await updateOverallStats();
                    
                    // Показываем уведомление об успехе
                    showNotification('success', `Streamer ${username} removed successfully`);
                } else {
                    showNotification('error', result.message || 'Failed to remove streamer');
                }
            } catch (error) {
                console.error('Error removing streamer:', error);
                showNotification('error', 'Failed to remove streamer. Please try again.');
            }
        }
    );
}

/**
 * Иконки для типов уведомлений
 */
const notificationIcons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️',
    'stream-up': '📺',
    'stream-down': '📴'
};

/**
 * Функция debounce для задержки выполнения
 * @param {Function} func Функция для выполнения
 * @param {number} wait Время задержки в миллисекундах
 * @returns {Function} Обернутая функция
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Создает и показывает прогресс-бар
 * @param {string} title Заголовок прогресс-бара
 * @returns {Object} Объект с методами для управления прогресс-баром
 */
function createProgressBar(title) {
    // Удаляем существующий прогресс-бар, если есть
    const existing = document.getElementById('progressBarOverlay');
    if (existing) {
        existing.remove();
    }
    
    const overlay = document.createElement('div');
    overlay.id = 'progressBarOverlay';
    overlay.className = 'progress-bar-overlay';
    
    overlay.innerHTML = `
        <div class="progress-bar-container">
            <div class="progress-bar-title">${title}</div>
            <div class="progress-bar-wrapper">
                <div class="progress-bar-fill" id="progressBarFill" style="width: 0%"></div>
            </div>
            <div class="progress-bar-text" id="progressBarText">0%</div>
        </div>
    `;
    
    document.body.appendChild(overlay);
    
    return {
        /**
         * Обновляет прогресс
         * @param {number} percent Процент выполнения (0-100)
         * @param {string} text Текст для отображения (опционально)
         */
        update(percent, text) {
            const fill = document.getElementById('progressBarFill');
            const textEl = document.getElementById('progressBarText');
            
            if (fill) {
                fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
            }
            
            if (textEl) {
                textEl.textContent = text || `${Math.round(percent)}%`;
            }
        },
        
        /**
         * Закрывает прогресс-бар
         */
        close() {
            if (overlay && overlay.parentElement) {
                overlay.style.opacity = '0';
                setTimeout(() => {
                    overlay.remove();
                }, 200);
            }
        }
    };
}

/**
 * Показывает уведомление
 * @param {string} type Тип уведомления (success, error, info, warning)
 * @param {string} message Текст уведомления
 * @param {number} duration Длительность отображения в миллисекундах (по умолчанию 5000)
 */
function showNotification(type, message, duration = 5000) {
    // Создаем контейнер для уведомлений, если его еще нет
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    
    // Создаем элемент уведомления
    const notification = document.createElement('div');
    notification.className = `toast-notification ${type}`;
    
    const icon = notificationIcons[type] || notificationIcons.info;
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
    
    notification.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <span class="toast-message">${safeMessage}</span>
        <button class="toast-close" onclick="this.parentElement.remove()" title="Закрыть">×</button>
    `;
    
    // Добавляем уведомление в контейнер
    container.appendChild(notification);
    
    // Автоматически удаляем уведомление через указанное время
    const timeoutId = setTimeout(() => {
        removeNotification(notification);
    }, duration);
    
    // Останавливаем таймер при наведении
    notification.addEventListener('mouseenter', () => {
        clearTimeout(timeoutId);
    });
    
    // Возобновляем таймер при уходе мыши
    notification.addEventListener('mouseleave', () => {
        setTimeout(() => {
            removeNotification(notification);
        }, duration);
    });
}

/**
 * Удаляет уведомление с анимацией
 * @param {HTMLElement} notification Элемент уведомления
 */
function removeNotification(notification) {
    if (notification && notification.parentElement) {
        notification.classList.add('slide-out');
        setTimeout(() => {
            if (notification.parentElement) {
                notification.remove();
            }
            // Удаляем контейнер, если он пустой
            const container = document.getElementById('toastContainer');
            if (container && container.children.length === 0) {
                container.remove();
            }
        }, 300);
    }
}

// Делаем функции доступными глобально для вызова из HTML
window.addStreamer = addStreamer;
window.removeStreamer = removeStreamer;
window.closeConfirmModal = closeConfirmModal;
window.closeSettingsModal = closeSettingsModal;
window.exportSettings = exportSettings;
window.importSettings = importSettings;
window.saveSettings = saveSettings;
window.toggleStreamerNotify = toggleStreamerNotify;
window.toggleAllStreamerNotifications = toggleAllStreamerNotifications;
window.showSettingsModal = showSettingsModal;
window.showAppConfigModal = showAppConfigModal;
window.closeAppConfigModal = closeAppConfigModal;
window.saveAppConfig = saveAppConfig;
window.showTestModal = showTestModal;
window.closeTestModal = closeTestModal;
window.testToastNotification = testToastNotification;
window.testOsNotification = testOsNotification;
window.testSoundNotification = testSoundNotification;
window.handleSettingsImport = handleSettingsImport;

/**
 * Переключает видимость секции
 * @param {string} sectionId ID элемента секции для сворачивания/разворачивания
 */
function toggleSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    
    const isCollapsed = section.style.display === 'none' || section.style.maxHeight === '0px' || 
                        (section.style.maxHeight === '' && section.offsetHeight === 0);
    
    if (isCollapsed) {
        section.style.display = '';
        const height = section.scrollHeight;
        section.style.maxHeight = '0px';
        // Принудительно пересчитываем
        requestAnimationFrame(() => {
            section.style.maxHeight = height + 'px';
            setTimeout(() => {
                section.style.maxHeight = '';
            }, 300);
        });
    } else {
        const height = section.scrollHeight;
        section.style.maxHeight = height + 'px';
        // Принудительно пересчитываем
        requestAnimationFrame(() => {
            section.style.maxHeight = '0px';
            setTimeout(() => {
                section.style.display = 'none';
                section.style.maxHeight = '';
            }, 300);
        });
    }
    
    // Сохраняем состояние секции
    try {
        const collapsedSectionsStr = safeGetLocalStorage('collapsedSections', '[]');
        const collapsedSections = collapsedSectionsStr ? JSON.parse(collapsedSectionsStr) : [];
        if (Array.isArray(collapsedSections)) {
            const index = collapsedSections.indexOf(sectionId);
            
            if (!isCollapsed && index === -1) {
                collapsedSections.push(sectionId);
            } else if (isCollapsed && index !== -1) {
                collapsedSections.splice(index, 1);
            }
            
            safeSetLocalStorage('collapsedSections', JSON.stringify(collapsedSections));
        }
    } catch (error) {
        console.error('Error saving section state:', error);
    }
    
    // Иконка больше не используется, заголовок кликабельный без визуального индикатора
}

/**
 * Восстанавливает состояние свернутых карточек и секций
 */
function restoreCollapsedState() {
    try {
        // Восстанавливаем состояние карточек
        const collapsedCardsStr = safeGetLocalStorage('collapsedCards', '[]');
        const collapsedCards = collapsedCardsStr ? JSON.parse(collapsedCardsStr) : [];
        if (Array.isArray(collapsedCards)) {
            document.querySelectorAll('.collapsible-card').forEach(card => {
                const h3 = card.querySelector('h3');
                if (h3) {
                    // Получаем текст заголовка
                    const cardTitle = h3.textContent.trim() || '';
                    if (collapsedCards.includes(cardTitle)) {
                        card.classList.add('collapsed');
                    }
                }
            });
        }
        
        // Восстанавливаем состояние секций
        const collapsedSectionsStr = safeGetLocalStorage('collapsedSections', '[]');
        const collapsedSections = collapsedSectionsStr ? JSON.parse(collapsedSectionsStr) : [];
        if (Array.isArray(collapsedSections)) {
            collapsedSections.forEach(sectionId => {
                const section = document.getElementById(sectionId);
                if (section) {
                    section.style.display = 'none';
                    section.style.maxHeight = '0px';
                // Иконка больше не используется
                }
            });
        }
    } catch (error) {
        console.error('Error restoring collapsed state:', error);
    }
}

/**
 * Переключает видимость карточки статистики
 * @param {HTMLElement} headerElement Элемент заголовка карточки (h3)
 */
function toggleCard(headerElement) {
    const card = headerElement.closest('.collapsible-card');
    if (!card) return;
    
    const isCollapsed = card.classList.toggle('collapsed');
    // Получаем текст заголовка
    const cardTitle = headerElement.textContent.trim() || '';
    
    // Сохраняем состояние карточки
    try {
        const collapsedCardsStr = safeGetLocalStorage('collapsedCards', '[]');
        const collapsedCards = collapsedCardsStr ? JSON.parse(collapsedCardsStr) : [];
        if (Array.isArray(collapsedCards)) {
            const index = collapsedCards.indexOf(cardTitle);
            
            if (isCollapsed && index === -1) {
                collapsedCards.push(cardTitle);
            } else if (!isCollapsed && index !== -1) {
                collapsedCards.splice(index, 1);
            }
            
            safeSetLocalStorage('collapsedCards', JSON.stringify(collapsedCards));
        }
    } catch (error) {
        console.error('Error saving card state:', error);
    }
}

// Делаем функции доступными глобально для вызова из HTML
window.toggleSection = toggleSection;
window.toggleCard = toggleCard;

/** Избранные категории Twitch */
let favoriteCategories = [];
let categorySearchResults = [];
let categorySearchTimer = null;
let selectedCategorySuggestion = null;

const CATEGORY_SEARCH_DEBOUNCE_MS = 300;
const CATEGORY_FUZZY_MAX_ERROR_RATIO = 0.5;

/**
 * Расстояние Левенштейна (для нечёткого сопоставления категорий)
 */
function levenshteinDistance(left, right) {
    if (left === right) {
        return 0;
    }
    if (!left.length) {
        return right.length;
    }
    if (!right.length) {
        return left.length;
    }

    const rows = left.length + 1;
    const cols = right.length + 1;
    const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (let row = 0; row < rows; row += 1) {
        matrix[row][0] = row;
    }
    for (let col = 0; col < cols; col += 1) {
        matrix[0][col] = col;
    }

    for (let row = 1; row < rows; row += 1) {
        for (let col = 1; col < cols; col += 1) {
            const cost = left[row - 1] === right[col - 1] ? 0 : 1;
            matrix[row][col] = Math.min(
                matrix[row - 1][col] + 1,
                matrix[row][col - 1] + 1,
                matrix[row - 1][col - 1] + cost
            );
        }
    }

    return matrix[rows - 1][cols - 1];
}

/**
 * Доля ошибок при сопоставлении запроса с названием категории
 */
function getCategoryMatchErrorRatio(query, categoryName) {
    const normalizedQuery = query.trim().toLowerCase();
    const normalizedCategory = categoryName.trim().toLowerCase();

    if (!normalizedQuery || !normalizedCategory) {
        return 1;
    }

    if (normalizedCategory.startsWith(normalizedQuery)) {
        return 0;
    }

    const fullDistance = levenshteinDistance(normalizedQuery, normalizedCategory);
    let bestRatio = fullDistance / Math.max(normalizedQuery.length, normalizedCategory.length);

    const minWindow = Math.max(1, normalizedQuery.length - 2);
    const maxWindow = normalizedQuery.length + 2;

    for (let windowLength = minWindow; windowLength <= maxWindow; windowLength += 1) {
        if (windowLength > normalizedCategory.length) {
            continue;
        }

        for (let start = 0; start <= normalizedCategory.length - windowLength; start += 1) {
            const slice = normalizedCategory.slice(start, start + windowLength);
            const distance = levenshteinDistance(normalizedQuery, slice);
            const ratio = distance / Math.max(normalizedQuery.length, slice.length);
            if (ratio < bestRatio) {
                bestRatio = ratio;
            }
        }
    }

    return bestRatio;
}

/**
 * Находит лучшее совпадение категории с допустимой долей ошибок
 */
function findBestCategoryFuzzyMatch(name, categories) {
    let bestMatch = null;
    let bestRatio = CATEGORY_FUZZY_MAX_ERROR_RATIO;

    for (const item of categories) {
        const ratio = getCategoryMatchErrorRatio(name, item.name);
        if (ratio < bestRatio) {
            bestRatio = ratio;
            bestMatch = item;
        }
    }

    return bestMatch;
}

/**
 * Загружает избранные категории с сервера
 */
async function loadFavoriteCategories() {
    const data = await fetchData('/favorite-categories');
    favoriteCategories = Array.isArray(data?.categories) ? data.categories : [];
    renderFavoriteCategoriesTable();
}

/**
 * Рендерит таблицу избранных категорий
 */
function renderFavoriteCategoriesTable() {
    const wrap = document.getElementById('favoriteCategoriesTableWrap');
    if (!wrap) {
        return;
    }

    if (!favoriteCategories.length) {
        wrap.innerHTML = '<p class="favorite-categories-empty">Нет избранных категорий</p>';
        return;
    }

    const rows = favoriteCategories.map((cat) => {
        const art = cat.boxArtUrl
            ? `<img src="${escapeHtml(cat.boxArtUrl)}" alt="" class="favorite-category-art" loading="lazy">`
            : '<span class="favorite-category-art favorite-category-art-placeholder">🎮</span>';
        return `
            <tr data-category-id="${escapeHtml(cat.id)}">
                <td class="favorite-category-art-cell">${art}</td>
                <td class="favorite-category-name">${escapeHtml(cat.name)}</td>
                <td class="favorite-category-actions">
                    <button type="button" class="remove-category-btn" data-category-id="${escapeHtml(cat.id)}" title="Удалить">✕</button>
                </td>
            </tr>
        `;
    }).join('');

    wrap.innerHTML = `
        <table class="favorite-categories-table">
            <thead>
                <tr>
                    <th></th>
                    <th>Категория</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;

    wrap.querySelectorAll('.remove-category-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            removeFavoriteCategory(btn.dataset.categoryId);
        });
    });
}

/**
 * Скрывает выпадающий список подсказок категорий
 */
function hideCategoryAutocomplete() {
    const dropdown = document.getElementById('categoryAutocompleteDropdown');
    if (dropdown) {
        dropdown.hidden = true;
        dropdown.innerHTML = '';
    }
    categorySearchResults = [];
    selectedCategorySuggestion = null;
}

/**
 * Показывает подсказки категорий
 */
function renderCategoryAutocomplete(categories) {
    const dropdown = document.getElementById('categoryAutocompleteDropdown');
    if (!dropdown) {
        return;
    }

    if (!categories.length) {
        hideCategoryAutocomplete();
        return;
    }

    categorySearchResults = categories;
    dropdown.innerHTML = categories.map((cat, index) => {
        const art = cat.boxArtUrl
            ? `<img src="${escapeHtml(cat.boxArtUrl)}" alt="" class="category-suggestion-art" loading="lazy">`
            : '';
        return `
            <button type="button" class="category-suggestion-item" data-index="${index}">
                ${art}
                <span class="category-suggestion-name">${escapeHtml(cat.name)}</span>
            </button>
        `;
    }).join('');
    dropdown.hidden = false;

    dropdown.querySelectorAll('.category-suggestion-item').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const index = Number(btn.dataset.index);
            const category = categorySearchResults[index];
            if (!category) {
                return;
            }
            selectCategorySuggestion(category);
            addFavoriteCategoryFromUi(category);
        });
    });
}

/**
 * Выбирает категорию из подсказок
 */
function selectCategorySuggestion(category) {
    selectedCategorySuggestion = category;
    const input = document.getElementById('favoriteCategoryInput');
    if (input) {
        input.value = category.name;
    }
    hideCategoryAutocomplete();
}

/**
 * Ищет категории Twitch для автодополнения
 */
async function searchCategoriesForAutocomplete(query) {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
        hideCategoryAutocomplete();
        return;
    }

    const data = await fetchData(`/categories/search?q=${encodeURIComponent(trimmed)}`);
    if (data?.error) {
        hideCategoryAutocomplete();
        showNotification('error', data.error);
        return;
    }

    const categories = Array.isArray(data?.categories) ? data.categories : [];
    renderCategoryAutocomplete(categories);
}

/**
 * Планирует отложенный поиск категорий
 */
function scheduleCategorySearch(query) {
    if (categorySearchTimer) {
        clearTimeout(categorySearchTimer);
    }
    selectedCategorySuggestion = null;
    categorySearchTimer = setTimeout(() => {
        searchCategoriesForAutocomplete(query);
    }, CATEGORY_SEARCH_DEBOUNCE_MS);
}

/**
 * Добавляет категорию в избранное из UI
 */
async function addFavoriteCategoryFromUi(categoryOverride) {
    const input = document.getElementById('favoriteCategoryInput');
    let category = categoryOverride || selectedCategorySuggestion;

    if (!category && input?.value.trim()) {
        const name = input.value.trim();
        let match = categorySearchResults.find(
            (item) => item.name.toLowerCase() === name.toLowerCase()
        );
        if (!match) {
            match = findBestCategoryFuzzyMatch(name, categorySearchResults);
        }
        if (match) {
            category = match;
        }
    }

    if (!category?.id || !category?.name) {
        showNotification('error', 'Выберите категорию из списка подсказок');
        return;
    }

    const result = await postApi('/favorite-categories', {
        id: category.id,
        name: category.name,
        boxArtUrl: category.boxArtUrl ?? null,
    });

    if (!result.ok) {
        showNotification('error', result.message || 'Не удалось добавить категорию');
        return;
    }

    favoriteCategories = Array.isArray(result.data?.categories) ? result.data.categories : favoriteCategories;
    renderFavoriteCategoriesTable();
    if (input) {
        input.value = '';
    }
    selectedCategorySuggestion = null;
    hideCategoryAutocomplete();
    showNotification('success', `Категория «${category.name}» добавлена`);
}

/**
 * Удаляет категорию из избранного
 */
async function removeFavoriteCategory(id) {
    try {
        const headers = {};
        const apiKey = getDashboardApiKey();
        if (apiKey) {
            headers['X-API-Key'] = apiKey;
        }

        const response = await fetch(`${API_BASE}/favorite-categories/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers,
        });
        const result = await response.json();
        if (!response.ok) {
            showNotification('error', result.error || result.message || 'Не удалось удалить категорию');
            return;
        }

        favoriteCategories = Array.isArray(result.categories) ? result.categories : favoriteCategories;
        renderFavoriteCategoriesTable();
        showNotification('success', 'Категория удалена');
    } catch (error) {
        console.error('Error removing favorite category:', error);
        showNotification('error', 'Не удалось удалить категорию');
    }
}

/**
 * Инициализирует секцию избранных категорий
 */
function initFavoriteCategoriesSection() {
    const input = document.getElementById('favoriteCategoryInput');
    const addBtn = document.getElementById('addFavoriteCategoryBtn');

    loadFavoriteCategories();

    if (input) {
        input.addEventListener('input', (e) => {
            scheduleCategorySearch(e.target.value);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addFavoriteCategoryFromUi();
            } else if (e.key === 'Escape') {
                hideCategoryAutocomplete();
            }
        });
        input.addEventListener('blur', () => {
            setTimeout(() => hideCategoryAutocomplete(), 150);
        });
    }

    if (addBtn) {
        addBtn.addEventListener('click', () => addFavoriteCategoryFromUi());
    }
}

window.addEventListener('beforeunload', () => {
    if (updateInterval) {
        clearInterval(updateInterval);
    }
    if (eventSource) {
        eventSource.close();
    }
});

