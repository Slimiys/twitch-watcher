/**
 * Уведомления stream-up / stream-down через SSE бота (offscreen + alarm fallback)
 */

const STREAM_EVENTS_ALARM = 'pollStreamEvents';
const STREAM_EVENT_TYPES = new Set(['stream-up', 'stream-down']);
const OFFSCREEN_URL = 'offscreen.html';

/**
 * Edge требует iconUrl для chrome.notifications (type, title, message, iconUrl)
 */
function getNotificationIconUrl() {
  return chrome.runtime.getURL('icon128.png');
}

/**
 * @param {string} title
 * @param {string} message
 * @param {number} [priority]
 */
function buildBasicNotificationOptions(title, message, priority = 2) {
  return {
    type: 'basic',
    iconUrl: getNotificationIconUrl(),
    title,
    message,
    priority,
  };
}

let streamNotificationsEnabled = false;
let lastStreamEventTimestamp = 0;
let offscreenSseConnected = false;

/**
 * @returns {Promise<{ botUrl: string, headers: Record<string, string> }>}
 */
async function getBotRequestConfig() {
  const stored = await chrome.storage.local.get(['botUrl', 'apiKey']);
  const botUrl = (stored.botUrl || 'http://127.0.0.1:3001').replace(/\/$/, '');
  const headers = {};
  const apiKey = stored.apiKey?.trim() || '';
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  return { botUrl, headers };
}

/**
 * Сохраняет метку последнего обработанного события
 */
async function persistLastStreamEventTimestamp() {
  await chrome.storage.local.set({ lastStreamEventTimestamp });
}

/**
 * Базовая линия — не уведомлять о старых событиях при включении
 */
async function primeStreamEventBaseline() {
  const { botUrl, headers } = await getBotRequestConfig();
  try {
    const res = await fetch(`${botUrl}/api/events?limit=1&offset=0`, { headers });
    if (!res.ok) {
      return;
    }
    const body = await res.json();
    const latest = body?.events?.[0];
    if (latest?.timestamp > lastStreamEventTimestamp) {
      lastStreamEventTimestamp = latest.timestamp;
      await persistLastStreamEventTimestamp();
    }
  } catch (err) {
    console.warn('[Stream Notify] prime baseline:', err);
  }
}

/**
 * @param {{ type?: string, streamer?: string, message?: string, timestamp?: number }} event
 */
function shouldHandleStreamEvent(event) {
  if (!event?.type || !STREAM_EVENT_TYPES.has(event.type)) {
    return false;
  }
  const ts = Number(event.timestamp) || 0;
  if (ts <= lastStreamEventTimestamp) {
    return false;
  }
  return Boolean(event.streamer?.trim());
}

/**
 * @param {{ type?: string, streamer?: string, message?: string, timestamp?: number }} event
 */
async function handleStreamHubEvent(event) {
  if (!streamNotificationsEnabled || !shouldHandleStreamEvent(event)) {
    return;
  }

  lastStreamEventTimestamp = Number(event.timestamp) || Date.now();
  await persistLastStreamEventTimestamp();

  const isUp = event.type === 'stream-up';
  const streamer = String(event.streamer).trim();
  const title = isUp ? 'Стрим ONLINE' : 'Стрим OFFLINE';
  const message =
    event.message?.trim() ||
    (isUp ? 'Стример вышел в эфир' : 'Стрим завершён');

  chrome.notifications.create(
    `stream-${streamer}-${lastStreamEventTimestamp}`,
    buildBasicNotificationOptions(`${title}: ${streamer}`, message, 2)
  );
}

/**
 * URL SSE с API-ключом (EventSource не поддерживает заголовки)
 * @param {string} botUrl
 * @param {string} apiKey
 */
function buildStreamEventSourceUrl(botUrl, apiKey) {
  let url = `${botUrl}/api/events/stream`;
  if (apiKey) {
    url += `?apiKey=${encodeURIComponent(apiKey)}`;
  }
  return url;
}

