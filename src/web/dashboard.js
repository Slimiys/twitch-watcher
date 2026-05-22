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

let selectedEventTags = new Set();
try {
    const tags = safeGetLocalStorage('selectedEventTags') || '[]';
    selectedEventTags = new Set(JSON.parse(tags));
} catch (e) {
    selectedEventTags = new Set();
}

let availableEventTags = new Set(); // Доступные теги из событий

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

// Пагинация событий
let eventsPageSize = 20; // Количество событий на странице
let eventsOffset = 0; // Текущий offset для загрузки старых событий при прокрутке
let allLoadedEvents = []; // Все загруженные события
let isLoadingEvents = false; // Флаг загрузки событий
let hasMoreEvents = true; // Есть ли еще события для загрузки

// Ленивая инициализация плагина зума Chart.js
function getZoomPlugin() {
    if (zoomPlugin !== null) return zoomPlugin;

    let plugin = null;
    if (typeof ChartZoom !== 'undefined') {
        plugin = ChartZoom;
    } else if (typeof window !== 'undefined') {
        if (window.ChartZoom) {
            plugin = window.ChartZoom;
        } else if (window.Chart && window.Chart.registry && window.Chart.registry.plugins) {
            const registeredPlugins = Array.from(window.Chart.registry.plugins.values());
            plugin = registeredPlugins.find(p => p.id === 'zoom');
        }
    }

    zoomPlugin = plugin;

    // Пытаемся зарегистрировать плагин, если он найден и еще не зарегистрирован
    if (zoomPlugin && window.Chart) {
        try {
            const registeredPlugins = window.Chart.registry?.plugins
                ? Array.from(window.Chart.registry.plugins.values())
                : [];
            const isRegistered = registeredPlugins.some(p =>
                p.id === 'zoom' ||
                p === zoomPlugin ||
                (zoomPlugin.id && p.id === zoomPlugin.id)
            );

            if (!isRegistered) {
                window.Chart.register(zoomPlugin);
            }
        } catch (e) {
            // Игнорируем ошибки регистрации (например, если плагин уже зарегистрирован)
        }
    }

    return zoomPlugin;
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

/**
 * Получает иконку для типа события
 * @param {string} eventType Тип события
 * @returns {string} Эмодзи иконка
 */
function getEventIcon(eventType) {
    const iconMap = {
        'points-earned': '💰',
        'claim-earned': '🎁',
        'claim-success': '✅',
        'stream-up': '📺',
        'stream-down': '📴',
        'token-expired': '⏰',
        'token-invalid': '❌',
        'raid-joined': '⚔️',
        'bonus-claimed': '🎯',
        'error': '⚠️',
        'warning': '🔔',
        'info': 'ℹ️',
        'success': '✓'
    };
    
    // Ищем точное совпадение или частичное
    for (const [key, icon] of Object.entries(iconMap)) {
        if (eventType.toLowerCase().includes(key.toLowerCase())) {
            return icon;
        }
    }
    
    return '📌'; // Иконка по умолчанию
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
 * Генерирует skeleton loader для графика
 * @returns {string} HTML код skeleton loader
 */
/**
 * Генерирует skeleton loader для списка событий
 * @param {number} items Количество элементов
 * @returns {string} HTML код skeleton loader
 */
function generateEventsSkeleton(items = 5) {
    return `
        <div class="events-list">
            ${Array.from({ length: items }).map(() => `
                <div class="skeleton-event-item">
                    <div class="skeleton skeleton-event-time"></div>
                    <div class="skeleton skeleton-event-icon"></div>
                    <div class="skeleton skeleton-event-type"></div>
                    <div class="skeleton skeleton-event-content"></div>
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

async function fetchData(endpoint) {
    try {
        const response = await fetch(`${API_BASE}${endpoint}`);
        if (!response.ok) {
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
                <div class="value" id="lastActivity">${formatTime(stats.lastActivity || 0)}</div>
                <div class="label">Time ago</div>
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
            const newValue = formatTime(stats.lastActivity || 0);
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
            setTimeout(hideLoadingScreen, 300);
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
    const columns = [
        { key: 'notify', label: '🔔', visible: visibleColumns.notify !== false },
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
                        const clickHandler = isSortable ? ` onclick="handleTableSort('${col.key}')"` : '';
                        const cursorStyle = isSortable ? ' style="cursor: pointer; user-select: none;"' : '';
                        
                        return `<th class="table-header${isSortable ? ' sortable' : ''}${sortClass}"${clickHandler}${cursorStyle}>${col.label}${sortIcon}</th>`;
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
                                <button type="button"
                                    class="streamer-notify-toggle ${notifyOn ? 'streamer-notify-on' : 'streamer-notify-off'}"
                                    data-streamer="${safeAttr}"
                                    onclick="toggleStreamerNotify(this)"
                                    title="${notifyOn ? 'Уведомления включены' : 'Уведомления выключены'}">${notifyOn ? '🔔' : '🔕'}</button>
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

let pointsHistoryCache = []; // Кэш для доступа к истории в tooltip

// Функции графика удалены - раздел Points History временно отключен
async function updatePointsChart() {
    // Функция отключена - раздел Points History временно удален
    return;
}

/**
 * Обновляет индикатор устаревших данных
        const canvas = document.getElementById('pointsChart');
        if (canvas && canvas.parentElement) {
            canvas.parentElement.innerHTML = generateChartSkeleton();
        }
    }
    
    const history = await fetchData('/points-history?limit=200');
    pointsHistoryCache = history || []; // Сохраняем в кэш для tooltip
    
    // Получаем текущую статистику для добавления актуальных значений в график
    const currentStats = await fetchData('/statistics?includeOffline=true');
    
    // Если был skeleton, восстанавливаем canvas (даже если данных нет)
    if (chartContainer && chartContainer.querySelector('.skeleton-chart')) {
        chartContainer.innerHTML = '<canvas id="pointsChart"></canvas>';
    }
    
    // Убеждаемся, что canvas существует
    const canvas = document.getElementById('pointsChart');
    if (!canvas) {
        console.error('Canvas element not found');
        return;
    }
    
    // Инициализируем плагин зума один раз перед созданием графика
    const zoomPluginInstance = getZoomPlugin();

    // Если данных нет, создаем или обновляем пустой график
    if (!history || history.length === 0) {
        // Скрываем статистику
        const statsGrid = document.getElementById('chartStatsGrid');
        if (statsGrid) statsGrid.style.display = 'none';
        
        // Если график еще не создан, создаем его с пустыми данными
        if (!pointsChart) {
            // Создаем пустой график
            pointsChart = new Chart(canvas, {
                type: 'line',
                data: {
                    datasets: []
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        intersect: false,
                        mode: 'index'
                    },
                    animation: {
                        duration: 0
                    },
                    plugins: {
                        legend: {
                            labels: { 
                                color: '#efeff1',
                                usePointStyle: true,
                                padding: 15
                            },
                            position: 'top'
                        },
                        tooltip: {
                            backgroundColor: 'rgba(0, 0, 0, 0.8)',
                            titleColor: '#efeff1',
                            bodyColor: '#efeff1',
                            borderColor: '#26262c',
                            borderWidth: 1
                        }
                    },
                    scales: {
                        x: {
                            type: 'time',
                            time: {
                                unit: 'day',
                                displayFormats: {
                                    day: 'MMM dd',
                                    week: 'MMM dd',
                                    month: 'MMM yyyy'
                                },
                                tooltipFormat: 'MMM dd, yyyy'
                            },
                            ticks: { 
                                color: '#adadb8',
                                maxTicksLimit: 15,
                                source: 'data'
                            },
                            grid: { 
                                color: '#26262c' 
                            },
                            title: {
                                display: true,
                                text: 'Date',
                                color: '#adadb8'
                            },
                            bounds: 'data',
                            offset: true
                        },
                        y: { 
                            ticks: { 
                                color: '#adadb8' 
                            }, 
                            grid: { 
                                color: '#26262c' 
                            },
                            title: {
                                display: true,
                                text: chartMode === 'accumulated' ? 'Total Points Earned' : 'Points per Day',
                                color: '#adadb8'
                            },
                            beginAtZero: true
                        }
                    },
                    plugins: {
                        zoom: {
                            pan: {
                                enabled: true,
                                mode: 'x',
                                modifierKey: null
                            },
                            zoom: {
                                wheel: {
                                    enabled: true,
                                    modifierKey: 'ctrl'
                                },
                                pinch: {
                                    enabled: true
                                },
                                mode: 'x',
                                limits: {
                                    x: {
                                        min: 'original',
                                        max: 'original'
                                    }
                                }
                            }
                        }
                    }
                },
                plugins: zoomPluginInstance ? [zoomPluginInstance] : []
            });
        } else {
            // Если график уже создан, очищаем данные
            pointsChart.data.labels = [];
            pointsChart.data.datasets = [];
            pointsChart.update();
        }
        
        lastDataUpdate.chart = Date.now();
        if (chartContainer) {
            updateStaleDataIndicator('chart', chartContainer);
        }
        return;
    }
    
    // Фильтруем по периоду
    let filteredHistory = filterHistoryByPeriod(history, chartPeriod);
    
    // Добавляем текущие значения из статистики как последнюю точку для каждого стримера
    if (currentStats && currentStats.length > 0) {
        const now = new Date();
        
        currentStats.forEach(stat => {
            if (stat.status === 'ONLINE' && stat.pointsEarned > 0) {
                // Находим последнюю точку в истории для этого стримера
                const streamerHistory = filteredHistory.filter(h => h.streamer === stat.streamerName);
                const lastHistoryPoint = streamerHistory.length > 0 
                    ? streamerHistory[streamerHistory.length - 1]
                    : null;
                
                // Проверяем, нужно ли добавить текущую точку
                // Добавляем, если последней точки нет или она старше 30 секунд
                const shouldAdd = !lastHistoryPoint || 
                    (now.getTime() - new Date(lastHistoryPoint.timestamp).getTime() > 30000);
                
                if (shouldAdd) {
                    // Вычисляем разницу баллов для добавления в историю
                    let pointsToAdd = 0;
                    if (chartMode === 'accumulated') {
                        // В режиме накопленных баллов вычисляем разницу от последней точки
                        const lastTotal = lastHistoryPoint ? (lastHistoryPoint.totalPoints || 0) : 0;
                        pointsToAdd = stat.pointsEarned - lastTotal;
                    } else {
                        // В режиме дневных баллов вычисляем баллы за сегодня
                        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                        const todayPoints = streamerHistory
                            .filter(h => {
                                const hDate = new Date(h.timestamp);
                                return hDate >= todayStart;
                            })
                            .reduce((sum, h) => sum + h.points, 0);
                        // Вычисляем разницу от уже учтенных баллов за сегодня
                        pointsToAdd = Math.max(0, stat.pointsEarned - todayPoints);
                    }
                    
                    // Добавляем точку только если есть изменение
                    if (pointsToAdd > 0 || !lastHistoryPoint) {
                        filteredHistory.push({
                            timestamp: now.getTime(),
                            streamer: stat.streamerName,
                            points: pointsToAdd,
                            totalPoints: chartMode === 'accumulated' ? stat.pointsEarned : undefined
                        });
                    }
                }
            }
        });
        
        // Сортируем историю по времени после добавления новых точек
        filteredHistory.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }
    
    // Вычисляем статистику
    const stats = calculateChartStats(filteredHistory, chartMode);
    updateChartStats(stats);
    
    // Группируем по стримерам и дням, суммируя баллы за каждый день
    const streamersMap = new Map();
    
    filteredHistory.forEach(entry => {
        const date = new Date(entry.timestamp);
        // Нормализуем дату до начала дня (00:00:00)
        const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const dayKey = dayStart.toISOString().split('T')[0]; // YYYY-MM-DD
        
        if (!streamersMap.has(entry.streamer)) {
            streamersMap.set(entry.streamer, new Map());
        }
        
        const daysMap = streamersMap.get(entry.streamer);
        if (!daysMap.has(dayKey)) {
            daysMap.set(dayKey, {
                date: dayStart,
                points: 0
            });
        }
        
        // Суммируем баллы за день
        daysMap.get(dayKey).points += entry.points;
    });
    
    // Преобразуем в формат для графика
    const datasetsData = new Map();
    streamersMap.forEach((daysMap, streamer) => {
        // Преобразуем Map в массив и сортируем по дате
        const daysArray = Array.from(daysMap.entries())
            .map(([dayKey, data]) => ({
                x: data.date,
                y: data.points,
                dayKey: dayKey
            }))
            .sort((a, b) => a.x.getTime() - b.x.getTime());
        
        // В зависимости от режима вычисляем накопленную сумму или оставляем дневные значения
        let processedData;
        if (chartMode === 'accumulated') {
            let accumulatedPoints = 0;
            processedData = daysArray.map(point => {
                accumulatedPoints += point.y;
                return {
                    x: point.x,
                    y: accumulatedPoints,
                    dayKey: point.dayKey
                };
            });
        } else {
            // Режим дневных баллов
            processedData = daysArray.map(point => ({
                x: point.x,
                y: point.y,
                dayKey: point.dayKey
            }));
        }
        
        datasetsData.set(streamer, processedData);
    });

    // Создаем цвета для каждого стримера
    const colors = [
        '#9147ff', '#00d166', '#ffc107', '#ff6b6b', '#4ecdc4',
        '#45b7d1', '#f7b731', '#5f27cd', '#00d2d3', '#ff6348'
    ];
    let colorIndex = 0;

    const datasets = Array.from(datasetsData.entries()).map(([streamer, data]) => {
        const color = colors[colorIndex % colors.length];
        colorIndex++;
        return {
            label: streamer,
            data: data,
            borderColor: color,
            backgroundColor: color + '40', // Добавляем прозрачность
            tension: 0.4,
            fill: false,
            pointRadius: 3,
            pointHoverRadius: 5
        };
    });

    if (!pointsChart) {
        pointsChart = new Chart(canvas, {
            type: 'line',
            data: {
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                animation: {
                    duration: 0
                },
                plugins: {
                    legend: {
                        labels: { 
                            color: '#efeff1',
                            usePointStyle: true,
                            padding: 15
                        },
                        position: 'top',
                        onClick: function(e, legendItem, legend) {
                            // Переключаем видимость линии при клике на легенду
                            const index = legendItem.datasetIndex;
                            const chart = legend.chart;
                            const meta = chart.getDatasetMeta(index);
                            
                            meta.hidden = meta.hidden === null ? !chart.data.datasets[index].hidden : null;
                            chart.update();
                            
                            // Показываем кнопку Reset Zoom если график изменен
                            const resetBtn = document.getElementById('resetZoomBtn');
                            if (resetBtn) {
                                resetBtn.style.display = 'flex';
                            }
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: '#efeff1',
                        bodyColor: '#efeff1',
                        borderColor: '#26262c',
                        borderWidth: 1,
                        callbacks: {
                            title: function(context) {
                                const date = new Date(context[0].parsed.x);
                                return date.toLocaleDateString('ru-RU', { 
                                    year: 'numeric', 
                                    month: 'long', 
                                    day: 'numeric' 
                                });
                            },
                            label: function(context) {
                                const pointIndex = context.dataIndex;
                                const dataset = context.dataset;
                                const dataPoint = dataset.data[pointIndex];
                                
                                // Находим все события за этот день для этого стримера
                                const dayStart = new Date(dataPoint.x);
                                dayStart.setHours(0, 0, 0, 0);
                                const dayEnd = new Date(dayStart);
                                dayEnd.setHours(23, 59, 59, 999);
                                
                                const dayEvents = pointsHistoryCache.filter(e => 
                                    e.streamer === dataset.label && 
                                    new Date(e.timestamp) >= dayStart &&
                                    new Date(e.timestamp) <= dayEnd
                                );
                                
                                const pointsGained = dayEvents.reduce((sum, e) => sum + e.points, 0);
                                
                                if (chartMode === 'accumulated') {
                                    return `${dataset.label}: ${context.parsed.y.toLocaleString()} total (+${pointsGained.toLocaleString()} this day)`;
                                } else {
                                    return `${dataset.label}: ${context.parsed.y.toLocaleString()} points`;
                                }
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'day',
                            displayFormats: {
                                day: 'MMM dd',
                                week: 'MMM dd',
                                month: 'MMM yyyy'
                            },
                            tooltipFormat: 'MMM dd, yyyy'
                        },
                        ticks: { 
                            color: '#adadb8',
                            maxTicksLimit: 15,
                            source: 'data'
                        },
                        grid: { 
                            color: '#26262c' 
                        },
                        title: {
                            display: true,
                            text: 'Date',
                            color: '#adadb8'
                        },
                        bounds: 'data',
                        offset: true
                    },
                    y: { 
                        ticks: { 
                            color: '#adadb8' 
                        }, 
                        grid: { 
                            color: '#26262c' 
                        },
                        title: {
                            display: true,
                            text: chartMode === 'accumulated' ? 'Total Points Earned' : 'Points per Day',
                            color: '#adadb8'
                        },
                        beginAtZero: true
                    }
                },
                plugins: {
                    zoom: {
                        pan: {
                            enabled: true,
                            mode: 'x',
                            modifierKey: null
                        },
                        zoom: {
                            wheel: {
                                enabled: true,
                                modifierKey: 'ctrl'
                            },
                            pinch: {
                                enabled: true
                            },
                            mode: 'x',
                            limits: {
                                x: {
                                    min: 'original',
                                    max: 'original'
                                }
                            },
                            onZoomComplete: function({ chart }) {
                                // Показываем кнопку Reset Zoom после зума
                                const resetBtn = document.getElementById('resetZoomBtn');
                                if (resetBtn) {
                                    resetBtn.style.display = 'flex';
                                }
                            }
                        }
                    }
                }
            },
            plugins: zoomPluginInstance ? [zoomPluginInstance] : []
        });
    } else {
        // Сохраняем старые данные для проверки появления нового дня
        const oldDatasets = pointsChart.data.datasets.map(ds => ({
            label: ds.label,
            data: ds.data ? ds.data.map(p => ({ x: new Date(p.x), y: p.y })) : []
        }));
        
        // Обновляем данные
        pointsChart.data.datasets = datasets;
        
        // Обновляем заголовок оси Y в зависимости от режима
        if (pointsChart.options.scales && pointsChart.options.scales.y && pointsChart.options.scales.y.title) {
            pointsChart.options.scales.y.title.text = chartMode === 'accumulated' ? 'Total Points Earned' : 'Points per Day';
        }
        
        // Проверяем, появился ли новый день
        const hasNewDay = checkForNewDay(oldDatasets, datasets);
        
        if (hasNewDay) {
            // Если появился новый день, сбрасываем зум и границы масштаба
            if (pointsChart.resetZoom && typeof pointsChart.resetZoom === 'function') {
                try {
                    pointsChart.resetZoom();
                    const resetBtn = document.getElementById('resetZoomBtn');
                    if (resetBtn) {
                        resetBtn.style.display = 'none';
                    }
                } catch (e) {
                    // Игнорируем ошибки сброса зума
                }
            }
            
            // Сбрасываем границы масштаба, чтобы Chart.js пересчитал их на основе новых данных
            if (pointsChart.options.scales && pointsChart.options.scales.x) {
                delete pointsChart.options.scales.x.min;
                delete pointsChart.options.scales.x.max;
            }
        }
        
        // Обновляем график без анимации для мгновенного отображения изменений
        pointsChart.update('none');
    }
    
    lastDataUpdate.chart = Date.now();
    // Используем уже объявленную переменную chartContainer из начала функции
    if (chartContainer) {
        updateStaleDataIndicator('chart', chartContainer);
    }
}

/**
 * Обновляет индикатор устаревших данных
 * @param {string} type Тип данных (stats, events, chart, overall)
 * @param {HTMLElement} container Контейнер для индикатора
 */
function updateStaleDataIndicator(type, container) {
    if (!container) return;
    
    const timestamp = lastDataUpdate[type] || 0;
    const age = Date.now() - timestamp;
    const isStale = age > STALE_DATA_THRESHOLD;
    
    // Удаляем существующий индикатор
    const existing = container.querySelector('.stale-data-indicator');
    if (existing) {
        existing.remove();
    }
    
    if (isStale && timestamp > 0) {
        const indicator = document.createElement('div');
        indicator.className = 'stale-data-indicator';
        indicator.title = `Данные обновлены ${Math.round(age / 1000)} секунд назад. Кликните для обновления.`;
        indicator.innerHTML = '⚠️ Устаревшие данные';
        indicator.style.cssText = `
            position: absolute;
            top: 10px;
            right: 10px;
            background: rgba(239, 68, 68, 0.9);
            color: white;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            z-index: 100;
            animation: pulse 2s infinite;
        `;
        
        indicator.addEventListener('click', () => {
            if (type === 'stats') updateStatistics();
            else if (type === 'overall') updateOverallStats();
        });
        
        if (container.style.position !== 'relative' && container.style.position !== 'absolute') {
            container.style.position = 'relative';
        }
        
        container.appendChild(indicator);
    }
}

/**
 * Проверяет, появился ли новый день в данных графика
 * @param {Array} oldDatasets Старые наборы данных
 * @param {Array} newDatasets Новые наборы данных
 * @returns {boolean} true если появился новый день
 */
function checkForNewDay(oldDatasets, newDatasets) {
    if (!oldDatasets || oldDatasets.length === 0) return false;
    
    // Находим максимальную дату в старых данных
    let maxOldDate = null;
    oldDatasets.forEach(dataset => {
        if (dataset.data && dataset.data.length > 0) {
            dataset.data.forEach(point => {
                const date = point.x instanceof Date ? point.x : new Date(point.x);
                if (!maxOldDate || date > maxOldDate) {
                    maxOldDate = date;
                }
            });
        }
    });
    
    if (!maxOldDate) return false;
    
    // Нормализуем до начала дня
    const maxOldDay = new Date(maxOldDate.getFullYear(), maxOldDate.getMonth(), maxOldDate.getDate());
    
    // Находим максимальную дату в новых данных
    let maxNewDate = null;
    newDatasets.forEach(dataset => {
        if (dataset.data && dataset.data.length > 0) {
            dataset.data.forEach(point => {
                const date = point.x instanceof Date ? point.x : new Date(point.x);
                if (!maxNewDate || date > maxNewDate) {
                    maxNewDate = date;
                }
            });
        }
    });
    
    if (!maxNewDate) return false;
    
    // Нормализуем до начала дня
    const maxNewDay = new Date(maxNewDate.getFullYear(), maxNewDate.getMonth(), maxNewDate.getDate());
    
    // Если новый день больше старого, значит появился новый день
    return maxNewDay.getTime() > maxOldDay.getTime();
}

let lastEventTimestamp = 0;
let cachedEvents = []; // Кэш последних загруженных событий

// Timestamp последнего обновления данных
let lastDataUpdate = {
    stats: 0,
    events: 0,
    chart: 0,
    overall: 0
};

const STALE_DATA_THRESHOLD = 30000; // 30 секунд

// Настройки приложения
const defaultSettings = {
    fontSize: 'medium',
    density: 'normal',
    autoScrollEvents: false,
    eventsPageSize: 20,
    saveChartZoom: false,
    autoUpdateChart: true,
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
    eventsPageSize = parseInt(settings.eventsPageSize) || 20;
    
    // Автопрокрутка к новым событиям
    // Будет применена в функции renderFilteredEvents
}

/**
 * Обновляет список доступных тегов из событий
 * @param events Массив событий
 */
function updateAvailableTags(events) {
    const newTags = new Set();
    events.forEach(event => {
        if (event.type && event.type !== 'minute-watched') {
            newTags.add(event.type);
        }
    });
    
    // Обновляем доступные теги (заменяем, а не добавляем)
    const oldAvailableTags = availableEventTags;
    availableEventTags = newTags;
    
    // Очищаем выбранные теги, которых больше нет в доступных тегах
    // Это предотвращает ситуацию, когда выбраны теги, которых нет в текущих событиях
    const tagsToRemove = [];
    selectedEventTags.forEach(tag => {
        if (!availableEventTags.has(tag)) {
            tagsToRemove.push(tag);
        }
    });
    
    if (tagsToRemove.length > 0) {
        tagsToRemove.forEach(tag => selectedEventTags.delete(tag));
        // Сохраняем обновленные теги в localStorage
        safeSetLocalStorage('selectedEventTags', JSON.stringify(Array.from(selectedEventTags)));
        // Обновляем UI фильтров
        updateFiltersUI();
    } else if (oldAvailableTags.size === 0 && newTags.size > 0) {
        // При первой загрузке (когда старых тегов не было) обновляем UI
        updateFiltersUI();
    }
}

/**
 * Обновляет UI фильтров тегов
 */
function updateFiltersUI() {
    const filtersContainer = document.getElementById('eventFilters');
    if (!filtersContainer) return;
    
    // Сортируем теги для консистентности
    const sortedTags = Array.from(availableEventTags).sort();
    
    // Если тегов нет, скрываем контейнер фильтров
    if (sortedTags.length === 0) {
        filtersContainer.style.display = 'none';
        return;
    }
    
    filtersContainer.style.display = 'flex';
    
    // Сохраняем label
    const label = filtersContainer.querySelector('.filter-label');
    const existingTags = filtersContainer.querySelectorAll('.filter-tag');
    
    // Удаляем старые теги
    existingTags.forEach(tag => tag.remove());
    
    // Добавляем новые теги
    sortedTags.forEach(tag => {
        const tagElement = document.createElement('label');
        tagElement.className = `filter-tag ${selectedEventTags.has(tag) ? 'active' : ''}`;
        tagElement.innerHTML = `
            <input type="checkbox" value="${tag}" ${selectedEventTags.has(tag) ? 'checked' : ''}>
            ${tag}
        `;
        
        tagElement.addEventListener('click', (e) => {
            e.preventDefault();
            toggleEventTag(tag);
        });
        
        filtersContainer.appendChild(tagElement);
    });
}

/**
 * Переключает выбранный тег
 * @param tag Тег для переключения
 */
function toggleEventTag(tag) {
    if (selectedEventTags.has(tag)) {
        selectedEventTags.delete(tag);
    } else {
        selectedEventTags.add(tag);
    }
    
    // Сохраняем в localStorage
    safeSetLocalStorage('selectedEventTags', JSON.stringify(Array.from(selectedEventTags)));
    
    // Обновляем UI
    updateFiltersUI();
    
    // Временно отключаем observer при фильтрации, чтобы избежать бесконечного обновления
    if (window.eventsScrollObserver) {
        window.eventsScrollObserver.disconnect();
    }
    
    // Перефильтровываем кэшированные события без нового запроса
    // Используем allLoadedEvents вместо cachedEvents для консистентности
    const eventsToFilter = allLoadedEvents.length > 0 ? allLoadedEvents : cachedEvents;
    if (eventsToFilter.length > 0) {
        renderFilteredEvents(eventsToFilter, false);
    }
    
    // Восстанавливаем observer после небольшой задержки
    setTimeout(() => {
        setupInfiniteScroll();
    }, 100);
}

/**
 * Определяет, является ли событие важным
 * @param event Событие
 * @returns true если событие важное
 */
function isImportantEvent(event) {
    const importantTypes = [
        'token-expired', 'token-invalid', 'stream-up', 'stream-down', 'claim-success',
        'raid-joined', 'points-earned', 'claim-earned'
    ];
    return importantTypes.includes(event.type);
}

/**
 * Экранирование HTML
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

/**
 * Запрашивает разрешение на уведомления ОС
 */
async function requestOsNotificationPermission() {
    if (!('Notification' in window)) {
        return false;
    }
    if (Notification.permission === 'granted') {
        return true;
    }
    if (Notification.permission === 'denied') {
        return false;
    }
    const result = await Notification.requestPermission();
    return result === 'granted';
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
 * Показывает системное уведомление браузера
 */
function showStreamOsNotification(isOnline, streamerName) {
    const settings = loadSettings();
    if (!settings.osNotifications || !('Notification' in window)) {
        return;
    }
    if (Notification.permission !== 'granted') {
        return;
    }
    const title = isOnline ? '📺 Стрим онлайн' : '📴 Стрим офлайн';
    const body = isOnline
        ? `${streamerName} начал трансляцию`
        : `${streamerName} завершил трансляцию`;
    try {
        new Notification(title, { body, tag: `stream-${streamerName}-${isOnline ? 'up' : 'down'}` });
    } catch (e) {
        console.warn('OS notification failed:', e);
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

    items.forEach((item) => {
        const streamerName = item.streamer || item.streamerName;
        if (!streamerName || !isStreamerNotifyEnabled(streamerName)) {
            return;
        }
        const isOnline = item.type === 'stream-up';
        showStreamToast(isOnline, streamerName);
        showStreamOsNotification(isOnline, streamerName);
        if (settings.soundNotifications) {
            playNotificationSound(isOnline);
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
function groupEventsByTime(events) {
    const groups = new Map();
    
    events.forEach(event => {
        const eventDate = new Date(event.timestamp);
        // Нормализуем дату до начала дня (00:00:00)
        const dayStart = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
        const groupKey = dayStart.getTime();
        
        if (!groups.has(groupKey)) {
            groups.set(groupKey, []);
        }
        groups.get(groupKey).push(event);
    });
    
    return groups;
}

/**
 * Форматирует дату группы событий
 * @param timestamp Timestamp начала дня группы
 * @returns Отформатированная строка даты
 */
function formatGroupTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const eventDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    
    if (eventDate.getTime() === today.getTime()) {
        return 'Today';
    } else if (eventDate.getTime() === yesterday.getTime()) {
        return 'Yesterday';
    } else {
        return date.toLocaleDateString('ru-RU', { 
            day: '2-digit', 
            month: '2-digit',
            year: 'numeric'
        });
    }
}

/**
 * Отображает отфильтрованные события с группировкой
 * @param events Массив событий для отображения
 * @param shouldSetupScroll Нужно ли настраивать бесконечную прокрутку (по умолчанию true)
 */
function renderFilteredEvents(events, shouldSetupScroll = true) {
    const list = document.getElementById('eventsList');
    if (!list) {
        console.error('eventsList element not found');
        return;
    }
    
    const hasContent = list && (list.querySelector('.event-group') || list.querySelector('table'));
    const hasSkeleton = list && (list.querySelector('.skeleton-event-item') || list.querySelector('.loading'));
    
    // Показываем skeleton только при первой загрузке (когда нет контента и нет skeleton)
    if (!hasContent && !hasSkeleton && list) {
        list.innerHTML = generateEventsSkeleton(5);
    }
    
    if (events.length === 0) {
        const emptyMessage = '<p style="color: #adadb8; text-align: center; padding: 20px;">No events yet</p>';
        if (list && (list.querySelector('.skeleton-event-item') || list.querySelector('.loading'))) {
            replaceSkeletonWithContent(list, emptyMessage);
        } else {
            list.innerHTML = emptyMessage;
        }
        return;
    }

    // Удаляем дубликаты перед фильтрацией
    const uniqueEventsMap = new Map();
    events.forEach(event => {
        const key = `${event.timestamp}-${event.type}-${event.streamer}-${event.message}`;
        if (!uniqueEventsMap.has(key)) {
            uniqueEventsMap.set(key, event);
        }
    });
    const uniqueEvents = Array.from(uniqueEventsMap.values());

    // Фильтруем события по выбранным тегам и исключаем технические события
    let filteredEvents = uniqueEvents.filter(event => event.type !== 'minute-watched');
    const eventsBeforeFilter = filteredEvents.length;
    
    // Если выбраны теги, фильтруем по ним
    if (selectedEventTags.size > 0) {
        filteredEvents = filteredEvents.filter(event => selectedEventTags.has(event.type));
        
        // Если после фильтрации событий не осталось, но были события до фильтрации,
        // это означает, что выбранные теги не соответствуют ни одному событию
        // В этом случае очищаем selectedEventTags и показываем все события
        if (filteredEvents.length === 0 && eventsBeforeFilter > 0) {
            // Очищаем selectedEventTags, так как выбранные теги не соответствуют событиям
            selectedEventTags.clear();
            safeSetLocalStorage('selectedEventTags', JSON.stringify(Array.from(selectedEventTags)));
            // Обновляем UI фильтров
            updateFiltersUI();
            // Показываем все события (без фильтра)
            filteredEvents = uniqueEvents.filter(event => event.type !== 'minute-watched');
        }
    }

    if (filteredEvents.length === 0) {
        if (uniqueEvents.length === 0) {
            // Событий вообще нет
            list.innerHTML = '<p style="color: #adadb8; text-align: center; padding: 20px;">No events yet</p>';
        } else if (selectedEventTags.size > 0) {
            // Есть события, но они не соответствуют выбранным фильтрам
            // Это не должно происходить, так как мы уже очистили фильтры выше,
            // но на всякий случай показываем сообщение
            list.innerHTML = '<p style="color: #adadb8; text-align: center; padding: 20px;">No events match selected filters</p>';
        } else {
            // События есть, но после фильтрации их не осталось (не должно происходить)
            list.innerHTML = '<p style="color: #adadb8; text-align: center; padding: 20px;">No events yet</p>';
        }
        return;
    }

    // Сортируем события по времени (новые сверху)
    filteredEvents.sort((a, b) => b.timestamp - a.timestamp);

    // Определяем новые события (из отфильтрованных)
    // Используем timestamp только если он был установлен (не 0)
    // При фильтрации не помечаем события как новые, чтобы избежать дублирования
    const newEvents = lastEventTimestamp > 0 && !list.querySelector('.event-group')
        ? filteredEvents.filter(e => e.timestamp > lastEventTimestamp)
        : [];
    
    // Автопрокрутка к новым событиям, если включена в настройках
    const settings = loadSettings();
    const shouldAutoScroll = settings.autoScrollEvents && newEvents.length > 0;

    // Группируем события по дням
    const eventGroups = groupEventsByTime(filteredEvents);
    
    // Используем DocumentFragment для оптимизации рендеринга
    const fragment = document.createDocumentFragment();
    // Сортируем группы по дате (новые дни сверху)
    const sortedGroups = Array.from(eventGroups.entries()).sort((a, b) => b[0] - a[0]);

    let html = '';
    sortedGroups.forEach(([groupTimestamp, groupEvents]) => {
        // Сортируем события внутри группы по времени (новые сверху)
        const sortedGroupEvents = [...groupEvents].sort((a, b) => b.timestamp - a.timestamp);
        const groupId = `event-group-${groupTimestamp}`;
        const hasImportantEvents = groupEvents.some(e => isImportantEvent(e));
        const groupClass = hasImportantEvents ? 'event-group-important' : '';
        
        html += `
            <div class="event-group ${groupClass}" data-group-id="${groupId}">
                <div class="event-group-header" onclick="toggleEventGroup('${groupId}')">
                    <span class="event-group-time">${formatGroupTime(groupTimestamp)}</span>
                    <span class="event-group-count">${groupEvents.length} event(s)</span>
                    <span class="event-group-toggle" id="toggle-${groupId}">▼</span>
                </div>
                <div class="event-group-content" id="content-${groupId}">
                    ${sortedGroupEvents.map((event, index) => {
                        const typeClass = event.type.includes('point') ? 'event-type-points' :
                                         event.type.includes('stream') ? 'event-type-stream' :
                                         event.type.includes('claim') ? 'event-type-claim' : '';
                        
                        // Если нет специального класса, генерируем цвет на основе типа события
                        let styleAttr = '';
                        if (!typeClass) {
                            const bgColor = generateColorFromText(event.type);
                            const textColor = '#ffffff';
                            styleAttr = `style="background: ${bgColor}; color: ${textColor};"`;
                        }
                        
                        // Проверяем, является ли событие новым (только при первой загрузке, не при фильтрации)
                        const isNew = newEvents.length > 0 && newEvents.some(ne => 
                            ne.timestamp === event.timestamp && 
                            ne.streamer === event.streamer && 
                            ne.type === event.type &&
                            ne.message === event.message
                        );
                        const isImportant = isImportantEvent(event);
                        const importantClass = isImportant ? 'event-item-important' : '';
                        
                        const eventIcon = getEventIcon(event.type);
                        // Используем уникальный ключ для предотвращения дублирования в DOM
                        const eventKey = `${event.timestamp}-${event.type}-${event.streamer}-${event.message}`;
                        return `
                            <div class="event-item ${isNew ? 'new' : ''} ${importantClass}" data-timestamp="${event.timestamp}" data-event-key="${eventKey}">
                                <span class="event-time">${formatTimestamp(event.timestamp)}</span>
                                <span class="event-icon">${eventIcon}</span>
                                <span class="event-type ${typeClass}" ${styleAttr}>${event.type}</span>
                                <strong><a href="https://www.twitch.tv/${event.streamer}" target="_blank" rel="noopener noreferrer" class="streamer-link">${event.streamer}</a></strong>: ${event.message}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    });

    // Если был skeleton, заменяем плавно
    if (list && (list.querySelector('.skeleton-event-item') || list.querySelector('.loading'))) {
        // Добавляем триггер для бесконечной прокрутки перед заменой только если нужно
        if (shouldSetupScroll && hasMoreEvents && !isLoadingEvents) {
            html += '<div id="loadMoreTrigger" style="height: 20px; width: 100%;"></div>';
        } else if (!hasMoreEvents && allLoadedEvents.length > 0) {
            html += '<div style="text-align: center; padding: 20px; color: #adadb8; font-size: 14px;">All events loaded</div>';
        }
        replaceSkeletonWithContent(list, html);
        
        // Устанавливаем observer после замены только если нужно
        if (shouldSetupScroll) {
            setTimeout(() => {
                const loadMoreTrigger = document.getElementById('loadMoreTrigger');
                if (loadMoreTrigger && window.eventsScrollObserver) {
                    window.eventsScrollObserver.observe(loadMoreTrigger);
                }
            }, 500);
        }
    } else {
        // Сохраняем состояние свернутых групп перед заменой содержимого
        const collapsedGroups = new Set();
        list.querySelectorAll('.event-group-content').forEach(content => {
            if (content.style.display === 'none') {
                const groupId = content.id.replace('content-', '');
                collapsedGroups.add(groupId);
            }
        });
        
        // Перед заменой содержимого удаляем старые элементы, чтобы избежать дублирования
        // Используем data-event-key для проверки уникальности
        const existingEventKeys = new Set();
        list.querySelectorAll('[data-event-key]').forEach(el => {
            const key = el.getAttribute('data-event-key');
            if (key) {
                existingEventKeys.add(key);
            }
        });
        
        // Создаем временный контейнер для нового HTML
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        
        // Удаляем дубликаты из нового HTML
        const newEventElements = tempDiv.querySelectorAll('[data-event-key]');
        newEventElements.forEach(el => {
            const key = el.getAttribute('data-event-key');
            if (key && existingEventKeys.has(key)) {
                el.remove();
            } else if (key) {
                existingEventKeys.add(key);
            }
        });
        
        // Заменяем содержимое
        list.innerHTML = tempDiv.innerHTML;
        
        // Восстанавливаем состояние свернутых групп
        collapsedGroups.forEach(groupId => {
            const content = document.getElementById(`content-${groupId}`);
            const toggle = document.getElementById(`toggle-${groupId}`);
            if (content && toggle) {
                content.style.display = 'none';
                toggle.textContent = '▶';
            }
        });
        
        // Добавляем триггер для бесконечной прокрутки в конец списка только если нужно
        if (shouldSetupScroll && hasMoreEvents && !isLoadingEvents) {
            const loadMoreTrigger = document.createElement('div');
            loadMoreTrigger.id = 'loadMoreTrigger';
            loadMoreTrigger.style.height = '20px';
            loadMoreTrigger.style.width = '100%';
            list.appendChild(loadMoreTrigger);
            
            // Устанавливаем observer для нового триггера
            if (window.eventsScrollObserver) {
                window.eventsScrollObserver.observe(loadMoreTrigger);
            }
        } else if (!hasMoreEvents && allLoadedEvents.length > 0) {
            // Показываем сообщение, что все события загружены
            const endMarker = document.createElement('div');
            endMarker.style.cssText = 'text-align: center; padding: 20px; color: #adadb8; font-size: 14px;';
            endMarker.textContent = 'All events loaded';
            list.appendChild(endMarker);
        }
    }

    // Убираем класс new после анимации
    setTimeout(() => {
        document.querySelectorAll('.event-item.new').forEach(item => {
            item.classList.remove('new');
        });
    }, 400);
}

/**
 * Переключает видимость группы событий
 * @param groupId ID группы
 */
function toggleEventGroup(groupId) {
    const content = document.getElementById(`content-${groupId}`);
    const toggle = document.getElementById(`toggle-${groupId}`);
    
    if (content && toggle) {
        if (content.style.display === 'none') {
            content.style.display = 'block';
            toggle.textContent = '▼';
        } else {
            content.style.display = 'none';
            toggle.textContent = '▶';
        }
    }
}

async function updateEvents(reset = false, loadMore = false) {
    if (reset) {
        eventsOffset = 0;
        allLoadedEvents = [];
        hasMoreEvents = true;
        lastEventTimestamp = 0; // Сбрасываем timestamp при полном сбросе
    }
    
    if (isLoadingEvents) return;
    
    // Определяем, что нужно делать:
    // - reset=true: полный сброс и загрузка с начала
    // - loadMore=true: загрузка старых событий при прокрутке
    // - иначе: проверка новых событий при автообновлении
    const isCheckingNew = !reset && !loadMore;
    const isLoadingMore = !reset && loadMore;
    
    // При загрузке старых событий проверяем, есть ли еще события
    if (isLoadingMore && !hasMoreEvents) {
        return;
    }
    
    // Определяем offset для запроса
    const currentOffset = isCheckingNew ? 0 : eventsOffset;
    
    isLoadingEvents = true;
    
    try {
        const response = await fetchData(`/events?limit=${eventsPageSize}&offset=${currentOffset}`);
        if (!response || !response.events) {
            isLoadingEvents = false;
            return;
        }

        const fetchedEvents = response.events;
        
        if (reset) {
            // При сбросе загружаем все события постепенно
            // Сначала загружаем первую порцию
            allLoadedEvents = fetchedEvents;
            eventsOffset = fetchedEvents.length;
            hasMoreEvents = response.hasMore;
            
            // Если есть еще события, загружаем их сразу (до разумного лимита, например 200)
            if (hasMoreEvents && fetchedEvents.length < 200) {
                // Загружаем еще события, чтобы показать события от всех стримеров
                let continueLoading = true;
                while (continueLoading && eventsOffset < 200 && hasMoreEvents) {
                    const nextResponse = await fetchData(`/events?limit=${eventsPageSize}&offset=${eventsOffset}`);
                    if (nextResponse && nextResponse.events && nextResponse.events.length > 0) {
                        // Используем Map для предотвращения дубликатов
                        const existingEventsMap = new Map();
                        allLoadedEvents.forEach(e => {
                            const key = `${e.timestamp}-${e.type}-${e.streamer}-${e.message}`;
                            existingEventsMap.set(key, e);
                        });
                        
                        // Добавляем только уникальные события
                        const uniqueNewEvents = nextResponse.events.filter(e => {
                            const key = `${e.timestamp}-${e.type}-${e.streamer}-${e.message}`;
                            return !existingEventsMap.has(key);
                        });
                        
                        allLoadedEvents = [...allLoadedEvents, ...uniqueNewEvents];
                        eventsOffset += uniqueNewEvents.length;
                        hasMoreEvents = nextResponse.hasMore;
                    } else {
                        continueLoading = false;
                        hasMoreEvents = false;
                    }
                }
            }
        } else if (isCheckingNew) {
            // При проверке новых событий объединяем их с уже загруженными
            // Создаем Map для быстрого поиска дубликатов
            const existingEventsMap = new Map();
            allLoadedEvents.forEach(e => {
                const key = `${e.timestamp}-${e.type}-${e.streamer}-${e.message}`;
                existingEventsMap.set(key, e);
            });
            
            // Добавляем только новые события (которых еще нет)
            const trulyNewEvents = fetchedEvents.filter(e => {
                const key = `${e.timestamp}-${e.type}-${e.streamer}-${e.message}`;
                return !existingEventsMap.has(key);
            });

            const streamEvents = trulyNewEvents.filter(
                (e) => e.type === 'stream-up' || e.type === 'stream-down'
            );
            if (streamEvents.length > 0) {
                processStreamStatusNotifications(
                    streamEvents.map((e) => ({ streamer: e.streamer, type: e.type }))
                );
            }
            
            // Объединяем: новые события в начале, затем уже загруженные
            allLoadedEvents = [...trulyNewEvents, ...allLoadedEvents];
            
            // Обновляем hasMoreEvents для возможности загрузки старых событий при прокрутке
            hasMoreEvents = response.hasMore;
            // eventsOffset не меняется при проверке новых событий
        } else {
            // При прокрутке вниз добавляем старые события в конец
            // Проверяем на дубликаты перед добавлением
            const existingEventsMap = new Map();
            allLoadedEvents.forEach(e => {
                const key = `${e.timestamp}-${e.type}-${e.streamer}-${e.message}`;
                existingEventsMap.set(key, e);
            });
            
            const uniqueNewEvents = fetchedEvents.filter(e => {
                const key = `${e.timestamp}-${e.type}-${e.streamer}-${e.message}`;
                return !existingEventsMap.has(key);
            });
            
            allLoadedEvents = [...allLoadedEvents, ...uniqueNewEvents];
            eventsOffset += uniqueNewEvents.length;
            hasMoreEvents = response.hasMore;
        }

        // Сохраняем события в кэш
        cachedEvents = allLoadedEvents;

        // Обновляем доступные теги
        updateAvailableTags(allLoadedEvents);

        // Обновляем timestamp для определения новых событий (самое новое событие)
        if (allLoadedEvents.length > 0) {
            // Сортируем по timestamp для определения самого нового
            const sortedEvents = [...allLoadedEvents].sort((a, b) => b.timestamp - a.timestamp);
            lastEventTimestamp = sortedEvents[0].timestamp;
        }

        // Отображаем отфильтрованные события
        renderFilteredEvents(allLoadedEvents);
        
        // Устанавливаем observer для бесконечной прокрутки
        setupInfiniteScroll();
        
        lastDataUpdate.events = Date.now();
        const eventsList = document.getElementById('eventsList');
        if (eventsList) {
            updateStaleDataIndicator('events', eventsList);
        }
    } finally {
        isLoadingEvents = false;
    }
}

/**
 * Настраивает бесконечную прокрутку для событий
 */
function setupInfiniteScroll() {
    const eventsList = document.getElementById('eventsList');
    if (!eventsList) return;
    
    // Удаляем старый observer, если есть
    if (window.eventsScrollObserver) {
        window.eventsScrollObserver.disconnect();
    }
    
    // Если больше нет событий для загрузки, не создаем триггер
    if (!hasMoreEvents || isLoadingEvents) {
        // Удаляем существующий триггер, если есть
        const existingTrigger = document.getElementById('loadMoreTrigger');
        if (existingTrigger) {
            existingTrigger.remove();
        }
        return;
    }
    
    // Создаем элемент-триггер для загрузки
    let loadMoreTrigger = document.getElementById('loadMoreTrigger');
    if (!loadMoreTrigger) {
        loadMoreTrigger = document.createElement('div');
        loadMoreTrigger.id = 'loadMoreTrigger';
        loadMoreTrigger.style.height = '20px';
        loadMoreTrigger.style.width = '100%';
        eventsList.appendChild(loadMoreTrigger);
    }
    
    // Проверяем, виден ли триггер сразу после создания
    // Если да, то добавляем небольшую задержку перед наблюдением, чтобы избежать немедленной загрузки
    setTimeout(() => {
        // Проверяем еще раз, что триггер существует и условия все еще выполняются
        const trigger = document.getElementById('loadMoreTrigger');
        if (!trigger || !hasMoreEvents || isLoadingEvents) {
            return;
        }
        
        // Проверяем, виден ли триггер в viewport
        const rect = trigger.getBoundingClientRect();
        const isVisible = rect.top < window.innerHeight && rect.bottom > 0;
        
        // Если триггер виден сразу, это означает, что контента мало и прокрутка не нужна
        // В этом случае не наблюдаем за триггером, чтобы избежать бесконечной загрузки
        if (isVisible && eventsList.scrollHeight <= eventsList.clientHeight) {
            // Контент помещается на экране, не нужно наблюдать за триггером
            return;
        }
        
        // Создаем Intersection Observer только если триггер не виден сразу
        window.eventsScrollObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && hasMoreEvents && !isLoadingEvents) {
                    updateEvents(false, true); // loadMore=true для загрузки старых событий
                }
            });
        }, {
            root: eventsList, // Используем eventsList как root для правильного определения видимости
            rootMargin: '100px',
            threshold: 0.1
        });
        
        window.eventsScrollObserver.observe(trigger);
    }, 100); // Небольшая задержка для проверки видимости
}

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
    startAutoUpdate();
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
    
    // Инициализация событий отключена
    
    // Обработчики для управления графиком
    // Переключатель режима отображения
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            chartMode = mode;
            safeSetLocalStorage('chartMode', mode);
            
            // Обновляем активную кнопку
            document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Обновляем график
            updatePointsChart();
        });
    });
    
    // Восстанавливаем активный режим
    document.querySelectorAll('.mode-btn').forEach(btn => {
        if (btn.dataset.mode === chartMode) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    
    // Фильтр по периодам
    const periodSelect = document.getElementById('chartPeriod');
    if (periodSelect) {
        periodSelect.value = chartPeriod;
        periodSelect.addEventListener('change', (e) => {
            chartPeriod = e.target.value;
            safeSetLocalStorage('chartPeriod', chartPeriod);
            updatePointsChart();
        });
    }
    
    // Кнопка сброса зума
    const resetZoomBtn = document.getElementById('resetZoomBtn');
    if (resetZoomBtn) {
        resetZoomBtn.addEventListener('click', resetChartZoom);
    }
    
    // Кнопка экспорта графика
    const exportChartBtn = document.getElementById('exportChartBtn');
    if (exportChartBtn) {
        exportChartBtn.addEventListener('click', exportChart);
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

    const osHint = document.getElementById('osNotificationsHint');
    if (osHint) {
        const denied = 'Notification' in window && Notification.permission === 'denied';
        osHint.style.display = denied ? 'block' : 'none';
        osHint.textContent = denied
            ? 'Уведомления ОС заблокированы в браузере. Разрешите их в настройках сайта.'
            : 'Разрешите уведомления в браузере при сохранении настроек.';
    }
    
    modal.style.display = 'flex';
    
    // Закрытие по клику на overlay
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeSettingsModal();
        }
    });
    
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
        const granted = await requestOsNotificationPermission();
        if (!granted) {
            settings.osNotifications = false;
            document.getElementById('osNotificationsSetting').checked = false;
            showNotification('warning', 'Разрешение на уведомления ОС не получено');
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
window.showSettingsModal = showSettingsModal;
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

