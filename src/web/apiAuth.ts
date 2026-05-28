/**
 * Защита REST API dashboard по API-ключу
 */

import { Request, Response, NextFunction } from 'express';

/** Публичные эндпоинты без ключа (статус загрузки страницы) */
const PUBLIC_API_PATHS = new Set([
  '/api/server-info',
  '/api/initialization-status',
  '/api/app-update-check',
  '/api/overall',
  '/api/integrity/capture/status',
]);

/**
 * Возвращает настроенный API-ключ или null, если защита отключена
 */
export function getDashboardApiKey(): string | null {
  const key = process.env.WEB_DASHBOARD_API_KEY?.trim();
  return key || null;
}

/**
 * Middleware: требует X-API-Key или Authorization: Bearer, если ключ задан в env
 */
export function createDashboardApiKeyMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const configuredKey = getDashboardApiKey();
    if (!configuredKey) {
      next();
      return;
    }

    if (!req.path.startsWith('/api/') || PUBLIC_API_PATHS.has(req.path)) {
      next();
      return;
    }

    const headerKey =
      req.header('x-api-key') ||
      (req.header('authorization')?.startsWith('Bearer ')
        ? req.header('authorization')!.slice('Bearer '.length).trim()
        : null);

    if (headerKey === configuredKey) {
      next();
      return;
    }

    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or missing API key. Set X-API-Key header or Authorization: Bearer.',
    });
  };
}
