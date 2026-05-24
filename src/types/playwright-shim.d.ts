/**
 * Минимальные типы для опциональной зависимости playwright
 */
declare module 'playwright' {
  export interface Browser {
    close(): Promise<void>;
    newContext(options?: Record<string, unknown>): Promise<BrowserContext>;
  }

  export interface BrowserContext {
    addCookies(cookies: Record<string, unknown>[]): Promise<void>;
    newPage(): Promise<Page>;
  }

  export interface Page {
    goto(url: string, options?: Record<string, unknown>): Promise<void>;
    waitForTimeout(ms: number): Promise<void>;
    evaluate<T, A>(pageFunction: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  }

  export const chromium: {
    launch(options?: Record<string, unknown>): Promise<Browser>;
  };
}
