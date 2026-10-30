import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../persistence/drivers';
import { buildPack } from '../pack/pack';
import { readPackDirFiles } from '../pack/zip';
import { EncounterStore } from '../table/encounters';
import { FieldStore } from '../table/field';
import { MapStore } from '../table/maps';
import { randomRng, type Rng } from '../rules/dice';
import { TableStore } from '../table/store';
import { Auth, type AuthOptions } from './auth';

const PACKS_DIR = fileURLToPath(new URL('../../packs/', import.meta.url));

/** Opens the database and every store on it, and refreshes the built-in rule packs. Shared by the server and the admin CLI. */
export async function openGame(url: string, auth: AuthOptions = {}, rng: Rng = randomRng) {
  const db = await openDatabase(url);
  const table = await TableStore.open(db);
  if (existsSync(PACKS_DIR)) {
    for (const dir of readdirSync(PACKS_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const files = readPackDirFiles(join(PACKS_DIR, dir.name));
      await table.savePack(buildPack(files), 'system', true, new Date(), files);
    }
  }
  const maps = await MapStore.open(db, table);
  const encounters = await EncounterStore.open(db, table, rng);
  return { db, table, maps, encounters, field: await FieldStore.open(db, table, encounters, rng), auth: await Auth.open(db, auth) };
}
