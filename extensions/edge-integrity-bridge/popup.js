const DEFAULT_BOT_URL = 'http://127.0.0.1:3001';

const botUrlInput = document.getElementById('botUrl');
const apiKeyInput = document.getElementById('apiKey');
const enabledInput = document.getElementById('enabled');
const statusEl = document.getElementById('status');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ` ${kind}` : '');
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

  if (data.lastSuccessAt) {
    const ago = Math.round((Date.now() - data.lastSuccessAt) / 1000);
    setStatus(`Последняя передача: ${ago} с назад. ${data.lastMessage || ''}`, 'ok');
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

load();
