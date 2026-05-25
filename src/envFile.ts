/**
 * Чтение и точечное обновление ключей в .env
 */

import * as fs from 'fs';

const ENV_KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Обновляет или добавляет ключи в .env, не трогая остальные строки
 * @param filePath Путь к .env
 * @param updates Ключ → значение
 */
export function upsertEnvFileKeys(filePath: string, updates: Record<string, string>): void {
  const keys = new Set(Object.keys(updates));
  let lines: string[] = [];

  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    lines = raw.split(/\r?\n/);
  }

  const written = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const match = line.match(ENV_KEY_PATTERN);
    if (match && keys.has(match[1])) {
      result.push(`${match[1]}=${updates[match[1]]}`);
      written.add(match[1]);
    } else {
      result.push(line);
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key)) {
      result.push(`${key}=${value}`);
    }
  }

  const body = result.join('\n');
  fs.writeFileSync(filePath, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
}
