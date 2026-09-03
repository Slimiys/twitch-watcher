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
 * Читает API-ключ из заголовков или query (?apiKey=) для EventSource
 */
export function readDashboardRequestApiKey(req: Request): string | null {
  const headerKey =
    req.header('x-api-key') ||
    (req.header('authorization')?.startsWith('Bearer ')
      ? req.header('authorization')!.slice('Bearer '.length).trim()
      : null);

  if (headerKey) {
    return headerKey;
  }

  const queryKey = req.query?.apiKey;
  if (typeof queryKey === 'string' && queryKey.trim()) {
    return queryKey.trim();
  }

  return null;
}

/**
 * Middleware: требует X-API-Key, Authorization: Bearer или ?apiKey=, если ключ задан в env
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

    const requestKey = readDashboardRequestApiKey(req);
    if (requestKey === configuredKey) {
      next();
      return;
    }

    res.status(401).json({
      error: 'Unauthorized',
      message:
        'Invalid or missing API key. Set X-API-Key header, Authorization: Bearer, or apiKey query param.',
    });
  };
}
