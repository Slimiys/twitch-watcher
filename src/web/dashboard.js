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
let eventSource = null; // Для Server-Sent Events
let lastEventCheckTimestamp = 0; // Timestamp последнего проверенного события
let colorizeStreamerNames = safeGetLocalStorage('colorizeStreamerNames') === 'true'; // Цветовая кодировка имен стримеров

// Настройки видимых колонок таблицы стримеров
let visibleColumns = {};
try {
    const columns = safeGetLocalStorage('visibleColumns') || '{"notify": true, "streamer": true, "status": true, "watchTime": true, "pointsEarned": true, "currentPoints": true, "game": true, "lastStreamStart": true, "lastStreamEnd": true, "actions": true}';
    visibleColumns = JSON.parse(columns);
} catch (e) {
    visibleColumns = {notify: true, streamer: true, status: true, watchTime: true, pointsEarned: true, currentPoints: true, game: true, lastStreamStart: true, lastStreamEnd: true, actions: true};
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

// Предыдущие значения статистики по стримерам (для отображения разницы)
// Эти значения обновляются только при изменении баллов
let previousStreamerStats = {};
try {
    const prevStats = safeGetLocalStorage('previousStreamerStats');
    if (prevStats) {
        previousStreamerStats = JSON.parse(prevStats);
    }
} catch (e) {
    previousStreamerStats = {};
}

// Сохраняем старое значение currentPoints для каждого стримера
// Это нужно для обновления previousPoints перед следующим изменением
let lastCurrentPoints = {};
try {
    const lastPoints = safeGetLocalStorage('lastCurrentPoints');
    if (lastPoints) {
        lastCurrentPoints = JSON.parse(lastPoints);
    }
} catch (e) {
    lastCurrentPoints = {};
}

/**
 * Last Activity с /api/overall (мс с последнего minute-watched / баллов)
 */
function formatOverallLastActivity(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return '—';
    }
    return formatTime(ms);
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
 * @returns {string} HEX цвет
 */
function generateColorFromString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    
    // Генерируем яркие, насыщенные цвета
    const hue = Math.abs(hash) % 360;
    const saturation = 60 + (Math.abs(hash) % 20); // 60-80%
    const lightness = 50 + (Math.abs(hash) % 15); // 50-65%
    
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
    return `
        <div class="stats-grid">
            ${Array.from({ length: 4 }).map(() => `
                <div class="skeleton-stat-card">
                    <div class="skeleton skeleton-stat-title"></div>
                    <div class="skeleton skeleton-stat-value"></div>
                    <div class="skeleton skeleton-stat-label"></div>
                </div>
            `).join('')}
        </div>
    `;
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
/** Режим ожидания перезапуска: update | restart */
let lifecycleWaitMode = null;
/** PID бота до update/restart (новый процесс = другой pid) */
let lifecycleWaitPreviousPid = null;
/** Время начала ожидания lifecycle (для сброса зависшего «Обновление…») */
let lifecycleWaitStartedAt = 0;
/** Если скрипт завершился, а PID бота не сменился — сброс UI через это время */
const LIFECYCLE_SAME_PID_ABORT_MS = 45_000;

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
    const inProgress = info?.dashboardUpdateInProgress === true;
    const blocked = info?.dashboardUpdateBlockedReason;

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
    versionCardBusy = true;
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
    return data;
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

    const detailParts = [
        `<span class="version-status-pill version-status-pill--${uiState}">${escapeHtml(indicatorLabel)}</span>`,
        `Локально: git ${escapeHtml(health.gitRevision || st?.localRevision || '—')}`,
    ];

    if (st?.remoteRevision && uiState === 'available') {
        detailParts.push(
            `${escapeHtml(st.remote || 'origin')}/${escapeHtml(st.branch || 'dev')}: ` +
                `<strong>${escapeHtml(st.remoteRevision)}</strong>`
        );
    }
    if (st?.error) {
        detailParts.push(escapeHtml(st.error));
    }
    if (st?.checkSkippedReason) {
        detailParts.push(escapeHtml(st.checkSkippedReason));
    }
    if (st?.dashboardUpdateEnabled === false && uiState === 'available') {
        detailParts.push('Для установки: DASHBOARD_UPDATE_ENABLED=true в .env');
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
                `На ${st.remote}/${st.branch} есть ${st.remoteRevision}. Включите DASHBOARD_UPDATE_ENABLED=true в .env`
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
        `Будет выполнено: git fetch → reset на origin/${st.branch} (${st.remoteRevision}) → ` +
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
    if (hasNewBotPidAfterLifecycle(info.pid)) {
        return true;
    }
    if (info.dashboardUpdateInProgress === true) {
        return false;
    }
    return true;
}

function isUpdateCheckReadyAfterLifecycle(data) {
    if (!data) {
        return false;
    }
    if (data.dashboardUpdateInProgress === true || data.uiState === 'updating') {
        if (!data.serverPid || !hasNewBotPidAfterLifecycle(data.serverPid)) {
            return false;
        }
    }
    if (hasNewBotPidAfterLifecycle(data.serverPid)) {
        return true;
    }
    return data.dashboardUpdateInProgress !== true && data.uiState !== 'updating';
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
    if (data) {
        versionUpdateStatus = data;
        if (lastBotHealthForVersion) {
            patchBotHealthVersionCard(lastBotHealthForVersion);
        }
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
    updateConnectionStatus(false);
    setLifecycleHeaderText(headerText || 'Disconnected');
    pollVersionUpdateStatus(true);
}

function scheduleDashboardReload(successMessage) {
    stopDashboardReconnectWatch();
    versionCardBusy = false;
    lifecycleWaitMode = null;
    lifecycleWaitPreviousPid = null;
    lifecycleWaitStartedAt = 0;
    if (typeof showNotification === 'function') {
        showNotification('success', successMessage || 'Бот снова online. Перезагрузка страницы…');
    }
    setLifecycleHeaderText('Перезагрузка страницы…');
    setTimeout(() => window.location.reload(), 400);
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
    if (isServerReadyAfterLifecycle(info)) {
        const upd = await fetchData(`/app-update-check?_=${Date.now()}`);
        finishLifecycleFromServer(
            upd || null,
            reconnectWatchSuccessMessage || 'Бот снова online. Перезагрузка страницы…'
        );
        return;
    }

    const updCheck = await fetchData(`/app-update-check?_=${Date.now()}`);
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

function startDashboardReconnectWatch(successMessage, mode = 'restart') {
    lifecycleWaitMode = mode;
    reconnectWatchSuccessMessage = successMessage;
    reconnectWatchLabel = mode === 'update' ? 'Обновление' : 'Перезапуск';
    reconnectWatchAttempts = 0;
    stopDashboardReconnectWatch();

    if (lifecycleWaitPreviousPid == null) {
        captureLifecycleWaitPid();
    }

    versionUpdateFastPollTimer = setInterval(runReconnectLifecycleTick, RECONNECT_POLL_MS);
    runReconnectLifecycleTick();
}

function onDashboardVisibilityForLifecycle() {
    if (document.visibilityState === 'visible' && lifecycleWaitMode) {
        runReconnectLifecycleTick();
    }
}

function stopDashboardReconnectWatch() {
    if (versionUpdateFastPollTimer) {
        clearInterval(versionUpdateFastPollTimer);
        versionUpdateFastPollTimer = null;
    }
}

async function triggerDashboardAppUpdate() {
    if (typeof showNotification === 'function') {
        showNotification('info', 'Запуск обновления…');
    }

    await captureLifecycleWaitPid();
    const result = await postApi('/app-update', {});

    if (result.ok) {
        if (typeof showNotification === 'function') {
            showNotification('success', result.message);
        }
        beginLifecycleWaitUi('update');
        startDashboardReconnectWatch('Обновление завершено. Перезагрузка страницы…', 'update');
    } else {
        resetDashboardLifecycleUi('Disconnected');
        if (typeof showNotification === 'function') {
            showNotification('error', result.message || 'Не удалось запустить обновление');
        } else {
            alert(result.message || 'Не удалось запустить обновление');
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
    return formatHealthDuration(Date.now() - timestamp) + ' назад';
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

function describeIntegrityHealth(integrity) {
    if (!integrity) {
        return { label: '—', kind: 'off', detail: '' };
    }
    const sourceLabel = integrity.source === 'manual' ? 'manual (DevTools)' : 'api (POST /integrity)';
    let kind = 'off';
    let label = 'Не настроен';
    if (!integrity.configured) {
        label = integrity.source === 'manual' ? 'Токен не задан' : '—';
    } else if (integrity.valid) {
        kind = 'ok';
        label = 'Действует';
    } else {
        kind = 'warn';
        label = 'Истёк / недействителен';
    }
    let detail = `Режим: ${escapeHtml(sourceLabel)}`;
    if (integrity.expiresInMs != null) {
        detail += `<br>Истекает через: ${escapeHtml(formatHealthDuration(integrity.expiresInMs))}`;
    }
    detail += `<br>Device: ${escapeHtml(integrity.deviceIdPrefix || '—')}…`;
    if (integrity.fallbackApiEnabled) {
        detail += '<br>Fallback API: включён';
    }
    return { label, kind, detail };
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
 * Обновляет панель «Статус бота»
 */
async function updateBotHealth() {
    const grid = document.getElementById('botHealthGrid');
    const claimsEl = document.getElementById('botHealthClaims');
    if (!grid) {
        return;
    }

    const health = await fetchData('/bot-health');
    if (!health || health.error) {
        grid.innerHTML = `<p class="bot-health-empty">${escapeHtml(health?.error || 'Watcher не запущен')}</p>`;
        if (claimsEl) {
            claimsEl.innerHTML = '<p class="bot-health-empty">—</p>';
        }
        updateConnectionStatus(false);
        return;
    }

    updateConnectionStatus(health.websocket?.status === 'connected');
    lastBotHealthForVersion = health;

    const ws = describeWebSocketHealth(health.websocket);
    const integrity = describeIntegrityHealth(health.integrity);
    const gql = describeCircuitBreaker(health.graphql);

    let watcherKind = health.watcherRunning ? 'ok' : 'err';
    const watcherLabel = health.watcherRunning ? 'Работает' : 'Остановлен';

    let integrityFailDetail = '';
    if (health.lastIntegrityFailure) {
        integrityFailDetail = `Последний integrity: ${escapeHtml(health.lastIntegrityFailure.streamer)} — ${escapeHtml(formatHealthTimeAgo(health.lastIntegrityFailure.timestamp))}`;
    }

    const cards = [
        renderVersionHealthCard(health),
        renderBotHealthCard('Просмотр', escapeHtml(watcherLabel), '', watcherKind),
        renderBotHealthCard('WebSocket', escapeHtml(ws.label), ws.detail, ws.kind),
        renderBotHealthCard('Integrity', escapeHtml(integrity.label), integrity.detail, integrity.kind),
        renderBotHealthCard('GraphQL CB', escapeHtml(gql.label), gql.detail, gql.kind),
    ];

    if (integrityFailDetail) {
        cards.push(
            renderBotHealthCard(
                'Integrity ошибка',
                'failed integrity check',
                integrityFailDetail,
                'warn'
            )
        );
    }

    grid.innerHTML = cards.join('');
    bindBotHealthVersionCardClick();

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

// Сохраняем предыдущие значения для анимации изменений
let previousStats = {
    activeWatches: 0,
    totalPointsEarned: 0,
    streamersCount: 0,
    lastActivity: 0
};

async function updateOverallStats() {
    const statsContainer = document.querySelector('.stats-grid');
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
    lastDataUpdate.overall = Date.now();
    updateStaleDataIndicator('overall', statsContainer);

    // Если был skeleton, заменяем плавно
    if (statsContainer && statsContainer.querySelector('.skeleton-stat-card')) {
        const newContent = `
            <div class="stat-card">
                <h3>Active Watches</h3>
                <div class="value" id="activeWatches">${(stats.activeWatches || 0).toLocaleString()}</div>
                <div class="label">Currently watching</div>
            </div>
            <div class="stat-card">
                <h3>Total Points</h3>
                <div class="value" id="totalPoints">${(stats.totalPointsEarned || 0).toLocaleString()}</div>
                <div class="label">Points earned</div>
            </div>
            <div class="stat-card">
                <h3>Streamers</h3>
                <div class="value" id="streamersCount">${(stats.streamersCount || 0).toLocaleString()}</div>
                <div class="label">Total streamers</div>
            </div>
            <div class="stat-card">
                <h3>Last Activity</h3>
                <div class="value" id="lastActivity">${formatOverallLastActivity(stats.lastActivity)}</div>
                <div class="label">Since last event</div>
            </div>
        `;
        replaceSkeletonWithContent(statsContainer, newContent);
    } else {
        // Обычное обновление с анимацией
        const cards = document.querySelectorAll('.stat-card');
        cards.forEach(card => {
            card.classList.add('updating');
            setTimeout(() => card.classList.remove('updating'), 300);
        });

        // Обновляем значения с анимацией изменений
        updateValueWithAnimation('activeWatches', stats.activeWatches || 0, previousStats.activeWatches);
        updateValueWithAnimation('totalPoints', stats.totalPointsEarned || 0, previousStats.totalPointsEarned);
        updateValueWithAnimation('streamersCount', stats.streamersCount || 0, previousStats.streamersCount);
        
        const lastActivityEl = document.getElementById('lastActivity');
        if (lastActivityEl) {
            const newValue = formatOverallLastActivity(stats.lastActivity);
            if (lastActivityEl.textContent !== newValue) {
                lastActivityEl.classList.add('value-change');
                lastActivityEl.textContent = newValue;
                setTimeout(() => lastActivityEl.classList.remove('value-change'), 500);
            } else {
                lastActivityEl.textContent = newValue;
            }
        }
    }

    // Сохраняем текущие значения
    previousStats = {
        activeWatches: stats.activeWatches || 0,
        totalPointsEarned: stats.totalPointsEarned || 0,
        streamersCount: stats.streamersCount || 0,
        lastActivity: stats.lastActivity || 0
    };
}

/**
 * Обновляет значение с анимацией изменения
 * @param {string} elementId ID элемента
 * @param {number} newValue Новое значение
 * @param {number} oldValue Старое значение
 */
function updateValueWithAnimation(elementId, newValue, oldValue) {
    const element = document.getElementById(elementId);
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
    void updateAll();
    setTimeout(() => {
        if (loadingScreen.parentNode) {
            loadingScreen.remove();
        }
    }, 500);
}

/**
 * Проверяет, отвечает ли API статистикой (приложение уже работает)
 */
async function isApplicationReadyViaStats() {
    try {
        const response = await fetch(`${API_BASE}/statistics?includeOffline=true`);
        if (!response.ok) {
            return false;
        }
        const stats = await response.json();
        return Array.isArray(stats) && stats.length > 0;
    } catch {
        return false;
    }
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
            if (initializationPollCount >= 8 && await isApplicationReadyViaStats()) {
                hideLoadingScreen();
                return;
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
            setTimeout(() => {
                hideLoadingScreen();
                void updateOverallStats();
            }, 300);
            return;
        }

        // Fallback: бэкенд уже отдаёт стримеров, но progress не обновился
        if (initializationPollCount >= 3 && await isApplicationReadyViaStats()) {
            hideLoadingScreen();
            return;
        }

        setTimeout(checkInitializationStatus, 500);
    } catch (error) {
        statusText.textContent = 'Connecting to server...';
        if (initializationPollCount >= 8 && await isApplicationReadyViaStats()) {
            hideLoadingScreen();
            return;
        }
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
                comparison = Number(valueA) - Number(valueB);
                break;
            case 'game':
                comparison = valueA.localeCompare(valueB);
                break;
            case 'watchTime':
            case 'pointsEarned':
            case 'currentPoints':
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
    const isTimeColumn = column === 'lastStreamStart' || column === 'lastStreamEnd';
    
    // Если кликнули на ту же колонку, меняем направление сортировки
    if (tableSort.column === column) {
        tableSort.direction = tableSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        // Если кликнули на другую колонку, устанавливаем новую колонку и направление по умолчанию
        tableSort.column = column;
        // Для временных колонок начальное направление - desc, для остальных - asc
        tableSort.direction = isTimeColumn ? 'desc' : 'asc';
    }

    // Сохраняем настройки сортировки в localStorage
    safeSetLocalStorage('tableSort', JSON.stringify(tableSort));

    // Обновляем таблицу
    updateStatistics();
};

async function updateStatistics() {
    const table = document.getElementById('watchesTable');
    const hasContent = table && table.querySelector('table');
    const hasSkeleton = table && table.querySelector('.skeleton-table');
    
    // Показываем skeleton только при первой загрузке (когда нет контента и нет skeleton)
    if (!hasContent && !hasSkeleton && table) {
        table.innerHTML = generateTableSkeleton(5);
    }
    
    // Запрашиваем всех стримеров, включая офлайн
    const stats = await fetchData('/statistics?includeOffline=true');
    
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

    try {
        const statusChanges = detectStreamerStatusChanges(stats);
        if (statusChanges.length > 0) {
            processStreamStatusNotifications(statusChanges);
        }
    } catch (e) {
        console.warn('Stream status notifications failed:', e);
    }

    // Фильтруем офлайн стримеров, если они скрыты
    let filteredStats = stats;
    if (!showOffline) {
        filteredStats = stats.filter(s => s.status === 'ONLINE');
    }

    // Сохраняем предыдущие значения для отображения разницы
    // Используем lastCurrentPoints, если он отличается от текущего, иначе previousStreamerStats
    const currentPreviousStats = {};
    stats.forEach(s => {
        if (s.streamerName) {
            const streamerName = s.streamerName;
            const currentPointsEarned = s.pointsEarned || 0;
            const currentCurrentPoints = s.currentPoints || 0;
            const lastPointsEarned = lastCurrentPoints[streamerName]?.pointsEarned;
            const lastCurrentPointsValue = lastCurrentPoints[streamerName]?.currentPoints;
            const prevPointsEarned = previousStreamerStats[streamerName]?.pointsEarned;
            const prevCurrentPoints = previousStreamerStats[streamerName]?.currentPoints;
            
            if (lastPointsEarned !== undefined && lastPointsEarned !== currentPointsEarned) {
                currentPreviousStats[streamerName] = { 
                    pointsEarned: lastPointsEarned,
                    currentPoints: lastCurrentPointsValue !== undefined ? lastCurrentPointsValue : prevCurrentPoints
                };
            } else if (lastCurrentPointsValue !== undefined && lastCurrentPointsValue !== currentCurrentPoints) {
                currentPreviousStats[streamerName] = { 
                    pointsEarned: lastPointsEarned !== undefined ? lastPointsEarned : prevPointsEarned,
                    currentPoints: lastCurrentPointsValue
                };
            } else if (previousStreamerStats[streamerName]) {
                currentPreviousStats[streamerName] = { ...previousStreamerStats[streamerName] };
            }
        }
    });
    
    stats.forEach(s => {
        if (s.streamerName) {
            const streamerName = s.streamerName;
            const currentPointsEarned = s.pointsEarned || 0;
            const currentCurrentPoints = s.currentPoints || 0;
            const prevPointsEarned = previousStreamerStats[streamerName]?.pointsEarned;
            const prevCurrentPoints = previousStreamerStats[streamerName]?.currentPoints;
            const lastPointsEarned = lastCurrentPoints[streamerName]?.pointsEarned;
            const lastCurrentPointsValue = lastCurrentPoints[streamerName]?.currentPoints;
            
            if (prevPointsEarned === undefined) {
                previousStreamerStats[streamerName] = {
                    pointsEarned: currentPointsEarned,
                    currentPoints: currentCurrentPoints
                };
                lastCurrentPoints[streamerName] = {
                    pointsEarned: currentPointsEarned,
                    currentPoints: currentCurrentPoints
                };
            } else {
                const pointsEarnedChanged = prevPointsEarned !== currentPointsEarned;
                const currentPointsChanged = prevCurrentPoints !== currentCurrentPoints;
                
                if (pointsEarnedChanged || currentPointsChanged) {
                    // Определяем старое значение: если lastCurrentPoints равен currentPoints,
                    // используем previousStreamerStats, иначе lastCurrentPoints
                    let newPrevPointsEarned, newPrevCurrentPoints;
                    const lastPointsEarnedChanged = lastPointsEarned !== undefined && lastPointsEarned !== currentPointsEarned;
                    const lastCurrentPointsChanged = lastCurrentPointsValue !== undefined && lastCurrentPointsValue !== currentCurrentPoints;
                    
                    if (!lastPointsEarnedChanged && !lastCurrentPointsChanged && (lastPointsEarned !== undefined || lastCurrentPointsValue !== undefined)) {
                        newPrevPointsEarned = prevPointsEarned;
                        newPrevCurrentPoints = prevCurrentPoints;
                    } else {
                        newPrevPointsEarned = lastPointsEarned !== undefined ? lastPointsEarned : prevPointsEarned;
                        newPrevCurrentPoints = lastCurrentPointsValue !== undefined ? lastCurrentPointsValue : prevCurrentPoints;
                    }
                    
                    previousStreamerStats[streamerName] = {
                        pointsEarned: newPrevPointsEarned,
                        currentPoints: newPrevCurrentPoints
                    };
                    
                    lastCurrentPoints[streamerName] = {
                        pointsEarned: currentPointsEarned,
                        currentPoints: currentCurrentPoints
                    };
                }
            }
        }
    });
    
    safeSetLocalStorage('previousStreamerStats', JSON.stringify(previousStreamerStats));
    safeSetLocalStorage('lastCurrentPoints', JSON.stringify(lastCurrentPoints));
    
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
        { key: 'lastStreamStart', label: 'Last Stream Start', visible: visibleColumns.lastStreamStart !== false },
        { key: 'lastStreamEnd', label: 'Last Stream End', visible: visibleColumns.lastStreamEnd !== false },
        { key: 'actions', label: 'Actions', visible: visibleColumns.actions !== false }
    ];
    
    const visibleColumnsList = columns.filter(c => c.visible);
    
    const tableContent = `
        <table>
            <thead>
                <tr>
                    ${visibleColumnsList.map(col => {
                        // Определяем, можно ли сортировать эту колонку
                        const isSortable = ['streamer', 'lastStreamStart', 'lastStreamEnd'].includes(col.key);
                        const isSorted = tableSort.column === col.key;
                        const sortIcon = isSorted 
                            ? (tableSort.direction === 'asc' ? ' ▲' : ' ▼')
                            : (isSortable ? ' ↕' : '');
                        const sortClass = isSorted ? ` sort-${tableSort.direction}` : '';
                        const clickHandler = col.key === 'notify'
                            ? ' onclick="toggleAllStreamerNotifications()"'
                            : (isSortable ? ` onclick="handleTableSort('${col.key}')"` : '');
                        const cursorStyle = (col.key === 'notify' || isSortable)
                            ? ' style="cursor: pointer; user-select: none;"'
                            : '';
                        const notifyClass = col.key === 'notify' ? ' notify-header notify-header-clickable' : '';
                        const notifyTitle = col.key === 'notify' ? ` title="${notifyHeaderTitle}"` : '';
                        
                        return `<th class="table-header${notifyClass}${isSortable ? ' sortable' : ''}${sortClass}"${clickHandler}${cursorStyle}${notifyTitle}>${col.label}${sortIcon}</th>`;
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
                        ${visibleColumns.game !== false ? `<td>${s.game || '-'}</td>` : ''}
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
    
    // previousStreamerStats уже обновлен выше, перед отображением разницы
    // Это гарантирует, что при следующем обновлении previous будет равен текущему значению
}


// Timestamp последнего обновления данных
let lastDataUpdate = {
    stats: 0,
    overall: 0
};

const STALE_DATA_THRESHOLD = 30000; // 30 секунд

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
                    + 'Включите WEB_SERVER_HTTPS=true в .env на сервере и откройте https://IP:3001, '
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
    // Останавливаем текущее обновление
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
    if (eventSource) {
        eventSource.close();
        eventSource = null;
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
    // Загружаем начальные данные
    await updateAll();
    
    // Инициализируем timestamp последнего события
    try {
        const response = await fetchData(`/events?limit=1&offset=0`);
        if (response && response.events && response.events.length > 0) {
            lastEventCheckTimestamp = response.events[0].timestamp;
        }
    } catch (error) {
        // Игнорируем ошибки
    }
    
    // Начинаем проверку новых событий
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
    
    // Проверяем снова через небольшую задержку (polling)
    if (updateMode === 'event') {
        setTimeout(checkForNewEvents, 2000); // Проверяем каждые 2 секунды
    }
}

function startAutoUpdate() {
    updateAll();
    
    // Проверка подключения при старте
    updateConnectionStatus(false);
    
    // Запускаем обновление в зависимости от режима
    if (updateMode === 'event') {
        startEventBasedUpdate();
    } else {
        updateInterval = setInterval(updateAll, updateIntervalMs);
    }
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
    
    // Обновляем таблицу
    updateStatistics();
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
    checkInitializationStatus();
    initAppUpdateButton();
    initProcessControlButtons();
    startVersionUpdatePolling();
    startAutoUpdate();
    if (!document.documentElement.dataset.lifecycleVisibilityBound) {
        document.documentElement.dataset.lifecycleVisibilityBound = '1';
        document.addEventListener('visibilitychange', onDashboardVisibilityForLifecycle);
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
    
    // Обработчик для кнопки настроек
    const testBtn = document.getElementById('testBtn');
    if (testBtn) {
        testBtn.addEventListener('click', showTestModal);
    }

    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', showSettingsModal);
    }
    
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
    });
    
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
 * Показывает панель настроек
 */
function showSettingsModal() {
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

    const apiKeyInput = document.getElementById('dashboardApiKeySetting');
    if (apiKeyInput) {
        apiKeyInput.value = getDashboardApiKey();
    }

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

    const apiKeyInput = document.getElementById('dashboardApiKeySetting');
    if (apiKeyInput) {
        setDashboardApiKey(apiKeyInput.value.trim());
    }

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
    showNotification('success', 'Настройки сохранены');
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

window.addEventListener('beforeunload', () => {
    if (updateInterval) {
        clearInterval(updateInterval);
    }
    if (eventSource) {
        eventSource.close();
    }
});

