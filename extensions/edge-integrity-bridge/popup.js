const DEFAULT_BOT_URL = 'http://127.0.0.1:3001';

const botUrlInput = document.getElementById('botUrl');
const enabledInput = document.getElementById('enabled');
const statusEl = document.getElementById('status');
const toggleStreamNotifyBtn = document.getElementById('toggleStreamNotify');
const testStreamNotifyBtn = document.getElementById('testStreamNotify');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ` ${kind}` : '');
}

function renderStreamNotifyButton(enabled) {
  toggleStreamNotifyBtn.textContent = enabled
    ? 'Уведомления: вкл'
    : 'Уведомления: выкл';
  toggleStreamNotifyBtn.classList.toggle('on', enabled);
  toggleStreamNotifyBtn.classList.toggle('off', !enabled);
}

function renderStreamNotifyStatus(enabled) {
  renderStreamNotifyButton(enabled);
  setStatus(
    enabled ? 'Уведомления о стримах включены' : 'Уведомления о стримах выключены',
    enabled ? 'ok' : ''
  );
}

async function readStoredBridgeConfig() {
  return chrome.storage.local.get(['botUrl', 'apiKey', 'enabled']);
}

async function readStreamNotificationsEnabled() {
  const data = await chrome.storage.local.get(['streamNotificationsEnabled']);
  return data.streamNotificationsEnabled === true;
}

async function loadStreamNotifyState() {
  const enabled = await readStreamNotificationsEnabled();
  renderStreamNotifyButton(enabled);
  return enabled;
}

async function load() {
  const data = await chrome.storage.local.get([
    'botUrl',
    'apiKey',
    'enabled',
    'lastMessage',
    'lastSuccessAt',
    'lastErrorAt',
  ]);

  botUrlInput.value = data.botUrl || DEFAULT_BOT_URL;
  enabledInput.checked = data.enabled !== false;

  await loadStreamNotifyState();

  if (data.lastSuccessAt) {
    const ago = Math.round((Date.now() - data.lastSuccessAt) / 1000);
    setStatus(`Последняя передача integrity: ${ago} с назад. ${data.lastMessage || ''}`, 'ok');
  } else if (data.lastErrorAt) {
    setStatus(`Ошибка: ${data.lastMessage || '—'}`, 'err');
  } else if (data.apiKey?.trim()) {
    setStatus('API-ключ получен с dashboard', 'ok');
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const stored = await readStoredBridgeConfig();
  const botUrl = botUrlInput.value.trim() || DEFAULT_BOT_URL;
  const apiKey = stored.apiKey?.trim() || '';

  await chrome.storage.local.set({
    botUrl,
    apiKey,
    enabled: enabledInput.checked,
  });
  setStatus('Сохранено', 'ok');
  if (await readStreamNotificationsEnabled()) {
    await chrome.runtime.sendMessage({
      type: 'SET_STREAM_NOTIFICATIONS',
      enabled: true,
      botUrl,
      apiKey,
    });
  }
});

document.getElementById('test').addEventListener('click', async () => {
  const stored = await readStoredBridgeConfig();
  const botUrl = (botUrlInput.value.trim() || DEFAULT_BOT_URL).replace(/\/$/, '');
  const apiKey = stored.apiKey?.trim() || '';
  const headers = {};
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  try {
    const res = await fetch(`${botUrl}/api/integrity/capture/status`, { headers });
    const body = await res.json();
    if (!res.ok) {
      setStatus(`HTTP ${res.status}: ${body.message || body.error || ''}`, 'err');
      return;
    }
    if (body.apiKeyRequired && !apiKey) {
      setStatus('Бот доступен, но нужен API-ключ — откройте dashboard и сохраните «Конфиг бота»', 'err');
      return;
    }
    const keyHint = body.apiKeyRequired ? 'ключ получен' : 'ключ не требуется';
    setStatus(`Бот доступен (${keyHint})`, 'ok');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'err');
  }
});

toggleStreamNotifyBtn.addEventListener('click', async () => {
  toggleStreamNotifyBtn.disabled = true;
  try {
    const stored = await readStoredBridgeConfig();
    const enabled = await readStreamNotificationsEnabled();
    const next = !enabled;
    const botUrl = botUrlInput.value.trim() || DEFAULT_BOT_URL;
    const apiKey = stored.apiKey?.trim() || '';
    const response = await chrome.runtime.sendMessage({
      type: 'SET_STREAM_NOTIFICATIONS',
      enabled: next,
      botUrl,
      apiKey,
    });
    renderStreamNotifyStatus(Boolean(response?.enabled ?? next));
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'err');
    await loadStreamNotifyState();
  } finally {
    toggleStreamNotifyBtn.disabled = false;
  }
});

testStreamNotifyBtn.addEventListener('click', async () => {
  testStreamNotifyBtn.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TEST_STREAM_NOTIFICATION',
      kind: 'stream-up',
    });
    if (response?.ok) {
      setStatus('Тестовое уведомление отправлено (ONLINE: test_streamer)', 'ok');
      return;
    }
    setStatus(response?.message || 'Не удалось показать уведомление', 'err');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'err');
  } finally {
    testStreamNotifyBtn.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }
  if (changes.streamNotificationsEnabled != null) {
    renderStreamNotifyButton(Boolean(changes.streamNotificationsEnabled.newValue));
  }
  if (changes.apiKey?.newValue) {
    setStatus('API-ключ получен с dashboard', 'ok');
  }
});

load();
