/**
 * Перехват Client-Integrity и GQL-заголовков из gql Twitch и отправка в бот
 */

const DEFAULT_BOT_URL = 'http://127.0.0.1:3001';
const MIN_SEND_INTERVAL_MS = 15_000;
const GQL_URL_PATTERNS = ['https://gql.twitch.tv/*'];
const CAPTURE_REQUEST_POLL_MS = 5_000;
const TWITCH_TAB_URLS = ['*://*.twitch.tv/*', '*://twitch.tv/*'];

/** @type {{ lastFingerprint: string, lastSentAt: number, enabled: boolean }} */
let state = {
  lastFingerprint: '',
  lastSentAt: 0,
  enabled: true,
};

chrome.storage.local.get(['botUrl', 'apiKey', 'enabled'], (data) => {
  if (typeof data.enabled === 'boolean') {
    state.enabled = data.enabled;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || changes.enabled == null) {
    return;
  }
  state.enabled = Boolean(changes.enabled.newValue);
});

/**
 * @param {chrome.webRequest.HttpHeader[]|undefined} headers
 */
function readHeader(headers, name) {
  if (!headers) {
    return null;
  }
  const lower = name.toLowerCase();
  const found = headers.find((h) => h.name.toLowerCase() === lower);
  return found?.value?.trim() || null;
}

/**
 * @param {chrome.webRequest.HttpHeader[]|undefined} headers
 */
function capturePayloadFromHeaders(headers) {
  return {
    clientIntegrity: readHeader(headers, 'Client-Integrity'),
    deviceId: readHeader(headers, 'X-Device-Id'),
    clientVersion: readHeader(headers, 'Client-Version'),
    clientSessionId: readHeader(headers, 'Client-Session-Id'),
    source: 'edge-extension',
  };
}

/**
 * @param {{ clientIntegrity: string|null, deviceId: string|null, clientVersion: string|null, clientSessionId: string|null }} payload
 */
function payloadFingerprint(payload) {
  return JSON.stringify([
    payload.clientIntegrity || '',
    payload.deviceId || '',
    payload.clientVersion || '',
    payload.clientSessionId || '',
  ]);
}

/**
 * @param {{ clientIntegrity: string|null, deviceId: string|null, clientVersion: string|null, clientSessionId: string|null, source: string }} payload
 */
async function sendToBot(payload) {
  if (!state.enabled) {
    return;
  }

  if (!payload.clientIntegrity) {
    return;
  }

  const fingerprint = payloadFingerprint(payload);
  const now = Date.now();
  if (fingerprint === state.lastFingerprint && now - state.lastSentAt < MIN_SEND_INTERVAL_MS) {
    return;
  }

  const stored = await chrome.storage.local.get(['botUrl', 'apiKey']);
  const botUrl = (stored.botUrl || DEFAULT_BOT_URL).replace(/\/$/, '');
  const apiKey = stored.apiKey?.trim() || '';

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  const body = {
    clientIntegrity: payload.clientIntegrity,
    source: payload.source,
  };
  if (payload.deviceId) {
    body.deviceId = payload.deviceId;
  }
  if (payload.clientVersion) {
    body.clientVersion = payload.clientVersion;
  }
  if (payload.clientSessionId) {
    body.clientSessionId = payload.clientSessionId;
  }

  try {
    const res = await fetch(`${botUrl}/api/integrity/capture`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const responseBody = await res.json().catch(() => ({}));

    if (res.ok && responseBody.applied) {
      state.lastFingerprint = fingerprint;
      state.lastSentAt = now;
      await chrome.storage.local.set({
        lastSuccessAt: now,
        lastMessage: responseBody.message || 'OK',
      });
      console.log('[Integrity Bridge] applied:', responseBody.message);
    } else if (res.ok && responseBody.skipped) {
      console.log('[Integrity Bridge] skipped:', responseBody.message);
    } else {
      await chrome.storage.local.set({
        lastErrorAt: now,
        lastMessage: responseBody.message || responseBody.error || res.statusText,
      });
      console.warn('[Integrity Bridge] error:', res.status, responseBody);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await chrome.storage.local.set({ lastErrorAt: now, lastMessage: message });
    console.warn('[Integrity Bridge] fetch failed:', message);
  }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const payload = capturePayloadFromHeaders(details.requestHeaders);
    void sendToBot(payload);
  },
  { urls: GQL_URL_PATTERNS },
  ['requestHeaders', 'extraHeaders']
);

/** @type {ReturnType<typeof setTimeout>|null} */
let captureRequestPollTimer = null;

/**
 * Сбрасывает троттлинг и обновляет вкладку Twitch для нового gql
 */
async function triggerTwitchIntegrityCapture() {
  state.lastSentAt = 0;
  state.lastFingerprint = '';

  const tabs = await chrome.tabs.query({ url: TWITCH_TAB_URLS });
  const tabId = tabs.find((t) => t.id != null)?.id;
  if (tabId != null) {
    await chrome.tabs.reload(tabId);
    return;
  }
  await chrome.tabs.create({ url: 'https://www.twitch.tv/' });
}

async function fetchCaptureStatus() {
  const stored = await chrome.storage.local.get(['botUrl', 'apiKey']);
  const botUrl = (stored.botUrl || DEFAULT_BOT_URL).replace(/\/$/, '');
  const headers = {};
  const apiKey = stored.apiKey?.trim() || '';
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  const res = await fetch(`${botUrl}/api/integrity/capture/status`, { headers });
  if (!res.ok) {
    return null;
  }
  return res.json();
}

async function pollBridgeCaptureRequest() {
  captureRequestPollTimer = null;
  try {
    const data = await fetchCaptureStatus();
    if (!data?.captureRequestPending || !data.captureRequestedAt) {
      return;
    }

    const handled = await chrome.storage.local.get(['lastHandledCaptureRequestAt']);
    if (handled.lastHandledCaptureRequestAt === data.captureRequestedAt) {
      scheduleCaptureRequestPoll();
      return;
    }

    await chrome.storage.local.set({
      lastHandledCaptureRequestAt: data.captureRequestedAt,
    });
    await triggerTwitchIntegrityCapture();
    scheduleCaptureRequestPoll();
  } catch (err) {
    console.warn('[Integrity Bridge] poll capture request:', err);
  }
}

function scheduleCaptureRequestPoll() {
  if (captureRequestPollTimer != null) {
    clearTimeout(captureRequestPollTimer);
  }
  captureRequestPollTimer = setTimeout(() => {
    void pollBridgeCaptureRequest();
  }, CAPTURE_REQUEST_POLL_MS);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'REQUEST_INTEGRITY_CAPTURE') {
    void triggerTwitchIntegrityCapture().then(() => {
      scheduleCaptureRequestPoll();
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});

chrome.alarms.create('pollCaptureRequest', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollCaptureRequest') {
    void pollBridgeCaptureRequest();
  }
});

void pollBridgeCaptureRequest();
