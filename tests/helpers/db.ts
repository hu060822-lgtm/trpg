import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';

/**
 * A fresh, empty database for one test. By default a PGlite data directory copied from a template;
 * with TEST_DATABASE_URL set (a real PostgreSQL server), a fresh schema on that server instead.
 * `realPostgres` tells tests whether several processes can share it (PGlite is single-process).
 */
export const realPostgres = !!process.env.TEST_DATABASE_URL;

export async function freshDatabaseUrl(): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const server = process.env.TEST_DATABASE_URL;
  if (server) {
    const schema = `t_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: server });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    const url = new URL(server);
    url.searchParams.set('options', `-c search_path=${schema}`);
    return {
      url: url.toString(),
      cleanup: async () => {
        const c = new pg.Client({ connectionString: server });
        await c.connect();
        await c.query(`DROP SCHEMA ${schema} CASCADE`);
        await c.end();
      },
    };
  }
  const dir = join(mkdtempSync(join(tmpdir(), 'fw-db-')), 'data');
  cpSync(inject('pgliteTemplate'), dir, { recursive: true });
  return { url: dir, cleanup: async () => rmSync(join(dir, '..'), { recursive: true, force: true }) };
}
