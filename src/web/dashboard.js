const API_BASE = '/api';
let pointsChart = null;
let updateInterval = null;

// Настройки графика
let chartMode = localStorage.getItem('chartMode') || 'accumulated'; // 'accumulated' или 'daily'
let chartPeriod = localStorage.getItem('chartPeriod') || '30'; // 'all', '90', '30', '7', '1'

// Загружаем состояние из localStorage или используем значения по умолчанию
let showOffline = localStorage.getItem('showOffline') !== 'false'; // По умолчанию показываем всех стримеров
let updateIntervalMs = parseInt(localStorage.getItem('updateIntervalMs')) || 5000; // Интервал обновления в миллисекундах
let selectedEventTags = new Set(JSON.parse(localStorage.getItem('selectedEventTags') || '[]')); // Выбранные теги событий
let availableEventTags = new Set(); // Доступные теги из событий

// Настройки видимых колонок таблицы стримеров
let visibleColumns = JSON.parse(localStorage.getItem('visibleColumns') || '{"streamer": true, "status": true, "watchTime": true, "pointsEarned": true, "currentPoints": true, "actions": true}');

// Пагинация событий
let eventsPageSize = 20; // Количество событий на странице
let eventsOffset = 0; // Текущий offset для событий
let allLoadedEvents = []; // Все загруженные события
let isLoadingEvents = false; // Флаг загрузки событий
let hasMoreEvents = true; // Есть ли еще события для загрузки

