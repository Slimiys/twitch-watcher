import { readFileSync } from 'fs';
import { createContext, runInContext } from 'vm';
import { describe, it, expect, vi } from 'vitest';

function harness() {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', dataset: {}, querySelectorAll: () => [] });
    return elements.get(id);
  };
  const context = createContext({
    document: { addEventListener: vi.fn(), getElementById: element },
    t: (key: string) => key,
    escapeHtml: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    formatCategoryStreamDuration: (ms: number) => String(ms), getNumberLocale: () => 'en-US',
    fetchData: vi.fn(),
  });
  runInContext(readFileSync('src/web/dashboard-insights.js', 'utf8'), context);
  return { context, element, run: (code: string) => runInContext(code, context) };
}

describe('dashboard insights', () => {
  it('places the battery panel immediately below the connection status in the header', () => {
    const html = readFileSync('src/web/dashboard.html', 'utf8');
    expect(html.match(/id="hostBatteryPanel"/g)).toHaveLength(1);
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(header).toMatch(/id="statusText"[^>]*>[^<]*<\/span>\s*<\/div>\s*<div id="hostBatteryPanel"/);
  });

  it('renders the host battery, hides unsupported hosts and clears old values on failure', async () => {
    const h = harness();
    h.context.fetchData.mockResolvedValue({ available: true, percentage: 0, state: 'discharging', checkedAt: 1000 });
    await h.run('updateHostBattery()');
    expect(h.element('hostBatteryPanel').innerHTML).toContain('0%');
    expect(h.element('hostBatteryPanel').dataset.low).toBe('true');
    h.context.fetchData.mockResolvedValue(null);
    await h.run('updateHostBattery()');
    expect(h.element('hostBatteryPanel').innerHTML).not.toContain('0%');
    expect(h.element('hostBatteryPanel').innerHTML).toContain('battery.unavailable');
    h.context.fetchData.mockResolvedValue({ available: false, reason: 'unsupported' });
    await h.run('updateHostBattery()');
    expect(h.element('hostBatteryPanel').hidden).toBe(true);
  });

  it('distinguishes missing token, initialization, stopped, connection errors and active watches', () => {
    const h = harness();
    expect(h.run('getBotActivity(null, null)')).toBe('unavailable');
    expect(h.run('getBotActivity(null, {needsToken:true,isInitialized:true})')).toBe('token');
    expect(h.run('getBotActivity(null, {isInitialized:false})')).toBe('starting');
    expect(h.run('getBotActivity({watcherRunning:false},{isInitialized:true})')).toBe('stopped');
    expect(h.run("getBotActivity({watcherRunning:true,websocket:{status:'reconnecting'}},null)")).toBe('reconnecting');
    expect(h.run("getBotActivity({watcherRunning:true,graphql:{circuitBreaker:'OPEN'}},null)")).toBe('reconnecting');
    expect(h.run('getBotActivity({watcherRunning:true,activeWatchCount:2},null)')).toBe('watching');
    expect(h.run('getBotActivity({watcherRunning:true,activeWatchCount:0},null)')).toBe('waiting');
  });

  it('compares selected streamers without mixing similarly named categories or losing short intervals', () => {
    const h = harness();
    h.context.categories = [
      { category: 'Path of Exile', streamers: [{ streamerName: 'a', durationMs: 90_000 }, { streamerName: 'b', durationMs: 30_000 }] },
      { category: 'Path of Exile 2', streamers: [{ streamerName: 'b', durationMs: 120_000 }, { streamerName: 'other', durationMs: 1_000_000 }] },
    ];
    const matrix = h.run("buildStreamerComparison(categories, ['a','b'])");
    expect(matrix.totals).toEqual([90_000, 150_000]);
    expect(matrix.rows).toHaveLength(2);
    expect(matrix.rows.find((r: any) => r.category === 'Path of Exile 2').durations).toEqual([0, 120_000]);
    expect(h.run('formatComparisonDuration(30_000)')).toBe('insights.underMinute');
  });

  it('keeps cached history on failure, filters names, and escapes remote values', async () => {
    const h = harness();
    h.context.fetchData.mockImplementation(async (url: string) => url === '/category-changes'
      ? { changes: [{ streamerName: '<unsafe>', fromCategory: '<script>', toCategory: 'PoE', observedAt: 1000 }] }
      : { categories: [] });
    await h.run('updateDashboardInsights()');
    expect(h.element('categoryHistoryTable').innerHTML).toContain('&lt;script>');
    expect(h.element('categoryHistoryTable').innerHTML).not.toContain('<script>');
    h.context.fetchData.mockResolvedValue(null);
    await h.run('updateDashboardInsights()');
    expect(h.element('historyLoadState').textContent).toBe('insights.loadFailed');
    expect(h.element('categoryHistoryTable').innerHTML).toContain('PoE');
    h.element('categoryHistorySearch').value = 'absent';
    h.run('renderCategoryHistory()');
    expect(h.element('categoryHistoryTable').innerHTML).toContain('filters.noMatches');
  });
});
