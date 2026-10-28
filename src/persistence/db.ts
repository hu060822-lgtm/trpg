import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * PostgreSQL access for the stores. Production uses Supabase through node-postgres; tests and local development use
 * PGlite (real Postgres compiled to WebAssembly), so both run the same SQL, triggers and transactions.
 *
 * `tx` is reentrant: a world command that opens a combat joins the outer transaction. The open transaction travels
 * with the async call chain, so concurrent requests in one process never share a connection by accident.
 */
export interface Conn {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  exec(text: string): Promise<void>;
  release(): void;
}

export interface Driver {
  connect(): Promise<Conn>;
  end(): Promise<void>;
}

export class Database {
  private als = new AsyncLocalStorage<Conn>();

  constructor(private driver: Driver) {}

  /** Rows of a query, on the current transaction when there is one. */
  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.use((c) => c.query(text, params))).rows as T[];
  }

  async one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(text, params))[0];
  }

  /** Number of rows a statement changed. */
  async run(text: string, params: unknown[] = []): Promise<number> {
    return (await this.use((c) => c.query(text, params))).rowCount;
  }

  async exec(text: string): Promise<void> {
    await this.use((c) => c.exec(text));
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn();
    const conn = await this.driver.connect();
    try {
      await conn.exec('BEGIN');
      try {
        const out = await this.als.run(conn, fn);
        await conn.exec('COMMIT');
        return out;
      } catch (e) {
        await conn.exec('ROLLBACK');
        throw e;
      }
    } finally {
      conn.release();
    }
  }

  /** Applies a schema. Several processes may start at once, so they take turns on an advisory lock. */
  async migrate(schema: string) {
    await this.tx(async () => {
      await this.query('SELECT pg_advisory_xact_lock(7316)');
      await this.exec(schema);
    });
  }

  async close() {
    await this.driver.end();
  }

  private async use<T>(fn: (c: Conn) => Promise<T>): Promise<T> {
    const current = this.als.getStore();
    if (current) return fn(current);
    const conn = await this.driver.connect();
    try {
      return await fn(conn);
    } finally {
      conn.release();
    }
  }
}
