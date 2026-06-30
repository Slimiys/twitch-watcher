/**
 * Тесты учёта сессий стримов в DatabaseStorage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseStorage, STREAM_COUNT_WINDOW_MS } from '../DatabaseStorage';

async function waitForDatabase(storage: DatabaseStorage, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!storage.isReady()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('DatabaseStorage did not become ready in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('DatabaseStorage stream sessions', () => {
  let tempDir: string;
  let dbPath: string;
  let storage: DatabaseStorage;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-stream-sessions-'));
    dbPath = path.join(tempDir, 'database.db');
    storage = new DatabaseStorage({ dbPath, autoSave: true });
  });

  afterEach(() => {
    storage.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('создаёт новую сессию при том же broadcast id, но другом started_at', async () => {
    await waitForDatabase(storage);

    const firstStart = Date.now() - 24 * 60 * 60 * 1000;
    const secondStart = Date.now();
    expect(storage.recordStreamSession('stale_bc_user', firstStart, 'same-broadcast')).toBe(
      true
    );
    expect(
      storage.recordStreamSession('stale_bc_user', secondStart, 'same-broadcast')
    ).toBe(true);
    expect(storage.getStreamCountLast30Days('stale_bc_user')).toBe(2);
  });

  it('объединяет ts: и broadcast id для одного времени старта', async () => {
    await waitForDatabase(storage);

    const startedAt = Date.now();
    expect(storage.recordStreamSession('alias_user', startedAt, null)).toBe(true);
    expect(storage.recordStreamSession('alias_user', startedAt, 'broadcast-merge')).toBe(
      true
    );
    expect(storage.getStreamCountLast30Days('alias_user')).toBe(1);

    const starts =
      storage.getStreamSessionStartsByUsernameByWindows().get('alias_user')?.d30 ?? [];
    expect(starts.filter((t) => t === startedAt)).toHaveLength(1);
  });

  it('дедуплицирует сессию по broadcast id', async () => {
    await waitForDatabase(storage);

    const startedAt = Date.now();
    expect(storage.recordStreamSession('streamer_a', startedAt, 'broadcast-1')).toBe(true);
    expect(storage.recordStreamSession('streamer_a', startedAt + 1000, 'broadcast-1')).toBe(
      false
    );
    expect(storage.getStreamCountLast30Days('streamer_a')).toBe(1);
  });

  it('считает несколько сессий за 30 суток', async () => {
    await waitForDatabase(storage);

    const now = Date.now();
    expect(storage.recordStreamSession('streamer_b', now - 5 * 24 * 60 * 60 * 1000, 'b1')).toBe(
      true
    );
    expect(storage.recordStreamSession('streamer_b', now - 2 * 24 * 60 * 60 * 1000, 'b2')).toBe(
      true
    );
    expect(storage.getStreamCountLast30Days('streamer_b')).toBe(2);
  });

  it('не учитывает сессии старше 30 суток', async () => {
    await waitForDatabase(storage);

    const now = Date.now();
    const oldStart = now - STREAM_COUNT_WINDOW_MS - 60_000;
    expect(storage.recordStreamSession('streamer_c', oldStart, 'old-broadcast')).toBe(true);
    expect(storage.getStreamCountLast30Days('streamer_c')).toBe(0);
  });

  it('возвращает карту counts по username', async () => {
    await waitForDatabase(storage);

    const now = Date.now();
    storage.recordStreamSession('Alpha', now, 'a1');
    storage.recordStreamSession('beta', now, 'b1');

    const map = storage.getStreamCountsLast30DaysByUsername();
    expect(map.get('alpha')).toBe(1);
    expect(map.get('beta')).toBe(1);
  });

  it('считает стримы по окнам 7/14/30/60 суток', async () => {
    await waitForDatabase(storage);

    const now = Date.now();
    storage.recordStreamSession('window_user', now - 5 * 24 * 60 * 60 * 1000, 'w1');
    storage.recordStreamSession('window_user', now - 10 * 24 * 60 * 60 * 1000, 'w2');
    storage.recordStreamSession('window_user', now - 20 * 24 * 60 * 60 * 1000, 'w3');
    storage.recordStreamSession('window_user', now - 45 * 24 * 60 * 60 * 1000, 'w4');

    const windows = storage.getStreamCountsByUsernameByWindows().get('window_user');
    expect(windows).toEqual({ d7: 1, d14: 2, d30: 3, d60: 4 });

    expect(storage.getStreamCountsByUsername(7).get('window_user')).toBe(1);
    expect(storage.getStreamCountsByUsername(14).get('window_user')).toBe(2);
    expect(storage.getStreamCountsByUsername(60).get('window_user')).toBe(4);
  });

  it('учитывает категорию один раз за сессию стрима', async () => {
    await waitForDatabase(storage);

    const now = Date.now();
    const sessionKey = 'broadcast-categories';
    storage.recordStreamSession('cat_user', now, sessionKey);

    expect(
      storage.recordStreamSessionCategory('cat_user', sessionKey, 'Path of Exile')
    ).toBe(true);
    expect(
      storage.recordStreamSessionCategory('cat_user', sessionKey, 'Torchlight')
    ).toBe(true);
    expect(
      storage.recordStreamSessionCategory('cat_user', sessionKey, 'Path of Exile')
    ).toBe(false);

    const stats = storage.getCategoryStreamCountsByUsername().get('cat_user') ?? [];
    expect(stats).toEqual([
      { category: 'Path of Exile', streamCount: 1 },
      { category: 'Torchlight', streamCount: 1 },
    ]);
  });

  it('считает категории по разным стримам', async () => {
    await waitForDatabase(storage);

    const now = Date.now();
    storage.recordStreamSession('cat_user2', now - 1000, 'stream-1');
    storage.recordStreamSessionCategory('cat_user2', 'stream-1', 'Just Chatting');

    storage.recordStreamSession('cat_user2', now, 'stream-2');
    storage.recordStreamSessionCategory('cat_user2', 'stream-2', 'Just Chatting');
    storage.recordStreamSessionCategory('cat_user2', 'stream-2', 'Path of Exile');

    const stats = storage.getCategoryStreamCountsByUsername().get('cat_user2') ?? [];
    expect(stats).toEqual([
      { category: 'Just Chatting', streamCount: 2 },
      { category: 'Path of Exile', streamCount: 1 },
    ]);
  });

  it('возвращает даты начала стримов по окнам', async () => {
    await waitForDatabase(storage);

    const now = Date.now();
    const d5 = now - 5 * 24 * 60 * 60 * 1000;
    const d10 = now - 10 * 24 * 60 * 60 * 1000;
    const d45 = now - 45 * 24 * 60 * 60 * 1000;

    storage.recordStreamSession('dates_user', d5, 's1');
    storage.recordStreamSession('dates_user', d10, 's2');
    storage.recordStreamSession('dates_user', d45, 's3');

    const windows = storage.getStreamSessionStartsByUsernameByWindows().get('dates_user');
    expect(windows?.d7).toEqual([d5]);
    expect(windows?.d14).toEqual([d5, d10]);
    expect(windows?.d30).toEqual([d5, d10]);
    expect(windows?.d60).toEqual([d5, d10, d45]);
  });

  it('очищает ts:-дубликаты при dedupeStreamSessionTimestampAliases', async () => {
    await waitForDatabase(storage);

    const startedAt = Date.now();
    storage.recordStreamSession('dedupe_user', startedAt, null);
    storage.recordStreamSession('dedupe_user', startedAt, 'bc-dedupe');

    expect(storage.getStreamCountLast30Days('dedupe_user')).toBe(1);

    storage.recordStreamSession('dedupe_user2', startedAt + 1000, null);
    storage.dedupeStreamSessionTimestampAliases();
    expect(storage.getStreamCountLast30Days('dedupe_user2')).toBe(1);
  });

  it('суммирует длительность стримов по категориям', () => {
    expect(storage.addCategoryStreamDuration('Path of Exile', 6 * 60 * 60_000 + 53 * 60_000)).toBe(
      true
    );
    expect(storage.addCategoryStreamDuration('Path of Exile 2', 4 * 60 * 60_000 + 34 * 60_000)).toBe(
      true
    );
    expect(storage.addCategoryStreamDuration('Path of Exile', 60_000)).toBe(true);

    const totals = storage.getCategoryStreamDurationTotals();
    expect(totals).toHaveLength(2);
    expect(totals[0].category).toBe('Path of Exile');
    expect(totals[0].durationMs).toBe(6 * 60 * 60_000 + 54 * 60_000);
    expect(totals[1].category).toBe('Path of Exile 2');
    expect(totals[1].durationMs).toBe(4 * 60 * 60_000 + 34 * 60_000);
  });
});
