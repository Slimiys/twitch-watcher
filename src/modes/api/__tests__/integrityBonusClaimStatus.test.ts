import { describe, it, expect } from 'vitest';
import {
  deriveIntegrityBonusClaimStatus,
  resolveLastIntegrityUpdatedAt,
} from '../integrityBonusClaimStatus';

describe('integrityBonusClaimStatus', () => {
  it('resolveLastIntegrityUpdatedAt предпочитает capture', () => {
    const r = resolveLastIntegrityUpdatedAt(5000, Date.now() + 3_600_000, 10_000);
    expect(r).toEqual({ atMs: 5000, estimated: false });
  });

  it('resolveLastIntegrityUpdatedAt оценивает по expires', () => {
    const now = 10 * 60 * 60 * 1000;
    const expires = now + 5 * 60 * 60 * 1000;
    const r = resolveLastIntegrityUpdatedAt(0, expires, now);
    expect(r.estimated).toBe(true);
    expect(r.atMs).toBe(expires - 4 * 60 * 60 * 1000);
  });

  it('deriveIntegrityBonusClaimStatus: нет токена', () => {
    const s = deriveIntegrityBonusClaimStatus({ configured: false, valid: false }, [], null);
    expect(s.status).toBe('token_invalid');
  });

  it('deriveIntegrityBonusClaimStatus: успешный claim', () => {
    const s = deriveIntegrityBonusClaimStatus(
      { configured: true, valid: true },
      [{ streamer: 'x', outcome: 'success', timestamp: 100, message: 'ok' }],
      null
    );
    expect(s.status).toBe('ok');
  });

  it('deriveIntegrityBonusClaimStatus: integrity после успеха', () => {
    const s = deriveIntegrityBonusClaimStatus(
      { configured: true, valid: true },
      [
        { streamer: 'b', outcome: 'failed', failureKind: 'integrity', timestamp: 200, message: 'fail' },
        { streamer: 'a', outcome: 'success', timestamp: 100, message: 'ok' },
      ],
      { timestamp: 200, streamer: 'b' }
    );
    expect(s.status).toBe('integrity_blocked');
  });
});
