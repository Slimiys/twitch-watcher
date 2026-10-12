import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBatteryReader, isTermuxHost, parseBatteryStatus, runBatteryCommand } from '../hostBattery';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('host battery data', () => {
  it('detects Android/Termux without using the browser platform', () => {
    expect(isTermuxHost('android', {})).toBe(true);
    expect(isTermuxHost('linux', { PREFIX: '/data/data/com.termux/files/usr' })).toBe(true);
    expect(isTermuxHost('linux', { TERMUX_VERSION: '1' })).toBe(true);
    expect(isTermuxHost('linux', {})).toBe(false);
    expect(isTermuxHost('win32', {})).toBe(false);
  });

  it.each([0, 20, 100])('accepts valid level %s including empty battery', percentage => {
    expect(parseBatteryStatus(JSON.stringify({ percentage, status: 'CHARGING' }), 123))
      .toEqual({ available: true, percentage, state: 'charging', checkedAt: 123 });
  });

  it('supports older level/scale output and distinguishes full from not charging', () => {
    expect(parseBatteryStatus('{"level":40,"scale":80,"status":"FULL"}', 1))
      .toMatchObject({ available: true, percentage: 50, state: 'full' });
    expect(parseBatteryStatus('{"percentage":80,"status":"NOT_CHARGING"}', 1))
      .toMatchObject({ state: 'not_charging' });
    expect(parseBatteryStatus('{"percentage":80,"status":"__proto__"}', 1))
      .toMatchObject({ state: 'unknown' });
  });

  it.each(['bad json', '{}', '{"percentage":null}', '{"percentage":"80"}', '{"percentage":101}', '{"percentage":-1}', '{"level":2,"scale":0}'])('rejects invalid data %s', raw => {
    expect(parseBatteryStatus(raw, 1)).toEqual({ available: false, reason: 'invalid_response', checkedAt: 1 });
  });

  it('does not spawn on unsupported hosts', async () => {
    const run = vi.fn();
    expect(await createBatteryReader(false, run)()).toMatchObject({ reason: 'unsupported' });
    expect(run).not.toHaveBeenCalled();
  });

  it('shares concurrent requests and caches success and errors for one minute', async () => {
    let time = 100;
    let complete!: (data: string) => void;
    const run = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
    const read = createBatteryReader(true, run, () => time);
    const first = read();
    const second = read();
    expect(run).toHaveBeenCalledTimes(1);
    complete('{"percentage":55,"status":"DISCHARGING"}');
    expect(await first).toEqual(await second);
    await read();
    expect(run).toHaveBeenCalledTimes(1);
    time += 60_000;
    run.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect(await read()).toMatchObject({ available: false, reason: 'api_missing' });
    await read();
    expect(run).toHaveBeenCalledTimes(2);
    time += 60_000;
    run.mockRejectedValueOnce(new Error('timeout'));
    expect(await read()).toMatchObject({ available: false, reason: 'api_unavailable' });
  });
});

describe('battery command limits', () => {
  function child() {
    const fake = Object.assign(new EventEmitter(), {
      pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(fake as any);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    return fake;
  }

  it('reads a fixed command without a shell', async () => {
    const fake = child();
    const promise = runBatteryCommand();
    fake.stdout.write('{"percentage":30}');
    fake.emit('close', 0);
    expect(await promise).toBe('{"percentage":30}');
    expect(spawn).toHaveBeenCalledWith('termux-battery-status', [], expect.objectContaining({ detached: true }));
  });

  it('terminates the helper process group on timeout', async () => {
    vi.useFakeTimers();
    child();
    const result = expect(runBatteryCommand()).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
  });

  it('limits output size', async () => {
    const fake = child();
    const result = expect(runBatteryCommand()).rejects.toThrow('too large');
    fake.stdout.write('a'.repeat(17 * 1024));
    await result;
    expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
  });
});
