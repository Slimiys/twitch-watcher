/* Category history, streamer comparison and a plain-language bot activity summary. */
let insightHistory = [];
let insightCategories = [];
let insightHistoryFailed = false;
let insightComparisonFailed = false;
let insightRequest = 0;
let insightSelection = new Set();
let insightOptionsKey = '';
let insightHealth = null;
let insightInitialization = null;

function getBotActivity(health, initialization) {
    if (!initialization && !health) return 'unavailable';
    if (initialization?.needsToken) return 'token';
    if (initialization && !initialization.isInitialized) return 'starting';
    if (!health) return 'unavailable';
    if (!health.watcherRunning) return 'stopped';
    if (health.websocket?.status === 'reconnecting' || health.websocket?.status === 'disconnected' ||
        health.graphql?.circuitBreaker === 'OPEN' || health.graphql?.hadRecentNetworkFailure) return 'reconnecting';
    return health.activeWatchCount > 0 ? 'watching' : 'waiting';
}

function renderBotActivity(health = insightHealth, initialization = insightInitialization) {
    insightHealth = health;
    insightInitialization = initialization;
    const panel = document.getElementById('botActivityPanel');
    if (!panel) return;
    const state = getBotActivity(health, initialization);
    panel.dataset.state = state;
    panel.innerHTML = `<strong>${escapeHtml(t(`activity.${state}`))}</strong>
        <span>${escapeHtml(t(`activity.${state}Hint`, { count: health?.activeWatchCount || 0 }))}</span>`;
}

function buildStreamerComparison(categories, names) {
    const totals = names.map(() => 0);
    const rows = categories.map(category => {
        const durations = names.map((name, index) => {
            const ms = (category.streamers || []).filter(s => s.streamerName === name)
                .reduce((sum, s) => sum + Math.max(0, Number(s.durationMs) || 0), 0);
            totals[index] += ms;
            return ms;
        });
        return { category: category.category, durations };
    }).filter(row => row.durations.some(ms => ms > 0));
    rows.sort((a, b) => b.durations.reduce((x, y) => x + y, 0) - a.durations.reduce((x, y) => x + y, 0));
    return { rows, totals };
}

function formatComparisonDuration(ms) {
    return ms > 0 && ms < 60_000 ? t('insights.underMinute') : formatCategoryStreamDuration(ms);
}

function renderStreamerComparison() {
    const options = document.getElementById('comparisonOptions');
    const wrap = document.getElementById('streamerComparisonTable');
    if (!options || !wrap) return;
    const names = [...new Set(insightCategories.flatMap(c => (c.streamers || []).map(s => s.streamerName)))].sort();
    for (const name of insightSelection) if (!names.includes(name)) insightSelection.delete(name);
    const key = JSON.stringify([names, [...insightSelection]]);
    if (key !== insightOptionsKey) {
        options.innerHTML = names.map(name => `<label class="comparison-choice"><input type="checkbox"
            value="${escapeHtml(name)}" ${insightSelection.has(name) ? 'checked' : ''}>${escapeHtml(name)}</label>`).join('');
        insightOptionsKey = key;
    }
    options.querySelectorAll('input').forEach(input => { input.disabled = insightSelection.size >= 4 && !input.checked; });
    document.getElementById('comparisonLoadState').textContent = insightComparisonFailed ? t('insights.loadFailed') : '';
    if (insightSelection.size < 2) {
        wrap.innerHTML = `<p class="insight-hint">${escapeHtml(t(names.length ? 'insights.choose' : 'insights.noStats'))}</p>`;
        return;
    }
    const selected = [...insightSelection];
    const { rows, totals } = buildStreamerComparison(insightCategories, selected);
    wrap.innerHTML = `<table class="insight-table"><caption>${escapeHtml(t('insights.comparisonCaption'))}</caption>
        <thead><tr><th scope="col">${escapeHtml(t('insights.category'))}</th>${selected.map(n => `<th scope="col">${escapeHtml(n)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(row => `<tr><th scope="row">${escapeHtml(row.category)}</th>${row.durations.map(ms => `<td>${escapeHtml(ms > 0 ? formatComparisonDuration(ms) : '—')}</td>`).join('')}</tr>`).join('')}</tbody>
        <tfoot><tr><th scope="row">${escapeHtml(t('insights.total'))}</th>${totals.map(ms => `<td>${escapeHtml(formatComparisonDuration(ms))}</td>`).join('')}</tr></tfoot></table>`;
}

function renderCategoryHistory() {
    const wrap = document.getElementById('categoryHistoryTable');
    if (!wrap) return;
    const query = (document.getElementById('categoryHistorySearch')?.value || '').trim().toLowerCase();
    const rows = insightHistory.filter(row => row.streamerName.toLowerCase().includes(query));
    document.getElementById('historyLoadState').textContent = insightHistoryFailed ? t('insights.loadFailed') : '';
    if (!rows.length) {
        wrap.innerHTML = `<p class="insight-hint">${escapeHtml(t(query ? 'filters.noMatches' : 'insights.noHistory'))}</p>`;
        return;
    }
    wrap.innerHTML = `<table class="insight-table"><thead><tr>
        <th scope="col">${escapeHtml(t('insights.time'))}</th><th scope="col">${escapeHtml(t('col.streamer'))}</th>
        <th scope="col">${escapeHtml(t('insights.from'))}</th><th scope="col">${escapeHtml(t('insights.to'))}</th></tr></thead>
        <tbody>${rows.map(row => `<tr><td>${escapeHtml(new Date(row.observedAt).toLocaleString(getNumberLocale()))}</td>
        <th scope="row">${escapeHtml(row.streamerName)}</th><td>${escapeHtml(row.fromCategory)}</td><td>${escapeHtml(row.toCategory)}</td></tr>`).join('')}</tbody></table>`;
}

async function updateDashboardInsights() {
    const request = ++insightRequest;
    const [history, comparison] = await Promise.all([fetchData('/category-changes'), fetchData('/streamer-comparison')]);
    if (request !== insightRequest) return;
    insightHistoryFailed = !Array.isArray(history?.changes);
    insightComparisonFailed = !Array.isArray(comparison?.categories);
    if (!insightHistoryFailed) insightHistory = history.changes;
    if (!insightComparisonFailed) insightCategories = comparison.categories;
    renderCategoryHistory();
    renderStreamerComparison();
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('comparisonOptions')?.addEventListener('change', event => {
        const input = event.target;
        if (input.type !== 'checkbox') return;
        if (input.checked && insightSelection.size < 4) insightSelection.add(input.value);
        else insightSelection.delete(input.value);
        // Preserve keyboard focus: do not recreate options on selection changes.
        const names = [...new Set(insightCategories.flatMap(c => (c.streamers || []).map(s => s.streamerName)))].sort();
        insightOptionsKey = JSON.stringify([names, [...insightSelection]]);
        renderStreamerComparison();
    });
    document.getElementById('categoryHistorySearch')?.addEventListener('input', renderCategoryHistory);
    document.getElementById('retryInsights')?.addEventListener('click', updateDashboardInsights);
});