function formatTime(ms) {
    if (ms < 0) return '-';
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
 * @param {number} maxTime Максимальное время для расчета процента (по умолчанию 8 часов)
 * @returns {string} HTML код прогресс-бара
 */
function generateWatchTimeProgress(elapsedTime, maxTime = 8 * 60 * 60 * 1000) {
    const percentage = Math.min((elapsedTime / maxTime) * 100, 100);
    const timeText = formatTime(elapsedTime);
    
    return `
        <div class="watch-time-progress">
            <div class="progress-bar-container">
                <div class="progress-bar" style="width: ${percentage}%"></div>
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
    if (points >= 10000) return 'very-high';
    if (points >= 5000) return 'high';
    if (points >= 1000) return 'medium';
    return 'low';
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
function generateChartSkeleton() {
    // Создаем несколько линий для имитации графика
    const lines = Array.from({ length: 5 }).map((_, i) => {
        const width = 60 + Math.random() * 40;
        const left = 10 + i * 20;
        const height = 20 + Math.random() * 200;
        return `<div class="skeleton-chart-line" style="left: ${left}%; width: ${width}%; height: ${height}px;"></div>`;
    }).join('');
    
    return `
        <div class="skeleton-chart">
            ${lines}
        </div>
    `;
}

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
        return;
    }

    // Фильтруем офлайн стримеров, если они скрыты
    let filteredStats = stats;
    if (!showOffline) {
        filteredStats = stats.filter(s => s.status === 'ONLINE');
    }

    // Сортируем: сначала онлайн, потом офлайн, внутри группы - по имени
    const sortedStats = [...filteredStats].sort((a, b) => {
        if (a.status === 'ONLINE' && b.status === 'OFFLINE') return -1;
        if (a.status === 'OFFLINE' && b.status === 'ONLINE') return 1;
        // Если оба онлайн или оба офлайн, сортируем по имени
        return a.streamerName.localeCompare(b.streamerName);
    });

    // Определяем колонки с их видимостью
    const columns = [
        { key: 'streamer', label: 'Streamer', visible: visibleColumns.streamer !== false },
        { key: 'status', label: 'Status', visible: visibleColumns.status !== false },
        { key: 'watchTime', label: 'Watch Time', visible: visibleColumns.watchTime !== false },
        { key: 'pointsEarned', label: 'Points Earned', visible: visibleColumns.pointsEarned !== false },
        { key: 'currentPoints', label: 'Current Points', visible: visibleColumns.currentPoints !== false },
        { key: 'actions', label: 'Actions', visible: visibleColumns.actions !== false }
    ];
    
    const visibleColumnsList = columns.filter(c => c.visible);
    
    const tableContent = `
        <table>
            <thead>
                <tr>
                    ${visibleColumnsList.map(col => `<th>${col.label}</th>`).join('')}
                </tr>
            </thead>
            <tbody>
                ${sortedStats.map(s => `
                    <tr>
                        ${visibleColumns.streamer !== false ? `<td class="streamer-name">${s.streamerName}</td>` : ''}
                        ${visibleColumns.status !== false ? `
                            <td>
                                <span class="status-badge ${s.status === 'ONLINE' ? 'online' : 'offline'}">
                                    <span class="status-indicator ${s.status === 'ONLINE' ? 'status-online' : 'status-offline'}"></span>
                                    ${s.status}
                                </span>
                            </td>
                        ` : ''}
                        ${visibleColumns.watchTime !== false ? `<td>${generateWatchTimeProgress(s.elapsedTime)}</td>` : ''}
                        ${visibleColumns.pointsEarned !== false ? `<td>${generatePointsBadge(s.pointsEarned)}</td>` : ''}
                        ${visibleColumns.currentPoints !== false ? `<td>${generatePointsBadge(s.currentPoints)}</td>` : ''}
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
}

let pointsHistoryCache = []; // Кэш для доступа к истории в tooltip

/**
 * Фильтрует историю по выбранному периоду
 * @param {Array} history История баллов
 * @param {string} period Период ('all', '90', '30', '7', '1')
 * @returns {Array} Отфильтрованная история
 */
function filterHistoryByPeriod(history, period) {
    if (period === 'all') return history;
    
    const now = Date.now();
    const days = parseInt(period);
    const cutoffDate = new Date(now - days * 24 * 60 * 60 * 1000);
    
    return history.filter(entry => new Date(entry.timestamp) >= cutoffDate);
}

/**
 * Вычисляет статистику для графика
 * @param {Array} history История баллов
 * @param {string} mode Режим ('accumulated' или 'daily')
 * @returns {Object} Статистика
 */
function calculateChartStats(history, mode) {
    if (!history || history.length === 0) {
        return {
            total: 0,
            average: 0,
            max: 0,
            trend: 'neutral'
        };
    }
    
    // Группируем по дням
    const dailyPoints = new Map();
    history.forEach(entry => {
        const date = new Date(entry.timestamp);
        const dayKey = new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString().split('T')[0];
        
        if (!dailyPoints.has(dayKey)) {
            dailyPoints.set(dayKey, 0);
        }
        dailyPoints.set(dayKey, dailyPoints.get(dayKey) + entry.points);
    });
    
    const dailyValues = Array.from(dailyPoints.values());
    const total = dailyValues.reduce((sum, val) => sum + val, 0);
    const average = dailyValues.length > 0 ? total / dailyValues.length : 0;
    const max = dailyValues.length > 0 ? Math.max(...dailyValues) : 0;
    
    // Определяем тренд (сравниваем первую и вторую половину периода)
    let trend = 'neutral';
    if (dailyValues.length >= 4) {
        const firstHalf = dailyValues.slice(0, Math.floor(dailyValues.length / 2));
        const secondHalf = dailyValues.slice(Math.floor(dailyValues.length / 2));
        const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
        
        if (secondAvg > firstAvg * 1.1) trend = 'positive';
        else if (secondAvg < firstAvg * 0.9) trend = 'negative';
    }
    
    return { total, average, max, trend };
}

/**
 * Обновляет карточки статистики графика
 * @param {Object} stats Статистика
 */
function updateChartStats(stats) {
    const statsGrid = document.getElementById('chartStatsGrid');
    if (!statsGrid) return;
    
    if (stats.total === 0) {
        statsGrid.style.display = 'none';
        return;
    }
    
    statsGrid.style.display = 'grid';
    
    const trendIcon = stats.trend === 'positive' ? '↑' : stats.trend === 'negative' ? '↓' : '→';
    const trendClass = stats.trend === 'positive' ? 'positive' : stats.trend === 'negative' ? 'negative' : 'neutral';
    
    statsGrid.innerHTML = `
        <div class="chart-stat-card">
            <div class="chart-stat-label">Total Points</div>
            <div class="chart-stat-value">${Math.round(stats.total).toLocaleString()}</div>
        </div>
        <div class="chart-stat-card">
            <div class="chart-stat-label">Average per Day</div>
            <div class="chart-stat-value">${Math.round(stats.average).toLocaleString()}</div>
        </div>
        <div class="chart-stat-card">
            <div class="chart-stat-label">Max per Day</div>
            <div class="chart-stat-value">${Math.round(stats.max).toLocaleString()}</div>
        </div>
        <div class="chart-stat-card">
            <div class="chart-stat-label">Trend</div>
            <div class="chart-stat-value">${trendIcon}</div>
            <div class="chart-stat-change ${trendClass}">
                ${stats.trend === 'positive' ? 'Increasing' : stats.trend === 'negative' ? 'Decreasing' : 'Stable'}
            </div>
        </div>
    `;
}

/**
 * Экспортирует график как изображение
 */
function exportChart() {
    if (!pointsChart) return;
    
    const canvas = document.getElementById('pointsChart');
    if (!canvas) return;
    
    // Создаем ссылку для скачивания
    const link = document.createElement('a');
    link.download = `points-chart-${new Date().toISOString().split('T')[0]}.png`;
    link.href = canvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * Сбрасывает зум графика
 */
function resetChartZoom() {
    if (!pointsChart) return;
    
    if (pointsChart.resetZoom && typeof pointsChart.resetZoom === 'function') {
        try {
            pointsChart.resetZoom();
            // Скрываем кнопку после сброса
            const resetBtn = document.getElementById('resetZoomBtn');
            if (resetBtn) {
                resetBtn.style.display = 'none';
            }
        } catch (e) {
            console.warn('Error resetting zoom:', e);
        }
    }
}

async function updatePointsChart() {
    const chartContainer = document.querySelector('.chart-container');
    const isFirstLoad = !pointsChart;
    
    // Показываем skeleton только при первой загрузке
    if (isFirstLoad && chartContainer) {
        const canvas = document.getElementById('pointsChart');
        if (canvas && canvas.parentElement) {
            canvas.parentElement.innerHTML = generateChartSkeleton();
        }
    }
    
    const history = await fetchData('/points-history?limit=200');
    pointsHistoryCache = history || []; // Сохраняем в кэш для tooltip
    
    // Получаем текущую статистику для добавления актуальных значений в график
    const currentStats = await fetchData('/statistics?includeOffline=true');
    
    if (!history || history.length === 0) {
        // Если был skeleton, заменяем на сообщение
        if (chartContainer && chartContainer.querySelector('.skeleton-chart')) {
            chartContainer.innerHTML = '<p style="color: #adadb8; text-align: center; padding: 40px;">No points history available</p>';
        } else if (pointsChart) {
            // Если истории нет, показываем пустой график
            pointsChart.data.labels = [];
            pointsChart.data.datasets = [];
            pointsChart.update();
        }
        // Скрываем статистику
        const statsGrid = document.getElementById('chartStatsGrid');
        if (statsGrid) statsGrid.style.display = 'none';
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
    
    // Если был skeleton, восстанавливаем canvas
    if (chartContainer && chartContainer.querySelector('.skeleton-chart')) {
        chartContainer.innerHTML = '<canvas id="pointsChart"></canvas>';
    }

    const ctx = document.getElementById('pointsChart');
    
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

    // Регистрируем плагин zoom (если доступен)
    let zoomPlugin = null;
    // Chart.js plugin zoom может быть доступен через разные пути
    if (typeof ChartZoom !== 'undefined') {
        zoomPlugin = ChartZoom;
    } else if (window.ChartZoom) {
        zoomPlugin = window.ChartZoom;
    } else if (window.Chart && window.Chart.registry && window.Chart.registry.plugins) {
        // Плагин может быть уже зарегистрирован автоматически
        const registeredPlugins = Array.from(window.Chart.registry.plugins.values());
        zoomPlugin = registeredPlugins.find(p => p.id === 'zoom');
    }
    
    if (zoomPlugin && window.Chart) {
        try {
            if (!window.Chart.registry.plugins.has(zoomPlugin)) {
                window.Chart.register(zoomPlugin);
            }
        } catch (e) {
            // Плагин уже зарегистрирован или ошибка регистрации
            console.warn('Chart zoom plugin registration:', e);
        }
    }

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
        pointsChart = new Chart(ctx, {
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
            plugins: zoomPlugin ? [zoomPlugin] : []
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

/**
 * Обновляет список доступных тегов из событий
 * @param events Массив событий
 */
function updateAvailableTags(events) {
    const newTags = new Set();
    events.forEach(event => {
        if (event.type) {
            newTags.add(event.type);
        }
    });
    
    // Добавляем новые теги к доступным
    newTags.forEach(tag => availableEventTags.add(tag));
    
    // Обновляем UI фильтров
    updateFiltersUI();
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
    localStorage.setItem('selectedEventTags', JSON.stringify(Array.from(selectedEventTags)));
    
    // Обновляем UI
    updateFiltersUI();
    
    // Перефильтровываем кэшированные события без нового запроса
    renderFilteredEvents(cachedEvents);
}

/**
 * Определяет, является ли событие важным
 * @param event Событие
 * @returns true если событие важное
 */
function isImportantEvent(event) {
    const importantTypes = [
        'token-expired', 'token-invalid', 'stream-up', 'claim-success',
        'raid-joined', 'points-earned', 'claim-earned'
    ];
    return importantTypes.includes(event.type);
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
 */
function renderFilteredEvents(events) {
    const list = document.getElementById('eventsList');
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

    // Фильтруем события по выбранным тегам и исключаем технические события
    let filteredEvents = events.filter(event => event.type !== 'minute-watched');
    if (selectedEventTags.size > 0) {
        filteredEvents = filteredEvents.filter(event => selectedEventTags.has(event.type));
    }

    if (filteredEvents.length === 0) {
        list.innerHTML = '<p style="color: #adadb8; text-align: center; padding: 20px;">No events match selected filters</p>';
        return;
    }

    // Сортируем события по времени (новые сверху)
    filteredEvents.sort((a, b) => b.timestamp - a.timestamp);

    // Определяем новые события (из отфильтрованных)
    const newEvents = filteredEvents.filter(e => e.timestamp > lastEventTimestamp);

    // Группируем события по дням
    const eventGroups = groupEventsByTime(filteredEvents);
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
                        
                        const isNew = newEvents.some(ne => ne.timestamp === event.timestamp && ne.streamer === event.streamer);
                        const isImportant = isImportantEvent(event);
                        const importantClass = isImportant ? 'event-item-important' : '';
                        
                        const eventIcon = getEventIcon(event.type);
                        return `
                            <div class="event-item ${isNew ? 'new' : ''} ${importantClass}" data-timestamp="${event.timestamp}">
                                <span class="event-time">${formatTimestamp(event.timestamp)}</span>
                                <span class="event-icon">${eventIcon}</span>
                                <span class="event-type ${typeClass}" ${styleAttr}>${event.type}</span>
                                <strong>${event.streamer}</strong>: ${event.message}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    });

    // Если был skeleton, заменяем плавно
    if (list && (list.querySelector('.skeleton-event-item') || list.querySelector('.loading'))) {
        // Добавляем триггер для бесконечной прокрутки перед заменой
        if (hasMoreEvents && !isLoadingEvents) {
            html += '<div id="loadMoreTrigger" style="height: 20px; width: 100%;"></div>';
        } else if (!hasMoreEvents && allLoadedEvents.length > 0) {
            html += '<div style="text-align: center; padding: 20px; color: #adadb8; font-size: 14px;">All events loaded</div>';
        }
        replaceSkeletonWithContent(list, html);
        
        // Устанавливаем observer после замены
        setTimeout(() => {
            const loadMoreTrigger = document.getElementById('loadMoreTrigger');
            if (loadMoreTrigger && window.eventsScrollObserver) {
                window.eventsScrollObserver.observe(loadMoreTrigger);
            }
        }, 500);
    } else {
        list.innerHTML = html;
        
        // Добавляем триггер для бесконечной прокрутки в конец списка
        if (hasMoreEvents && !isLoadingEvents) {
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

async function updateEvents(reset = false) {
    if (reset) {
        eventsOffset = 0;
        allLoadedEvents = [];
        hasMoreEvents = true;
    }
    
    if (isLoadingEvents || !hasMoreEvents) return;
    
    isLoadingEvents = true;
    
    try {
        const response = await fetchData(`/events?limit=${eventsPageSize}&offset=${eventsOffset}`);
        if (!response || !response.events) {
            isLoadingEvents = false;
            return;
        }

        const newEvents = response.events;
        hasMoreEvents = response.hasMore;
        
        // Добавляем новые события к уже загруженным
        allLoadedEvents = [...allLoadedEvents, ...newEvents];
        eventsOffset += newEvents.length;

        // Сохраняем события в кэш
        cachedEvents = allLoadedEvents;

        // Обновляем доступные теги
        updateAvailableTags(allLoadedEvents);

        // Обновляем timestamp для определения новых событий
        if (allLoadedEvents.length > 0) {
            lastEventTimestamp = allLoadedEvents[0].timestamp;
        }

        // Отображаем отфильтрованные события
        renderFilteredEvents(allLoadedEvents);
        
        // Устанавливаем observer для бесконечной прокрутки
        setupInfiniteScroll();
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
    
    // Создаем элемент-триггер для загрузки
    let loadMoreTrigger = document.getElementById('loadMoreTrigger');
    if (!loadMoreTrigger) {
        loadMoreTrigger = document.createElement('div');
        loadMoreTrigger.id = 'loadMoreTrigger';
        loadMoreTrigger.style.height = '20px';
        loadMoreTrigger.style.width = '100%';
        eventsList.appendChild(loadMoreTrigger);
    }
    
    // Создаем Intersection Observer
    window.eventsScrollObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting && hasMoreEvents && !isLoadingEvents) {
                updateEvents(false);
            }
        });
    }, {
        root: null,
        rootMargin: '100px',
        threshold: 0.1
    });
    
    window.eventsScrollObserver.observe(loadMoreTrigger);
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

async function updateAll() {
    await Promise.all([
        updateOverallStats(),
        updateStatistics(),
        updateEvents(false), // Не сбрасываем события при автообновлении, только добавляем новые
        updatePointsChart(),
        updateCriticalNotifications(),
        updateTokenInfo()
    ]);
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
    updateIntervalMs = seconds * 1000;
    
    // Сохраняем интервал в localStorage
    localStorage.setItem('updateIntervalMs', updateIntervalMs.toString());
    
    // Обновляем активную кнопку
    document.querySelectorAll('.interval-btn').forEach(btn => {
        btn.classList.remove('active');
        if (parseInt(btn.dataset.interval) === seconds) {
            btn.classList.add('active');
        }
    });
    
    // Перезапускаем автообновление с новым интервалом
    if (updateInterval) {
        clearInterval(updateInterval);
    }
    updateInterval = setInterval(updateAll, updateIntervalMs);
}

function startAutoUpdate() {
    updateAll();
    updateInterval = setInterval(updateAll, updateIntervalMs);
    
    // Проверка подключения при старте
    updateConnectionStatus(false);
}

function toggleOfflineStreamers() {
    showOffline = !showOffline;
    
    // Сохраняем состояние в localStorage
    localStorage.setItem('showOffline', showOffline.toString());
    
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
    const originalText = exportBtn.innerHTML;
    
    // Показываем индикатор загрузки
    exportBtn.disabled = true;
    exportBtn.innerHTML = '<span>⏳</span><span>Exporting...</span>';
    
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
        exportBtn.disabled = false;
        exportBtn.innerHTML = originalText;
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
    localStorage.setItem('visibleColumns', JSON.stringify(visibleColumns));
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

window.addEventListener('load', () => {
    // Восстанавливаем состояние кнопки показа/скрытия офлайн стримеров
    const toggleText = document.getElementById('toggleOfflineText');
    if (toggleText) {
        toggleText.textContent = showOffline ? 'Hide Offline' : 'Show Offline';
    }
    
    // Восстанавливаем активную кнопку интервала обновления
    const savedIntervalSeconds = updateIntervalMs / 1000;
    document.querySelectorAll('.interval-btn').forEach(btn => {
        btn.classList.remove('active');
        if (parseInt(btn.dataset.interval) === savedIntervalSeconds) {
            btn.classList.add('active');
        }
    });
    
    startAutoUpdate();
    
    // Добавляем обработчик для кнопки переключения офлайн стримеров
    const toggleBtn = document.getElementById('toggleOfflineBtn');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleOfflineStreamers);
    }
    
    // Добавляем обработчики для кнопок интервала обновления
    document.querySelectorAll('.interval-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const interval = parseInt(btn.dataset.interval);
            setUpdateInterval(interval);
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
        if (exportDropdown && !exportDropdown.contains(e.target) && !exportBtn.contains(e.target)) {
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
    
    // Инициализируем загрузку событий с пагинацией
    updateEvents(true);
    
    // Обработчики для управления графиком
    // Переключатель режима отображения
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            chartMode = mode;
            localStorage.setItem('chartMode', mode);
            
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
            localStorage.setItem('chartPeriod', chartPeriod);
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
 * Добавляет стримера для отслеживания
 */
async function addStreamer() {
    const input = document.getElementById('addStreamerInput');
    if (!input) return;
    
    const username = input.value.trim();
    if (!username) {
        alert('Please enter a streamer name');
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
            alert(result.message || 'Failed to add streamer');
        }
    } catch (error) {
        console.error('Error adding streamer:', error);
        alert('Failed to add streamer. Please try again.');
    } finally {
        // Включаем кнопку и поле ввода
        input.disabled = false;
        if (addBtn) addBtn.disabled = false;
        input.focus();
    }
}

/**
 * Удаляет стримера из отслеживания
 * @param {string} username Имя стримера
 */
async function removeStreamer(username) {
    if (!confirm(`Are you sure you want to remove ${username} from tracking?`)) {
        return;
    }

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
            alert(result.message || 'Failed to remove streamer');
        }
    } catch (error) {
        console.error('Error removing streamer:', error);
        alert('Failed to remove streamer. Please try again.');
    }
}

/**
 * Показывает уведомление
 * @param {string} type Тип уведомления (success, error, info)
 * @param {string} message Текст уведомления
 */
function showNotification(type, message) {
    // Создаем элемент уведомления
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 20px;
        background: ${type === 'success' ? '#00d166' : type === 'error' ? '#ef4444' : '#9147ff'};
        color: white;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        z-index: 10000;
        font-size: 14px;
        font-weight: 600;
        animation: slideIn 0.3s ease-out;
    `;
    notification.textContent = message;
    
    // Добавляем анимацию
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
    `;
    if (!document.head.querySelector('style[data-notification]')) {
        style.setAttribute('data-notification', 'true');
        document.head.appendChild(style);
    }
    
    document.body.appendChild(notification);
    
    // Удаляем уведомление через 3 секунды
    setTimeout(() => {
        notification.style.animation = 'slideIn 0.3s ease-out reverse';
        setTimeout(() => {
            notification.remove();
        }, 300);
    }, 3000);
}

window.addEventListener('beforeunload', () => {
    if (updateInterval) {
        clearInterval(updateInterval);
    }
});

