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
});
