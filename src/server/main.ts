import { mkdirSync } from 'node:fs';
import { RULES_V03 } from '../rules/config';
import { randomRng } from '../rules/dice';
import { createApp } from './app';
import { ensureWorld, openGame, parseGrants } from './boot';
import { Scheduler } from './scheduler';

/**
 * Starts the game server. Env:
 *   DATABASE_URL          postgres://… (Supabase), or a PGlite directory (default ./data/pglite) for local play
 *   PORT                  default 3000
 *   SUPABASE_URL          verifies sign-ins with the project's JWT signing keys
 *   SUPABASE_JWT_SECRET   legacy shared-secret projects only
 *   SUPABASE_ANON_KEY     public key; lets legacy projects work without the secret (asks Supabase Auth instead)
 *   AUTH_DEV=1            accepts `dev:<name>` tokens; never set this in production
 *   CORS_ORIGINS          comma-separated origins of the web client, e.g. https://<user>.github.io
 *   INITIAL_GMS           GMs of the first world, `sb:<user id>=main`; created on an empty database, added later if missing
 */
const env = process.env;
const url = env.DATABASE_URL ?? './data/pglite';
if (!url.startsWith('postgres')) mkdirSync(url, { recursive: true });

const { store, auth } = await openGame(url, {
  supabaseUrl: env.SUPABASE_URL, supabaseJwtSecret: env.SUPABASE_JWT_SECRET, supabaseAnonKey: env.SUPABASE_ANON_KEY, dev: env.AUTH_DEV === '1',
});
const initialGms = parseGrants(env.INITIAL_GMS ?? (env.AUTH_DEV === '1' ? 'dev:gm=main' : ''));
const seeded = await ensureWorld(store, initialGms);
if (seeded.created) console.log(`created the seed world, GMs: ${seeded.granted.join(', ') || 'none yet (set INITIAL_GMS and restart)'}`);
else if (seeded.granted.length) console.log(`gave GM grants from INITIAL_GMS to ${seeded.granted.join(', ')}`);
const scheduler = await Scheduler.open(store, randomRng);
const report = async (now: Date) => {
  for (const r of await scheduler.tick(now)) if (r.errors.length) console.error(`[scheduler] ${r.worldId}`, r.errors);
};

createApp({
  store, auth, rules: RULES_V03,
  corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  beforeRequest: () => scheduler.catchUp(new Date()),
}).listen(Number(env.PORT ?? 3000), () => console.log(`FATEWEAVE server on :${env.PORT ?? 3000}, database ${url.replace(/:[^:@/]+@/, ':***@')}`));

await report(new Date());
setInterval(() => { void report(new Date()); }, 60_000);
