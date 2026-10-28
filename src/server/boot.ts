import seed from '../../config/world-seed.json';
import { CombatStore } from '../persistence/combat-store';
import { openDatabase } from '../persistence/drivers';
import { WorldStore } from '../persistence/world-store';
import { RULES_V03 } from '../rules/config';
import type { WorldSeed } from '../world/engine';
import type { GmGrant } from '../world/types';
import { Auth, type AuthOptions } from './auth';

/** Opens the database and every store on it. Shared by the server and the admin CLI. */
export async function openGame(url: string, auth: AuthOptions = {}) {
  const db = await openDatabase(url);
  const combat = await CombatStore.open(db, RULES_V03);
  const store = await WorldStore.open(combat, RULES_V03);
  return { db, store, auth: await Auth.open(db, auth) };
}

/** `main` | `arbiter` | `scene:loc1,loc2` */
export function parseGrant(spec: string): GmGrant {
  if (spec === 'main' || spec === 'arbiter') return { role: spec };
  if (spec.startsWith('scene:')) return { role: 'scene', locations: spec.slice(6).split(',') };
  throw new Error(`unknown GM grant ${spec}`);
}

/** `sb:uuid=main,dev:luz=arbiter` → grant table. */
export function parseGrants(list: string): Record<string, GmGrant> {
  return Object.fromEntries(list.split(/[\s,;]+/).filter(Boolean).map((pair) => {
    const at = pair.lastIndexOf('=');
    return [pair.slice(0, at), parseGrant(pair.slice(at + 1))];
  }));
}

/** First start on an empty database: creates the seed world so there is somewhere to play. */
export async function ensureWorld(store: WorldStore, gms: Record<string, GmGrant>) {
  if ((await store.worldIds()).length > 0) return false;
  await store.createWorld(seed as WorldSeed, gms);
  return true;
}
