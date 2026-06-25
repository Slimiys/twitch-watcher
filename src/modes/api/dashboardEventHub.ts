/**
 * Шина событий бота для push-обновлений dashboard (SSE)
 */

export interface DashboardHubEvent {
  timestamp: number;
  type: string;
  streamer: string;
  message: string;
}

type DashboardHubListener = (event: DashboardHubEvent) => void;

const listeners = new Set<DashboardHubListener>();

/**
 * Публикует событие для подписчиков SSE
 */
export function publishDashboardHubEvent(event: DashboardHubEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // не прерываем остальных подписчиков
    }
  }
}

/**
 * Подписка на события (возвращает отписку)
 */
export function subscribeDashboardHubEvents(listener: DashboardHubListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Сброс подписчиков (тесты)
 */
export function resetDashboardHubForTests(): void {
  listeners.clear();
}
