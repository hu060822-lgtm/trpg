import { mkdirSync } from 'node:fs';
import { createApp } from './app';
import { openGame } from './boot';
import { attachRealtime, RoomHub } from './realtime';

/**
 * Starts the game server. Env:
 *   DATABASE_URL          postgres://… (Supabase), or a PGlite directory (default ./data/pglite) for local play
 *   PORT                  default 3000
 *   SUPABASE_URL          verifies sign-ins with the project's JWT signing keys
 *   SUPABASE_JWT_SECRET   legacy shared-secret projects only
 *   SUPABASE_ANON_KEY     public key; lets legacy projects work without the secret (asks Supabase Auth instead)
 *   AUTH_DEV=1            accepts `dev:<name>` tokens; never set this in production
 *   CORS_ORIGINS          comma-separated origins of the web client, e.g. https://<user>.github.io
 */
const env = process.env;
const url = env.DATABASE_URL ?? './data/pglite';
if (!url.startsWith('postgres')) mkdirSync(url, { recursive: true });

const { table, maps, encounters, auth } = await openGame(url, {
  supabaseUrl: env.SUPABASE_URL, supabaseJwtSecret: env.SUPABASE_JWT_SECRET, supabaseAnonKey: env.SUPABASE_ANON_KEY, dev: env.AUTH_DEV === '1',
});

const hub = new RoomHub();
const server = createApp({
  table, maps, encounters, auth, hub,
  corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
}).listen(Number(env.PORT ?? 3000), () => console.log(`FATEWEAVE server on :${env.PORT ?? 3000}, database ${url.replace(/:[^:@/]+@/, ':***@')}`));
attachRealtime(server, auth, table, hub);

// The combat clock: steps past their deadline (a player who walked away, an NPC turn that runs itself).
let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    for (const { roomId, mapId } of await encounters.tick()) {
      hub.publish(roomId, { type: 'encounter' });
      hub.publish(roomId, { type: 'log' });
      hub.publish(roomId, { type: 'map', mapId });
    }
  } catch (e) {
    console.error('combat clock', e);
  } finally {
    ticking = false;
  }
}, 1000);
