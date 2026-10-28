import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { GlobalSetupContext } from 'vitest/node';

/** Creating a PGlite database takes seconds; build one empty data directory and let every test copy it. */
export default async function setup({ provide }: GlobalSetupContext) {
  const dir = mkdtempSync(join(tmpdir(), 'fw-pglite-template-'));
  const db = await PGlite.create(dir);
  await db.query('SELECT 1');
  await db.close();
  provide('pgliteTemplate', dir);
  return () => rmSync(dir, { recursive: true, force: true });
}

declare module 'vitest' {
  export interface ProvidedContext { pgliteTemplate: string }
}
