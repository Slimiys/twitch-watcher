declare module 'cheerio' {
  export interface Cheerio<T = any> extends ArrayLike<T> {
    [index: number]: T;
    length: number;
    attribs?: {
      [key: string]: string;
    };
    type?: string;
    name?: string;
    children?: Array<{
      data?: string;
    }>;
  }

  export function load(html: string): {
    (selector: string): Cheerio;
  };
}

