import { afterEach, describe, expect, it, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { createDashboardApiKeyMiddleware, getDashboardApiKey } from '../apiAuth';

function mockReq(path: string, headers: Record<string, string> = {}): Request {
  return {
    path,
    header: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? undefined,
  } as unknown as Request;
}

function mockRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res as Response;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res as Response;
  };
  return res as Response;
}

describe('apiAuth', () => {
  const originalKey = process.env.WEB_DASHBOARD_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.WEB_DASHBOARD_API_KEY;
    } else {
      process.env.WEB_DASHBOARD_API_KEY = originalKey;
    }
  });

  it('getDashboardApiKey returns null when unset', () => {
    delete process.env.WEB_DASHBOARD_API_KEY;
    expect(getDashboardApiKey()).toBeNull();
  });

  it('getDashboardApiKey returns trimmed key', () => {
    process.env.WEB_DASHBOARD_API_KEY = '  secret  ';
    expect(getDashboardApiKey()).toBe('secret');
  });

  it('allows public paths without key', () => {
    process.env.WEB_DASHBOARD_API_KEY = 'secret';
    const middleware = createDashboardApiKeyMiddleware();
    const next = vi.fn();
    middleware(mockReq('/api/server-info'), mockRes(), next as NextFunction);
    middleware(mockReq('/api/app-update-check'), mockRes(), next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it('rejects protected path without key', () => {
    process.env.WEB_DASHBOARD_API_KEY = 'secret';
    const middleware = createDashboardApiKeyMiddleware();
    const next = vi.fn();
    const res = mockRes();
    middleware(mockReq('/api/statistics'), res, next as NextFunction);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts X-API-Key on protected path', () => {
    process.env.WEB_DASHBOARD_API_KEY = 'secret';
    const middleware = createDashboardApiKeyMiddleware();
    const next = vi.fn();
    middleware(
      mockReq('/api/statistics', { 'x-api-key': 'secret' }),
      mockRes(),
      next as NextFunction
    );
    expect(next).toHaveBeenCalled();
  });
});
