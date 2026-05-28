/**
 * Связь дашборда бота с service worker расширения
 */

const DASHBOARD_MESSAGE_SOURCE = 'twitch-watcher-dashboard';

/**
 * @param {string} origin
 */
function isTrustedDashboardOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:') {
      return false;
    }
    return (
      url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '0.0.0.0'
    );
  } catch {
    return false;
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window) {
    return;
  }
  if (!isTrustedDashboardOrigin(event.origin)) {
    return;
  }
  const data = event.data;
  if (!data || data.source !== DASHBOARD_MESSAGE_SOURCE) {
    return;
  }
  if (data.type === 'REQUEST_INTEGRITY_CAPTURE') {
    chrome.runtime.sendMessage({ type: 'REQUEST_INTEGRITY_CAPTURE' });
  }
});
