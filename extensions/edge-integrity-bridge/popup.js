const DEFAULT_BOT_URL = 'http://127.0.0.1:3001';

const botUrlInput = document.getElementById('botUrl');
const apiKeyInput = document.getElementById('apiKey');
const enabledInput = document.getElementById('enabled');
const statusEl = document.getElementById('status');
const toggleStreamNotifyBtn = document.getElementById('toggleStreamNotify');

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
  apiKeyInput.value = data.apiKey || '';
  enabledInput.checked = data.enabled !== false;

  await loadStreamNotifyState();

  if (data.lastSuccessAt) {
    const ago = Math.round((Date.now() - data.lastSuccessAt) / 1000);
    setStatus(`Последняя передача integrity: ${ago} с назад. ${data.lastMessage || ''}`, 'ok');
  } else if (data.lastErrorAt) {
    setStatus(`Ошибка: ${data.lastMessage || '—'}`, 'err');
  }
}

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    botUrl: botUrlInput.value.trim() || DEFAULT_BOT_URL,
    apiKey: apiKeyInput.value.trim(),
    enabled: enabledInput.checked,
  });
  setStatus('Сохранено', 'ok');
});

document.getElementById('test').addEventListener('click', async () => {
  const botUrl = (botUrlInput.value.trim() || DEFAULT_BOT_URL).replace(/\/$/, '');
  const apiKey = apiKeyInput.value.trim();
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
    const keyHint = body.apiKeyRequired ? 'нужен API-ключ' : 'ключ не требуется';
    setStatus(`Бот доступен (${keyHint})`, 'ok');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'err');
  }
});

toggleStreamNotifyBtn.addEventListener('click', async () => {
  toggleStreamNotifyBtn.disabled = true;
  try {
    const enabled = await readStreamNotificationsEnabled();
    const next = !enabled;
    // Сразу обновляем UI; background подхватит через storage.onChanged
    renderStreamNotifyStatus(next);
    await chrome.storage.local.set({ streamNotificationsEnabled: next });
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'err');
    await loadStreamNotifyState();
  } finally {
    toggleStreamNotifyBtn.disabled = false;
  }
});

// Синхронизация при переключении хоткеем или из background
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || changes.streamNotificationsEnabled == null) {
    return;
  }
  renderStreamNotifyButton(Boolean(changes.streamNotificationsEnabled.newValue));
});

load();
