import * as fs from 'fs';
import * as path from 'path';

export interface PendingCategoryDuration {
  id: string;
  username: string;
  category: string;
  durationMs: number;
}

/** Write-ahead queue. Never overwrite an unreadable journal with an empty queue. */
export class CategoryDurationJournal {
  constructor(private readonly filePath: string) {}

  load(): PendingCategoryDuration[] {
    if (!fs.existsSync(this.filePath)) return [];
    const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.segments)) {
      throw new Error('Unsupported category duration journal');
    }
    const ids = new Set<string>();
    for (const entry of data.segments) {
      if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
          typeof entry.username !== 'string' || !entry.username.trim() ||
          typeof entry.category !== 'string' || !entry.category.trim() ||
          !Number.isSafeInteger(entry.durationMs) || entry.durationMs <= 0) {
        throw new Error('Invalid category duration journal segment');
      }
      ids.add(entry.id);
    }
    return data.segments;
  }

  save(segments: PendingCategoryDuration[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'w');
      try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, segments }), 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) {
        try { fs.unlinkSync(temporary); } catch { /* Keep the original journal intact. */ }
      }
    }
  }
}
