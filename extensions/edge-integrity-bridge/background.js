/**
 * Перехват Client-Integrity из gql Twitch и отправка в бот
 */

const DEFAULT_BOT_URL = 'http://127.0.0.1:3001';
const MIN_SEND_INTERVAL_MS = 15_000;
const GQL_URL_PATTERNS = ['https://gql.twitch.tv/*'];

/** @type {{ lastToken: string, lastSentAt: number, enabled: boolean }} */
let state = {
  lastToken: '',
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
 * @param {string} token
 * @param {string|null} deviceId
 */
async function sendToBot(token, deviceId) {
  if (!state.enabled) {
    return;
  }

  const now = Date.now();
  if (token === state.lastToken && now - state.lastSentAt < MIN_SEND_INTERVAL_MS) {
    return;
  }

  const stored = await chrome.storage.local.get(['botUrl', 'apiKey']);
  const botUrl = (stored.botUrl || DEFAULT_BOT_URL).replace(/\/$/, '');
  const apiKey = stored.apiKey?.trim() || '';

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  try {
    const res = await fetch(`${botUrl}/api/integrity/capture`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        clientIntegrity: token,
        deviceId: deviceId || undefined,
        source: 'edge-extension',
      }),
    });

    const body = await res.json().catch(() => ({}));

    if (res.ok && body.applied) {
      state.lastToken = token;
      state.lastSentAt = now;
      await chrome.storage.local.set({
        lastSuccessAt: now,
        lastMessage: body.message || 'OK',
      });
      console.log('[Integrity Bridge] applied:', body.message);
    } else if (res.ok && body.skipped) {
      console.log('[Integrity Bridge] skipped:', body.message);
    } else {
      await chrome.storage.local.set({
        lastErrorAt: now,
        lastMessage: body.message || body.error || res.statusText,
      });
      console.warn('[Integrity Bridge] error:', res.status, body);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await chrome.storage.local.set({ lastErrorAt: now, lastMessage: message });
    console.warn('[Integrity Bridge] fetch failed:', message);
  }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const integrity = readHeader(details.requestHeaders, 'Client-Integrity');
    if (!integrity) {
      return;
    }
    const deviceId = readHeader(details.requestHeaders, 'X-Device-Id');
    void sendToBot(integrity, deviceId);
  },
  { urls: GQL_URL_PATTERNS },
  ['requestHeaders', 'extraHeaders']
);
