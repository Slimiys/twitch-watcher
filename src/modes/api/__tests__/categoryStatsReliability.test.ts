import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseStorage } from '../DatabaseStorage';
import { StreamWatcher } from '../StreamWatcher';
import { CategoryDurationJournal } from '../CategoryDurationJournal';
import { resetCategoryStreamStatsForApi } from '../../../web/categoryStreamStatsApi';

describe('category statistics persistence', () => {
  let dir: string;
  let storage: DatabaseStorage;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-category-reliability-'));
    storage = new DatabaseStorage({ dbPath: path.join(dir, 'stats.db'), autoBackup: false });
    await vi.waitFor(() => expect(storage.isReady()).toBe(true));
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rolls back both totals when the second SQL update fails', () => {
    (storage as any).db.exec(`CREATE TRIGGER fail_category_insert
      BEFORE INSERT ON streamer_category_stream_duration_totals
      BEGIN SELECT RAISE(ABORT, 'test write failure'); END;`);
    expect(storage.addCategoryStreamDuration('a', 'Path of Exile', 60_000)).toBe(false);
    expect(storage.getCategoryStreamDurationTotals()).toEqual([]);
    expect(storage.getAllStreamerCategoryStreamDurationRows()).toEqual([]);
    (storage as any).db.exec('DROP TRIGGER fail_category_insert');
    expect(storage.addCategoryStreamDuration('a', 'Path of Exile', 60_000)).toBe(true);
    expect(storage.getCategoryStreamDurationTotals()[0].durationMs).toBe(60_000);
  });

  it('persists ordered category transitions, including returns to an earlier game', async () => {
    expect(storage.recordCategoryChange('a', 'Path of Exile', 'Path of Exile 2', 100)).toBe(true);
    expect(storage.recordCategoryChange('a', 'Path of Exile 2', 'Path of Exile', 200)).toBe(true);
    expect(storage.getCategoryChanges(1)[0].toCategory).toBe('Path of Exile');
    storage.close();
    storage = new DatabaseStorage({ dbPath: path.join(dir, 'stats.db'), autoBackup: false });
    await vi.waitFor(() => expect(storage.isReady()).toBe(true));
    expect(storage.getCategoryChanges().map(row => row.observedAt)).toEqual([200, 100]);
    expect(storage.clearCategoryStreamDurationStats()).toBe(true);
    expect(storage.getCategoryChanges()).toHaveLength(2);
  });

  it('replays the journal after restart without double counting committed segments', async () => {
    const journalPath = path.join(dir, 'category-duration-pending.json');
    const journal = new CategoryDurationJournal(journalPath);
    const segment = { id: 'recovery-1', username: 'a', category: 'Path of Exile', durationMs: 60_000 };
    const unsaved = { ...segment, id: 'recovery-2' };
    journal.save([segment, unsaved]);
    expect(storage.addCategoryStreamDuration(segment.username, segment.category, segment.durationMs, segment.id)).toBe(true);
    // Simulate stopping after DB commit but before journal cleanup.
    storage.close();
    storage = new DatabaseStorage({ dbPath: path.join(dir, 'stats.db'), autoBackup: false });
    await vi.waitFor(() => expect(storage.isReady()).toBe(true));
    const recovered = new CategoryDurationJournal(journalPath).load();
    expect(recovered).toEqual([segment, unsaved]);
    for (const entry of recovered) {
      expect(storage.addCategoryStreamDuration(entry.username, entry.category, entry.durationMs, entry.id)).toBe(true);
    }
    expect(storage.getCategoryStreamDurationTotals()[0].durationMs).toBe(120_000);
    expect(storage.getAllStreamerCategoryStreamDurationRows()[0].durationMs).toBe(120_000);
    journal.save([]);
    expect(journal.load()).toEqual([]);
  });

  it('does not resurrect reset statistics when an old journal is replayed', () => {
    expect(storage.clearCategoryStreamDurationStats(['discarded'])).toBe(true);
    expect(storage.addCategoryStreamDuration('a', 'Old', 60_000, 'discarded')).toBe(true);
    expect(storage.getCategoryStreamDurationTotals()).toEqual([]);
    expect(storage.addCategoryStreamDuration('a', 'New', 60_000, 'new')).toBe(true);
    expect(storage.getCategoryStreamDurationTotals()[0].category).toBe('New');
  });

  it('preserves an unreadable journal and reports it instead of silently discarding it', () => {
    const journalPath = path.join(dir, 'pending.json');
    fs.writeFileSync(journalPath, '{broken');
    expect(() => new CategoryDurationJournal(journalPath).load()).toThrow();
    expect(fs.readFileSync(journalPath, 'utf8')).toBe('{broken');
  });

  it('preserves the previous file and memory on persistence failure; retries without double counting', () => {
    expect(storage.addCategoryStreamDuration('a', 'Path of Exile', 60_000)).toBe(true);
    const dbPath = path.join(dir, 'stats.db');
    const original = fs.readFileSync(dbPath);
    // Renaming a database file over a directory must fail on every supported platform.
    const blockedPath = path.join(dir, 'blocked');
    fs.mkdirSync(blockedPath);
    (storage as any).config.dbPath = blockedPath;
    expect(storage.addCategoryStreamDuration('a', 'Path of Exile', 60_000)).toBe(false);
    expect(storage.clearCategoryStreamDurationStats()).toBe(false);
    expect(storage.getCategoryStreamDurationTotals()[0].durationMs).toBe(60_000);
    expect(fs.readFileSync(dbPath)).toEqual(original);
    expect(fs.existsSync(`${blockedPath}.${process.pid}.tmp`)).toBe(false);
    (storage as any).config.dbPath = dbPath;
    expect(storage.addCategoryStreamDuration('a', 'Path of Exile', 60_000)).toBe(true);
    expect(storage.getCategoryStreamDurationTotals()[0].durationMs).toBe(120_000);
    expect(storage.getAllStreamerCategoryStreamDurationRows()[0].durationMs).toBe(120_000);
  });
});

