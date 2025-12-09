const API_BASE = '/api';
let pointsChart = null;
let updateInterval = null;

// Загружаем состояние из localStorage или используем значения по умолчанию
let showOffline = localStorage.getItem('showOffline') !== 'false'; // По умолчанию показываем всех стримеров
let updateIntervalMs = parseInt(localStorage.getItem('updateIntervalMs')) || 5000; // Интервал обновления в миллисекундах
let selectedEventTags = new Set(JSON.parse(localStorage.getItem('selectedEventTags') || '[]')); // Выбранные теги событий
let availableEventTags = new Set(); // Доступные теги из событий

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

function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
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

async function updateOverallStats() {
    const stats = await fetchData('/overall');
    if (!stats) {
        updateConnectionStatus(false);
        // Показываем сообщение об ошибке, если сервис недоступен
        const statusText = document.getElementById('statusText');
        if (statusText) {
            statusText.textContent = 'Service unavailable';
        }
        return;
    }

    updateConnectionStatus(true);

    // Анимация обновления
    const cards = document.querySelectorAll('.stat-card');
    cards.forEach(card => {
        card.classList.add('updating');
        setTimeout(() => card.classList.remove('updating'), 300);
    });

    document.getElementById('activeWatches').textContent = stats.activeWatches || 0;
    document.getElementById('totalPoints').textContent = stats.totalPointsEarned || 0;
    document.getElementById('streamersCount').textContent = stats.streamersCount || 0;
    document.getElementById('lastActivity').textContent = formatTime(stats.lastActivity || 0);
}

async function updateStatistics() {
    // Запрашиваем всех стримеров, включая офлайн
    const stats = await fetchData('/statistics?includeOffline=true');
    if (!stats) return;

    const table = document.getElementById('watchesTable');
    
    if (stats.length === 0) {
        table.innerHTML = '<p style="color: #adadb8; text-align: center; padding: 20px;">No streamers configured</p>';
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

    // Анимация обновления
    table.classList.add('updating');
    
    table.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Streamer</th>
                    <th>Status</th>
                    <th>Watch Time</th>
                    <th>Points Earned</th>
                    <th>Current Points</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${sortedStats.map(s => `
                    <tr>
                        <td class="streamer-name">${s.streamerName}</td>
                        <td>
                            <span class="status-indicator ${s.status === 'ONLINE' ? 'status-online' : 'status-offline'}"></span>
                            ${s.status}
                        </td>
                        <td>${formatTime(s.elapsedTime)}</td>
                        <td>${s.pointsEarned}</td>
                        <td>${s.currentPoints}</td>
                        <td>
                            <button onclick="removeStreamer('${s.streamerName}')" 
                                    class="remove-btn" 
                                    style="padding: 4px 12px; background: #ef4444; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;"
                                    title="Remove streamer">
                                Remove
                            </button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    setTimeout(() => table.classList.remove('updating'), 300);
}

let pointsHistoryCache = []; // Кэш для доступа к истории в tooltip

async function updatePointsChart() {
    const history = await fetchData('/points-history?limit=200');
    pointsHistoryCache = history || []; // Сохраняем в кэш для tooltip
    
    if (!history || history.length === 0) {
        // Если истории нет, показываем пустой график
        if (pointsChart) {
            pointsChart.data.labels = [];
            pointsChart.data.datasets = [];
            pointsChart.update();
        }
        return;
    }

    const ctx = document.getElementById('pointsChart');
    
    // Группируем по стримерам и дням, суммируя баллы за каждый день
    const streamersMap = new Map();
    
    history.forEach(entry => {
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
    
    // Преобразуем в формат для графика и вычисляем накопленную сумму
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
        
        // Вычисляем накопленную сумму баллов по дням
        let accumulatedPoints = 0;
        const processedData = daysArray.map(point => {
            accumulatedPoints += point.y;
            return {
                x: point.x,
                y: accumulatedPoints,
                dayKey: point.dayKey
            };
        });
        
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
                        position: 'top'
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
                                return `${dataset.label}: ${context.parsed.y} total (+${pointsGained} this day)`;
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
                            text: 'Total Points Earned',
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
        
        // Проверяем, появился ли новый день
        const hasNewDay = checkForNewDay(oldDatasets, datasets);
        
        if (hasNewDay) {
            // Если появился новый день, сбрасываем зум и границы масштаба
            if (pointsChart.resetZoom && typeof pointsChart.resetZoom === 'function') {
                try {
                    pointsChart.resetZoom();
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
    
    if (events.length === 0) {
        list.innerHTML = '<p style="color: #adadb8; text-align: center; padding: 20px;">No events yet</p>';
        return;
    }

    // Фильтруем события по выбранным тегам
    let filteredEvents = events;
    if (selectedEventTags.size > 0) {
        filteredEvents = events.filter(event => selectedEventTags.has(event.type));
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
                        
                        return `
                            <div class="event-item ${isNew ? 'new' : ''} ${importantClass}" data-timestamp="${event.timestamp}">
                                <span class="event-time">${formatTimestamp(event.timestamp)}</span>
                                <span class="event-type ${typeClass}" ${styleAttr}>${event.type}</span>
                                <strong>${event.streamer}</strong>: ${event.message}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    });

    list.innerHTML = html;

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

async function updateEvents() {
    const events = await fetchData('/events?limit=20');
    if (!events) return;

    // Сохраняем события в кэш
    cachedEvents = events;

    // Обновляем доступные теги
    updateAvailableTags(events);

    // Обновляем timestamp для определения новых событий
    if (events.length > 0) {
        lastEventTimestamp = events[0].timestamp;
    }

    // Отображаем отфильтрованные события
    renderFilteredEvents(events);
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
        updateEvents(),
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
    });
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