/**
 * Есть ли уже offscreen-документ
 */
async function hasOffscreenDocument() {
  if (chrome.offscreen?.hasDocument) {
    return chrome.offscreen.hasDocument();
  }
  const contexts = await chrome.runtime.getContexts?.({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return Array.isArray(contexts) && contexts.length > 0;
}

/**
 * Создаёт offscreen-документ для постоянного SSE
 */
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'Держать SSE-соединение с ботом для мгновенных уведомлений о стримах',
  });
}

/**
 * Закрывает offscreen-документ
 */
async function closeOffscreenDocument() {
  try {
    if (await hasOffscreenDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (err) {
    console.warn('[Stream Notify] close offscreen:', err);
  }
  offscreenSseConnected = false;
}

/**
 * Отправляет сообщение в offscreen с короткими повторами (скрипт мог ещё не загрузиться)
 * @param {Record<string, unknown>} message
 */
async function sendToOffscreen(message) {
  const delays = [0, 100, 300, 800];
  let lastError = null;
  for (const delay of delays) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response?.ok) {
        return response;
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error('Offscreen не ответил на сообщение');
}

/**
 * Запускает SSE в offscreen (не в service worker — он засыпает)
 */
async function connectStreamEventSource() {
  if (!streamNotificationsEnabled) {
    return;
  }

  const { botUrl, headers } = await getBotRequestConfig();
  const apiKey = headers['X-API-Key'] || '';
  const url = buildStreamEventSourceUrl(botUrl, apiKey);

  try {
    await ensureOffscreenDocument();
    await sendToOffscreen({ type: 'OFFSCREEN_START_SSE', url });
  } catch (err) {
    console.warn('[Stream Notify] offscreen SSE:', err);
    void pollRecentStreamEvents();
  }
}

/**
 * Останавливает SSE в offscreen
 */
async function disconnectStreamEventSource() {
  try {
    if (await hasOffscreenDocument()) {
      await sendToOffscreen({ type: 'OFFSCREEN_STOP_SSE' });
    }
  } catch {
    // документ уже закрыт
  }
  await closeOffscreenDocument();
}

/**
 * Fallback: опрос последних событий (если SSE недоступен)
 */
async function pollRecentStreamEvents() {
  if (!streamNotificationsEnabled) {
    return;
  }

  const { botUrl, headers } = await getBotRequestConfig();
  try {
    const res = await fetch(`${botUrl}/api/events?limit=20&offset=0`, { headers });
    if (!res.ok) {
      return;
    }
    const body = await res.json();
    const events = Array.isArray(body?.events) ? body.events : [];
    const relevant = events
      .filter((e) => STREAM_EVENT_TYPES.has(e.type))
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    for (const event of relevant) {
      await handleStreamHubEvent(event);
    }
  } catch (err) {
    console.warn('[Stream Notify] poll:', err);
  }
}

/**
 * Сообщения от offscreen-документа
 * @param {unknown} message
 * @returns {boolean}
 */
function handleOffscreenMessage(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const msg = /** @type {{ type?: string, raw?: string, connected?: boolean }} */ (message);

  if (msg.type === 'OFFSCREEN_KEEPALIVE') {
    return true;
  }

  if (msg.type === 'OFFSCREEN_SSE_STATUS') {
    offscreenSseConnected = Boolean(msg.connected);
    if (!offscreenSseConnected && streamNotificationsEnabled) {
      void pollRecentStreamEvents();
    }
    return true;
  }

  if (msg.type === 'OFFSCREEN_STREAM_EVENT') {
    try {
      const data = JSON.parse(String(msg.raw || ''));
      void handleStreamHubEvent(data);
    } catch (err) {
      console.warn('[Stream Notify] SSE parse:', err);
    }
    return true;
  }

  return false;
}

/**
 * @param {boolean} enabled
 * @param {{ botUrl?: string, apiKey?: string }} [options]
 */
async function setStreamNotificationsEnabled(enabled, options = {}) {
  if (options.botUrl != null || options.apiKey != null) {
    await chrome.storage.local.set({
      ...(options.botUrl != null ? { botUrl: options.botUrl } : {}),
      ...(options.apiKey != null ? { apiKey: options.apiKey } : {}),
    });
  }

  streamNotificationsEnabled = enabled;
  await chrome.storage.local.set({ streamNotificationsEnabled: enabled });

  if (enabled) {
    await primeStreamEventBaseline();
    await connectStreamEventSource();
    chrome.alarms.create(STREAM_EVENTS_ALARM, { periodInMinutes: 1 });
    await pollRecentStreamEvents();
  } else {
    await disconnectStreamEventSource();
    await chrome.alarms.clear(STREAM_EVENTS_ALARM);
  }

  updateExtensionActionBadge();
  return enabled;
}

/**
 * Переключает уведомления о стримах
 */
async function toggleStreamNotifications() {
  await loadStreamNotificationsState();
  return setStreamNotificationsEnabled(!streamNotificationsEnabled);
}

async function loadStreamNotificationsState() {
  const data = await chrome.storage.local.get([
    'streamNotificationsEnabled',
    'lastStreamEventTimestamp',
  ]);
  streamNotificationsEnabled = data.streamNotificationsEnabled === true;
  lastStreamEventTimestamp = Number(data.lastStreamEventTimestamp) || 0;
  return streamNotificationsEnabled;
}

function updateExtensionActionBadge() {
  if (streamNotificationsEnabled) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#00a86b' });
    chrome.action.setTitle({ title: 'Twitch Watcher Bridge — уведомления о стримах включены' });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Twitch Watcher Bridge — уведомления о стримах выключены' });
  }
}

/**
 * Тестовое системное уведомление (проверка разрешений Windows / Edge)
 * @param {'stream-up'|'stream-down'} [kind]
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
function showTestStreamNotification(kind = 'stream-up') {
  return new Promise((resolve) => {
    const isUp = kind === 'stream-up';
    const streamer = 'test_streamer';
    const title = isUp ? 'Стрим ONLINE' : 'Стрим OFFLINE';
    const message = isUp
      ? 'Тестовое уведомление: стример вышел в эфир'
      : 'Тестовое уведомление: стрим завершён';

    chrome.notifications.create(
      `stream-test-${Date.now()}`,
      buildBasicNotificationOptions(`${title}: ${streamer}`, message, 2),
      () => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, message: err.message || String(err) });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}

/**
 * Краткий toast о смене режима (hotkey / popup)
 * @param {boolean} enabled
 */
function showStreamNotifyToggleFeedback(enabled) {
  chrome.notifications.create(
    `stream-notify-toggle-${Date.now()}`,
    buildBasicNotificationOptions(
      'Twitch Watcher',
      enabled ? 'Уведомления о стримах включены' : 'Уведомления о стримах выключены',
      0
    )
  );
}

/**
 * Старт подсистемы уведомлений
 */
async function initStreamNotifications() {
  await loadStreamNotificationsState();
  updateExtensionActionBadge();

  if (streamNotificationsEnabled) {
    await connectStreamEventSource();
    chrome.alarms.create(STREAM_EVENTS_ALARM, { periodInMinutes: 1 });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') {
      return;
    }
    if (changes.streamNotificationsEnabled != null) {
      const next = Boolean(changes.streamNotificationsEnabled.newValue);
      if (next !== streamNotificationsEnabled) {
        void setStreamNotificationsEnabled(next);
      }
      return;
    }
    if ((changes.botUrl || changes.apiKey) && streamNotificationsEnabled) {
      void connectStreamEventSource();
    }
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== STREAM_EVENTS_ALARM) {
      return;
    }
    void pollRecentStreamEvents();
    if (streamNotificationsEnabled && !offscreenSseConnected) {
      void connectStreamEventSource();
    }
  });
}
