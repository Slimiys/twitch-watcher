declare module 'puppeteer-core' {
  export interface Browser {
    newPage(): Promise<Page>;
    pages(): Promise<Page[]>;
    process(): { pid?: number } | null;
    close(): Promise<void>;
  }

  export interface Page {
    goto(url: string, options?: { waitUntil?: string }): Promise<void>;
    setUserAgent(userAgent: string): Promise<void>;
    setCookie(...cookies: Cookie[]): Promise<void>;
    cookies(): Promise<Cookie[]>;
    setDefaultNavigationTimeout(timeout: number): void;
    setDefaultTimeout(timeout: number): void;
    setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
    click(selector: string): Promise<void>;
    waitForSelector(selector: string): Promise<void>;
    waitFor(timeout: number): Promise<void>;
    close(): Promise<void>;
    keyboard: {
      press(key: string): Promise<void>;
    };
    evaluate<T = any>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
    screenshot(options: { path: string }): Promise<Buffer | string>;
  }

  export interface Cookie {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }

  export interface LaunchOptions {
    headless?: boolean;
    args?: string[];
    executablePath?: string;
  }

  export function launch(options?: LaunchOptions): Promise<Browser>;
}

