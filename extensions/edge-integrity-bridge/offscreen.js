/**
 * Offscreen-документ: держит EventSource живым (service worker MV3 засыпает)
 */

const KEEP_ALIVE_MS = 20_000;
const SSE_RECONNECT_MS = 5_000;

/** @type {EventSource|null} */
let eventSource = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let reconnectTimer = null;
/** @type {ReturnType<typeof setInterval>|null} */
let keepAliveTimer = null;
let streamUrl = '';
let enabled = false;

/**
 * @param {string} type
 * @param {Record<string, unknown>} [payload]
 */
function postToBackground(type, payload = {}) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {
    // background мог быть выгружен — keepalive разбудит его
  });
}

function clearReconnectTimer() {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function disconnectSse() {
  clearReconnectTimer();
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function scheduleReconnect() {
  if (!enabled || reconnectTimer != null) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSse();
  }, SSE_RECONNECT_MS);
}

function connectSse() {
  if (!enabled || !streamUrl) {
    return;
  }

  disconnectSse();

  try {
    const source = new EventSource(streamUrl);
    eventSource = source;

    source.onopen = () => {
      postToBackground('OFFSCREEN_SSE_STATUS', { connected: true });
    };

    source.onmessage = (messageEvent) => {
      postToBackground('OFFSCREEN_STREAM_EVENT', { raw: messageEvent.data });
    };

    source.onerror = () => {
      source.close();
      if (eventSource === source) {
        eventSource = null;
      }
      postToBackground('OFFSCREEN_SSE_STATUS', { connected: false });
      scheduleReconnect();
    };
  } catch (err) {
    console.warn('[Offscreen SSE] connect:', err);
    scheduleReconnect();
  }
}

function startKeepAlive() {
  if (keepAliveTimer != null) {
    return;
  }
  keepAliveTimer = setInterval(() => {
    postToBackground('OFFSCREEN_KEEPALIVE');
  }, KEEP_ALIVE_MS);
  postToBackground('OFFSCREEN_KEEPALIVE');
}

function stopKeepAlive() {
  if (keepAliveTimer != null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'OFFSCREEN_START_SSE') {
    enabled = true;
    streamUrl = String(message.url || '');
    startKeepAlive();
    connectSse();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'OFFSCREEN_STOP_SSE') {
    enabled = false;
    disconnectSse();
    stopKeepAlive();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'OFFSCREEN_PING') {
    sendResponse({
      ok: true,
      enabled,
      connected: eventSource?.readyState === EventSource.OPEN,
    });
    return false;
  }

  return false;
});
