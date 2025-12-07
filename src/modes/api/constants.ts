/**
 * Константы для API-режима
 */

/**
 * URL для GraphQL запросов Twitch
 */
export const GQL_URL = 'https://gql.twitch.tv/gql';

/**
 * Client ID для Twitch API
 */
export const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

/**
 * WebSocket URL для PubSub
 */
export const WEBSOCKET_URL = 'wss://pubsub-edge.twitch.tv/v1';

/**
 * GraphQL операции
 */
export const GQL_OPERATIONS = {
  /**
   * Получение информации о стриме
   */
  WithIsStreamLiveQuery: {
    operationName: 'WithIsStreamLiveQuery',
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '04e46329a6786ff3a81c01c50bfa5d725902507a0deb83b0edbf7abe7a3716ea',
      },
    },
  },

  /**
   * Информация о видео и стриме
   */
  VideoPlayerStreamInfoOverlayChannel: {
    operationName: 'VideoPlayerStreamInfoOverlayChannel',
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: 'a5f2e34d626a9f4f5c0204f910bab2194948a9502089be558bb6e779a9e1b3d2',
      },
    },
  },

  /**
   * Получение контекста баллов канала
   */
  ChannelPointsContext: {
    operationName: 'ChannelPointsContext',
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '9988086babc615a918a1e9a722ff41d98847acac822645209ac7379eecb27152',
      },
    },
  },

  /**
   * Получение бонусных баллов
   */
  ClaimCommunityPoints: {
    operationName: 'ClaimCommunityPoints',
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0',
      },
    },
  },

  /**
   * Получение информации о пользователе
   */
  ReportMenuItem: {
    operationName: 'ReportMenuItem',
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '8f3628981255345ca5e5453dfd844efffb01d6413a9931498836e6268692a30c',
      },
    },
  },

  /**
   * Присоединение к рейду
   */
  JoinRaid: {
    operationName: 'JoinRaid',
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: 'c6a332a86d1087fbbb1a8623aa01bd1313d2386e7c63be60fdb2d1901f01a4ae',
      },
    },
  },
} as const;

/**
 * WebSocket темы для подписки
 */
export const PUBSUB_TOPICS = {
  COMMUNITY_POINTS_USER: 'community-points-user-v1',
  VIDEO_PLAYBACK: 'video-playback-by-id',
  RAID: 'raid',
} as const;

/**
 * Причины начисления баллов
 */
export const POINT_REASONS = {
  WATCH: 'WATCH',
  WATCH_STREAK: 'WATCH_STREAK',
  CLAIM: 'CLAIM',
  RAID: 'RAID',
  PREDICTION: 'PREDICTION',
} as const;

