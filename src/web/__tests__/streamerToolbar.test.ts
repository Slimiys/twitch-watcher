import { readFileSync } from 'fs';
import { createContext, runInContext } from 'vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('src/web/dashboard.js', 'utf8');
function harness() {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', innerHTML: '', hidden: false, disabled: false, value: '',
      setAttribute: vi.fn(), querySelector: () => null,
      classList: { add: vi.fn(), remove: vi.fn() },
    });
    return elements.get(id);
  };
  const context = createContext({
    setTimeout: (fn: () => void) => fn(),
    document: { getElementById: element },
    t: (key: string, args: any = {}) => key === 'filters.count' ? `${args.shown}/${args.total}` : key,
    cachedStatisticsRows: null, selectedFavoriteCategoryFilterIds: new Set(), favoriteCategories: [],
    fetchData: vi.fn(), hideCategoryStreamStatsMenu: vi.fn(), hideStreamSessionsMenu: vi.fn(),
    generateTableSkeleton: () => 'skeleton', escapeHtml: (s: string) => s,
    detectStreamerStatusChanges: () => [], processStreamStatusNotifications: vi.fn(),
    streamerMatchesFavoriteCategoryFilters: (s: any) => s.game === 'selected',
    isFavoriteStreamer: (name: string) => name === 'favorite',
    sortTableData: vi.fn(() => []), tableSort: {}, lastUpdatePointsSnapshot: {},
    lastDataUpdate: { stats: 123 }, updateStaleDataIndicator: vi.fn(),
    streamStatusTrackingReady: false, previousStreamerStatus: {},
    persistFavoriteCategoryFilterIds: vi.fn(), safeSetLocalStorage: vi.fn(),
    renderFavoriteCategoriesTable: vi.fn(), updateToggleOfflineText: vi.fn(),
  });
  runInContext(`let showOffline = true;` + source.slice(source.indexOf("let streamerSearchQuery = ''"), source.indexOf('let updateIntervalMs')), context);
  runInContext(source.slice(source.indexOf('async function updateStatistics('), source.indexOf('// Timestamp последнего обновления данных')), context);
  return { context, element, run: (code: string) => runInContext(code, context) };
}

describe('streamer toolbar and loading state', () => {
  it('combines search, selected category and visibility while retaining offline favorites', async () => {
    const h = harness();
    h.context.cachedStatisticsRows = [
      { streamerName: 'favorite', status: 'OFFLINE', game: 'selected' },
      { streamerName: 'other', status: 'OFFLINE', game: 'selected' },
      { streamerName: 'unrelated', status: 'ONLINE', game: 'other' },
    ];
    h.run("showOffline = false; streamerSearchQuery = ' FAV '; selectedFavoriteCategoryFilterIds.add('cat')");
    await h.run('updateStatistics({skipFetch:true})');
    expect(h.context.sortTableData.mock.calls[0][0].map((s: any) => s.streamerName)).toEqual(['favorite']);
    expect(h.element('streamerFilterSummary').textContent).toBe('1/3');
    expect(h.context.fetchData).not.toHaveBeenCalled();
  });

  it('retains cached rows and marks them stale on failure, then clears error after retry', async () => {
    const h = harness();
    h.context.cachedStatisticsRows = [{ streamerName: 'a', status: 'ONLINE' }];
    h.context.fetchData.mockResolvedValue(null);
    await h.run('updateStatistics()');
    expect(h.context.cachedStatisticsRows).toHaveLength(1);
    expect(h.element('streamerLoadStatus').textContent).toBe('filters.stale');
    expect(h.element('retryStreamerLoad').hidden).toBe(false);
    expect(h.context.lastDataUpdate.stats).toBe(123);
    h.context.fetchData.mockResolvedValue([]);
    await h.run('updateStatistics()');
    expect(h.element('retryStreamerLoad').hidden).toBe(true);
    expect(h.element('watchesTable').innerHTML).toContain('table.noStreamers');
  });

  it('distinguishes first-load error from an empty list and ignores obsolete responses', async () => {
    const h = harness();
    let finishOld: any;
    h.context.fetchData.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const first = h.run('updateStatistics()');
    expect(h.element('streamerLoadStatus').textContent).toBe('filters.loading');
    h.context.fetchData.mockResolvedValue(null);
    await h.run('updateStatistics()');
    expect(h.element('streamerLoadStatus').textContent).toBe('table.loadFailed');
    finishOld([]);
    await first;
    expect(h.run('statisticsLoadState')).toBe('error');
    expect(h.context.cachedStatisticsRows).toBeNull();
  });

  it('resets search, categories and visibility without removing favorites', () => {
    const h = harness();
    h.context.favoriteCategories = [{ id: 'cat', name: 'Category' }];
    h.run("streamerSearchQuery = 'test'; showOffline = false; selectedFavoriteCategoryFilterIds.add('cat'); resetStreamerFilters()");
    expect(h.run('streamerSearchQuery')).toBe('');
    expect(h.run('showOffline')).toBe(true);
    expect(h.context.selectedFavoriteCategoryFilterIds.size).toBe(0);
    expect(h.context.favoriteCategories).toHaveLength(1);
  });
});
