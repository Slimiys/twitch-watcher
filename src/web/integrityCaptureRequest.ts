/**
 * Запрос Client-Integrity с дашборда (ожидание передачи от расширения Edge)
 */

/** Срок действия запроса (мс) */
const CAPTURE_REQUEST_TTL_MS = 5 * 60 * 1000;

let captureRequestedAt: number | null = null;

/**
 * Регистрирует запрос на передачу integrity от браузерного расширения
 */
export function requestIntegrityCaptureFromBridge(now = Date.now()): { requestedAt: number } {
  captureRequestedAt = now;
  return { requestedAt: now };
}

/**
 * Снимок состояния запроса для API status
 */
export function getIntegrityCaptureRequestSnapshot(now = Date.now()): {
  captureRequestedAt: number | null;
  captureRequestPending: boolean;
} {
  if (captureRequestedAt != null && now - captureRequestedAt > CAPTURE_REQUEST_TTL_MS) {
    captureRequestedAt = null;
  }
  return {
    captureRequestedAt,
    captureRequestPending: captureRequestedAt != null,
  };
}

/**
 * Сбрасывает активный запрос после успешного применения токена
 */
export function clearIntegrityCaptureRequest(): void {
  captureRequestedAt = null;
}

/**
 * Сброс состояния (тесты)
 */
export function resetIntegrityCaptureRequestForTests(): void {
  captureRequestedAt = null;
}
