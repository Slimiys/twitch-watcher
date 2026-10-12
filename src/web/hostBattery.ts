import { spawn } from 'child_process';

export type BatteryState = 'charging' | 'discharging' | 'full' | 'not_charging' | 'unknown';
export type BatterySnapshot = { available: true; percentage: number; state: BatteryState; checkedAt: number }
  | { available: false; reason: 'unsupported' | 'api_missing' | 'api_unavailable' | 'invalid_response'; checkedAt: number };

export function isTermuxHost(platform = process.platform, env = process.env): boolean {
  return platform === 'android' || (platform === 'linux' &&
    Boolean(env.TERMUX_VERSION || /\/com\.termux\/files\//.test(env.PREFIX || '')));
}

export function parseBatteryStatus(raw: string, checkedAt: number): BatterySnapshot {
  try {
    const data = JSON.parse(raw);
    let percentage = data?.percentage;
    // Older API versions may expose only level and scale. Never coerce null to 0%.
    if (percentage == null && typeof data?.level === 'number' && typeof data?.scale === 'number' && data.scale > 0) {
      percentage = data.level / data.scale * 100;
    }
    if (typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      throw new Error('Invalid battery percentage');
    }
    const states: Record<string, BatteryState> = {
      CHARGING: 'charging', DISCHARGING: 'discharging', FULL: 'full', NOT_CHARGING: 'not_charging',
    };
    const state = Object.prototype.hasOwnProperty.call(states, data.status) ? states[data.status] : 'unknown';
    return { available: true, percentage: Math.round(percentage), state, checkedAt };
  } catch {
    return { available: false, reason: 'invalid_response', checkedAt };
  }
}

/** Fixed command, no shell interpolation. Kill the process group to avoid orphan API helpers. */
export function runBatteryCommand(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('termux-battery-status', [], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let size = 0;
    let finished = false;
    const stop = () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) { stop(); reject(error); } else resolve(output);
    };
    const timer = setTimeout(() => finish(new Error('Battery API timeout')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 16 * 1024) finish(new Error('Battery API output too large'));
      else output += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024) finish(new Error('Battery API output too large'));
    });
    child.on('error', finish);
    child.on('close', (code) => finish(code === 0 ? undefined : new Error('Battery API failed')));
  });
}

export function createBatteryReader(
  supported = isTermuxHost(), run: () => Promise<string> = runBatteryCommand, now: () => number = Date.now
): () => Promise<BatterySnapshot> {
  let cached: BatterySnapshot | undefined;
  let inFlight: Promise<BatterySnapshot> | undefined;
  return () => {
    if (cached && now() - cached.checkedAt < 60_000) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    inFlight = (async (): Promise<BatterySnapshot> => {
      if (!supported) return { available: false, reason: 'unsupported', checkedAt: now() };
      try { return parseBatteryStatus(await run(), now()); }
      catch (error) {
        return { available: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'api_missing' : 'api_unavailable', checkedAt: now() };
      }
    })().then(result => { cached = result; return result; }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

export const readHostBattery = createBatteryReader();
