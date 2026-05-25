/**
 * Тесты для WebSocketManager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketManager } from '../WebSocketManager';
import { StreamerInfo } from '../types';

// Мокаем ws модуль - создаем класс внутри factory функции
vi.mock('ws', () => {
  class MockWebSocket {
    readyState = 0;
    onopen: ((event: any) => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onclose: ((event: any) => void) | null = null;
    send = vi.fn();
    close = vi.fn();

    constructor(public url: string) {}

    // Методы для тестирования
    simulateOpen() {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }

    simulateMessage(data: any) {
      if (this.onmessage) {
        this.onmessage({ data: JSON.stringify(data) });
      }
    }

    simulateClose() {
      this.readyState = 3;
      if (this.onclose) this.onclose({});
    }
  }

  return {
    default: MockWebSocket,
    WebSocket: MockWebSocket,
  };
});

// Мокаем logger
vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    important: vi.fn(),
  },
}));

vi.mock('../GraphQLClient', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({
    getStreamInfo: vi.fn(),
    getChannelPoints: vi.fn(),
    claimBonus: vi.fn(),
  })),
}));

vi.mock('../configLoader', () => ({
  loadRetryConfig: vi.fn(() => ({
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 1000,
    multiplier: 2,
    jitter: true,
    websocket: {
      maxReconnectAttempts: 10,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
    },
  })),
}));

describe('WebSocketManager', () => {
  let manager: WebSocketManager;
  let mockEventHandlers: {
    onPointsEarned: ReturnType<typeof vi.fn>;
    onClaimAvailable: ReturnType<typeof vi.fn>;
    onStreamUp: ReturnType<typeof vi.fn>;
    onStreamDown: ReturnType<typeof vi.fn>;
  };
  const mockGraphQLClient = {
    getChannelPoints: vi.fn(),
    claimBonus: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    const eventHandlers = {
      onPointsEarned: vi.fn(),
      onClaimAvailable: vi.fn(),
      onStreamUp: vi.fn(),
      onStreamDown: vi.fn(),
    };
    mockEventHandlers = eventHandlers;
    
    manager = new WebSocketManager(
      'test_token',
      'test_user_id',
      mockGraphQLClient as any,
      eventHandlers
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isConnected', () => {
    it('должен вернуть false если соединение не установлено', () => {
      expect(manager.isConnected()).toBe(false);
    });
  });

  describe('handleCommunityPointsMessage', () => {
    it('должен обработать сообщение о начислении баллов', () => {
      // Добавляем стримера в менеджер для теста
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1000,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: 1000,
        lastChannelPoints: 1000,
        streamPointsEarned: 0,
      };
      
      (manager as any).streamers.set('123', streamerInfo);

      const message = {
        type: 'points-earned',
        data: {
          balance: {
            balance: 1500,
            channel_id: '123',
          },
          point_gain: {
            total_points: 500,
            reason_code: 'WATCH',
          },
        },
      };

      (manager as any).handleCommunityPointsMessage(message);

      expect(streamerInfo.channelPoints).toBe(1500);
    });

    it('должен правильно установить initialChannelPoints вычитая earned при первом событии', () => {
      // Стример без установленных начальных баллов
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 0,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: null, // Не установлен
        lastChannelPoints: null,
        streamPointsEarned: 0,
      };
      
      (manager as any).streamers.set('123', streamerInfo);

      // Первое событие: баланс = 1950, earned = 10
      const message = {
        type: 'points-earned',
        data: {
          balance: {
            balance: 1950,
            channel_id: '123',
          },
          point_gain: {
            total_points: 10,
            reason_code: 'WATCH',
          },
        },
      };

      (manager as any).handleCommunityPointsMessage(message);

      // Проверяем, что initialChannelPoints установлен правильно (1950 - 10 = 1940)
      expect(streamerInfo.initialChannelPoints).toBe(1940);
      expect(streamerInfo.channelPoints).toBe(1950);
      expect(streamerInfo.lastChannelPoints).toBe(1950);
    });

    it('должен установить initialChannelPoints равным балансу если earned = 0', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 0,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: null,
        lastChannelPoints: null,
        streamPointsEarned: 0,
      };
      
      (manager as any).streamers.set('123', streamerInfo);

      // Событие без начисления баллов (earned = 0)
      const message = {
        type: 'points-earned',
        data: {
          balance: {
            balance: 1000,
            channel_id: '123',
          },
          point_gain: {
            total_points: 0,
            reason_code: 'WATCH',
          },
        },
      };

      (manager as any).handleCommunityPointsMessage(message);

      // Если earned = 0, initialChannelPoints должен быть равен балансу
      expect(streamerInfo.initialChannelPoints).toBe(1000);
      expect(streamerInfo.channelPoints).toBe(1000);
    });
  });

  describe('handleCommunityPointsMessage - claim-available', () => {
    it('должен вызвать onClaimAvailable только для стримера с channel_id из события', () => {
      const targetStreamer: StreamerInfo = {
        username: 'exmagistr',
        channelId: '40459081',
        channelPoints: 1000,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: 1000,
        lastChannelPoints: 1000,
        streamPointsEarned: 0,
      };
      const otherStreamer: StreamerInfo = {
        ...targetStreamer,
        username: 'alena4p',
        channelId: '72717097',
      };

      (manager as any).streamers.set('40459081', targetStreamer);
      (manager as any).streamers.set('72717097', otherStreamer);

      const message = {
        type: 'claim-available',
        data: {
          claim: {
            id: '15068382-f366-4a77-8648-ec1b08d208db',
            channel_id: '40459081',
          },
        },
      };

      (manager as any).handleCommunityPointsMessage(message);

      expect(mockEventHandlers.onClaimAvailable).toHaveBeenCalledTimes(1);
      expect(mockEventHandlers.onClaimAvailable).toHaveBeenCalledWith(
        targetStreamer,
        '15068382-f366-4a77-8648-ec1b08d208db'
      );
    });
  });

  describe('handleVideoPlaybackMessage', () => {
    it('должен обработать событие stream-up', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1000,
        isOnline: false,
        broadcastId: null,
        game: null,
        title: null,
        tags: [],
        spadeUrl: null,
        startTime: 0,
        initialChannelPoints: null,
        lastChannelPoints: null,
        streamPointsEarned: 0,
      };
      
      (manager as any).streamers.set('123', streamerInfo);

      const message = {
        type: 'stream-up',
        data: {},
      };

      (manager as any).handleVideoPlaybackMessage('123', message);

      expect(streamerInfo.isOnline).toBe(true);
      expect(streamerInfo.startTime).toBeGreaterThan(0);
    });

    it('stream-up выставляет startTime если стример уже был онлайн', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1000,
        isOnline: true,
        broadcastId: 'bc1',
        game: null,
        title: null,
        tags: [],
        spadeUrl: null,
        startTime: 0,
        initialChannelPoints: null,
        lastChannelPoints: null,
        streamPointsEarned: 0,
      };

      (manager as any).streamers.set('123', streamerInfo);

      (manager as any).handleVideoPlaybackMessage('123', { type: 'stream-up', data: {} });

      expect(streamerInfo.isOnline).toBe(true);
      expect(streamerInfo.startTime).toBeGreaterThan(0);
    });

    it('должен обработать событие stream-down', () => {
      const streamerInfo: StreamerInfo = {
        username: 'testuser',
        channelId: '123',
        channelPoints: 1000,
        isOnline: true,
        broadcastId: '456',
        game: 'Test Game',
        title: 'Test Title',
        tags: [],
        spadeUrl: null,
        startTime: Date.now(),
        initialChannelPoints: 1000,
        lastChannelPoints: 1000,
        streamPointsEarned: 0,
      };
      
      (manager as any).streamers.set('123', streamerInfo);

      const message = {
        type: 'stream-down',
        data: {},
      };

      (manager as any).handleVideoPlaybackMessage('123', message);

      expect(streamerInfo.isOnline).toBe(false);
      expect(streamerInfo.startTime).toBe(0);
    });
  });
});