describe('category duration retries', () => {
  function watcher() {
    // Test accounting without starting network clients, timers or the real database.
    const instance = Object.create(StreamWatcher.prototype) as any;
    instance.activeCategoryWatch = new Map([
      ['a', { category: 'Path of Exile', categoryId: '1', since: 1000 }],
    ]);
    instance.pendingCategoryDurations = [];
    instance.categoryDurationJournal = { save: vi.fn() };
    instance.databaseStorage = {
      isReady: () => true,
      addCategoryStreamDuration: vi.fn().mockReturnValue(false),
      clearCategoryStreamDurationStats: vi.fn().mockReturnValue(false),
    };
    return instance;
  }

  it('journals checkpoints while the database is unavailable and replays them once', () => {
    const w = watcher();
    w.checkpointCategoryDurationWatch('a', 2000);
    expect(w.activeCategoryWatch.get('a').since).toBe(2000);
    expect(w.pendingCategoryDurations).toHaveLength(1);
    expect(w.categoryDurationJournal.save).toHaveBeenCalled();
    w.databaseStorage.addCategoryStreamDuration.mockReturnValue(true);
    w.checkpointCategoryDurationWatch('a', 3000);
    expect(w.databaseStorage.addCategoryStreamDuration).toHaveBeenLastCalledWith('a', 'Path of Exile', 1000, expect.any(String));
    expect(w.pendingCategoryDurations).toHaveLength(0);
    expect(w.activeCategoryWatch.get('a').since).toBe(3000);
  });

  it('records only detected transitions, not repeated observations or initial category', () => {
    const w = watcher();
    w.activeCategoryWatch.clear();
    w.activeStreamSessionKeys = new Map([['a', 'session']]);
    w.databaseStorage.recordCategoryChange = vi.fn(() => true);
    const streamer = { username: 'a', isOnline: true, game: 'Path of Exile', gameId: '1' };
    w.syncCategoryDurationWithStreamerGame(streamer);
    w.syncCategoryDurationWithStreamerGame(streamer);
    expect(w.databaseStorage.recordCategoryChange).not.toHaveBeenCalled();
    w.syncCategoryDurationWithStreamerGame({ ...streamer, game: 'Path of Exile 2', gameId: '2' });
    expect(w.databaseStorage.recordCategoryChange).toHaveBeenCalledTimes(1);
    expect(w.databaseStorage.recordCategoryChange).toHaveBeenCalledWith('a', 'Path of Exile', 'Path of Exile 2', expect.any(Number));
  });

  it('retries a closed segment without extending it or changing its category', () => {
    const w = watcher();
    w.flushCategoryDurationWatch('a', 2000);
    expect(w.activeCategoryWatch.size).toBe(0);
    expect(w.pendingCategoryDurations).toEqual([{ id: expect.any(String), username: 'a', category: 'Path of Exile', durationMs: 1000 }]);
    w.activeCategoryWatch.set('a', { category: 'Path of Exile 2', categoryId: '2', since: 2000 });
    w.databaseStorage.addCategoryStreamDuration.mockReturnValue(true);
    w.checkpointCategoryDurationWatches(4000);
    expect(w.databaseStorage.addCategoryStreamDuration).toHaveBeenCalledWith('a', 'Path of Exile', 1000, expect.any(String));
    expect(w.databaseStorage.addCategoryStreamDuration).toHaveBeenLastCalledWith('a', 'Path of Exile 2', 2000, expect.any(String));
    expect(w.pendingCategoryDurations).toEqual([]);
  });

  it('reports reset failure and preserves active and pending intervals', () => {
    const w = watcher();
    w.pendingCategoryDurations.push({ id: 'b-segment', username: 'b', category: 'Other', durationMs: 1000 });
    expect(resetCategoryStreamStatsForApi(null, w).success).toBe(false);
    expect(w.activeCategoryWatch.get('a').since).toBe(1000);
    expect(w.pendingCategoryDurations).toHaveLength(1);
    w.databaseStorage.clearCategoryStreamDurationStats.mockReturnValue(true);
    expect(resetCategoryStreamStatsForApi(null, w).success).toBe(true);
    expect(w.activeCategoryWatch.get('a').since).toBeGreaterThan(1000);
    expect(w.pendingCategoryDurations).toEqual([]);
    expect(w.databaseStorage.clearCategoryStreamDurationStats).toHaveBeenLastCalledWith(['b-segment']);
  });

  it('keeps intervals in memory without applying them when the journal cannot be saved', () => {
    const w = watcher();
    w.categoryDurationJournal.save.mockImplementation(() => { throw new Error('disk full'); });
    w.checkpointCategoryDurationWatch('a', 2000);
    expect(w.databaseStorage.addCategoryStreamDuration).not.toHaveBeenCalled();
    expect(w.pendingCategoryDurations).toHaveLength(1);
    w.categoryDurationJournal.save.mockImplementation(() => {});
    w.databaseStorage.addCategoryStreamDuration.mockReturnValue(true);
    w.retryPendingCategoryDurations();
    expect(w.pendingCategoryDurations).toEqual([]);
  });
});
