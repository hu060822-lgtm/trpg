import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { Database, type Conn, type Driver } from './db';

/**
 * Opens the game database. `postgres://…` (Supabase in production) uses a connection pool; anything else is a PGlite
 * data directory, or `memory://` for tests. PGlite has a single connection, so callers queue for it one at a time.
 */
export async function openDatabase(url: string): Promise<Database> {
  if (/^postgres(ql)?:\/\//.test(url)) return new Database(pgDriver(url));
  return new Database(await pgliteDriver(url));
}

function pgDriver(url: string): Driver {
  // Supabase requires TLS; a local server (tests) usually has none.
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({ connectionString: url, max: 5, ssl: local ? undefined : { rejectUnauthorized: false } });
  return {
    async connect() {
      const c = await pool.connect();
      return {
        async query(text, params) {
          const r = await c.query(text, params as unknown[]);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
        async exec(text) { await c.query(text); },
        release: () => c.release(),
      };
    },
    end: () => pool.end(),
  };
}

async function pgliteDriver(url: string): Promise<Driver> {
  const db = await PGlite.create(url === 'memory://' ? undefined : url);
  let queue = Promise.resolve();
  return {
    async connect(): Promise<Conn> {
      let release!: () => void;
      const turn = new Promise<void>((r) => { release = r; });
      const prev = queue;
      queue = prev.then(() => turn);
      await prev;
      return {
        async query(text, params) {
          const r = await db.query<Record<string, unknown>>(text, params as unknown[]);
          return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
        },
        async exec(text) { await db.exec(text); },
        release,
      };
    },
    end: () => db.close(),
  };
}
