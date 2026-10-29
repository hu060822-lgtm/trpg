import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../persistence/drivers';
import { readPackDir } from '../pack/zip';
import { TableStore } from '../table/store';
import { Auth, type AuthOptions } from './auth';

const PACKS_DIR = fileURLToPath(new URL('../../packs/', import.meta.url));

/** Opens the database and every store on it, and refreshes the built-in rule packs. Shared by the server and the admin CLI. */
export async function openGame(url: string, auth: AuthOptions = {}) {
  const db = await openDatabase(url);
  const table = await TableStore.open(db);
  if (existsSync(PACKS_DIR)) {
    for (const dir of readdirSync(PACKS_DIR, { withFileTypes: true })) {
      if (dir.isDirectory()) await table.savePack(readPackDir(join(PACKS_DIR, dir.name)), 'system', true);
    }
  }
  return { db, table, auth: await Auth.open(db, auth) };
}
