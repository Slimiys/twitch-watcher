/**
 * Декларация типов для sql.js
 */

declare module 'sql.js' {
  export interface Database {
    /**
     * Выполняет SQL запрос без параметров
     */
    exec(sql: string): QueryExecResult[];

    /**
     * Подготавливает SQL запрос
     */
    prepare(sql: string): Statement;

    /**
     * Экспортирует базу данных в бинарный формат
     */
    export(): Uint8Array;

    /**
     * Закрывает соединение с базой данных
     */
    close(): void;
  }

  export interface Statement {
    /**
     * Привязывает параметры к запросу
     */
    bind(values: any[]): void;

    /**
     * Выполняет один шаг запроса
     */
    step(): boolean;

    /**
     * Получает результат как объект
     */
    getAsObject(): any;

    /**
     * Освобождает ресурсы statement
     */
    free(): void;
  }

  export interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  export interface InitSqlJsStatic {
    (config?: {
      locateFile?: (file: string) => string;
    }): Promise<SqlJsStatic>;
  }

  export interface SqlJsStatic {
    Database: {
      new (data?: Uint8Array): Database;
    };
  }

  const initSqlJs: InitSqlJsStatic;
  export default initSqlJs;
}

