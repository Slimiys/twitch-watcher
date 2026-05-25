/**
 * Чёрный список claimId после неудачного ClaimCommunityPoints
 */

/**
 * Хранит claimId, которые не нужно опрашивать повторно до истечения TTL
 */
export class ClaimIdBlocklist {
  private failedAt = new Map<string, number>();

  /**
   * @param blockMs 0 — блок до clear(); иначе TTL в миллисекундах
   */
  constructor(private blockMs: number) {}

  /**
   * Заблокирован ли claimId
   */
  isBlocked(claimId: string, now = Date.now()): boolean {
    const failedAt = this.failedAt.get(claimId);
    if (failedAt == null) {
      return false;
    }
    if (this.blockMs > 0 && now - failedAt >= this.blockMs) {
      this.failedAt.delete(claimId);
      return false;
    }
    return true;
  }

  /**
   * Помечает claimId как неудачный (постоянная ошибка: FORBIDDEN, уже собран и т.п.)
   */
  markPermanent(...claimIds: string[]): void {
    this.markFailed(...claimIds);
  }

  /**
   * @deprecated Используйте markPermanent — integrity-ошибки не блокируют claimId
   */
  markFailed(...claimIds: string[]): void {
    const now = Date.now();
    for (const claimId of claimIds) {
      if (claimId) {
        this.failedAt.set(claimId, now);
      }
    }
  }

  /**
   * Снимает блокировку после успешного claim
   */
  clear(claimId: string): void {
    this.failedAt.delete(claimId);
  }

  /**
   * Удаляет устаревшие записи
   */
  prune(now = Date.now()): void {
    if (this.blockMs <= 0) {
      return;
    }
    for (const [claimId, failedAt] of this.failedAt.entries()) {
      if (now - failedAt >= this.blockMs) {
        this.failedAt.delete(claimId);
      }
    }
  }
}
