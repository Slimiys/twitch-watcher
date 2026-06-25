import { describe, it, expect, afterEach } from 'vitest';
import {
  publishDashboardHubEvent,
  subscribeDashboardHubEvents,
  resetDashboardHubForTests,
} from '../dashboardEventHub';

describe('dashboardEventHub', () => {
  afterEach(() => {
    resetDashboardHubForTests();
  });

  it('доставляет событие подписчикам', () => {
    const received: string[] = [];
    subscribeDashboardHubEvents((e) => {
      received.push(e.type);
    });

    publishDashboardHubEvent({
      timestamp: Date.now(),
      type: 'stream-up',
      streamer: 'alice',
      message: 'online',
    });

    expect(received).toEqual(['stream-up']);
  });

  it('отписка прекращает доставку', () => {
    const received: string[] = [];
    const unsubscribe = subscribeDashboardHubEvents((e) => {
      received.push(e.type);
    });
    unsubscribe();

    publishDashboardHubEvent({
      timestamp: Date.now(),
      type: 'stream-down',
      streamer: 'bob',
      message: 'offline',
    });

    expect(received).toHaveLength(0);
  });
});
