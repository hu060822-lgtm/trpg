import { mkdirSync } from 'node:fs';
import { createApp } from './app';
import { openGame } from './boot';

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

const { table, auth } = await openGame(url, {
  supabaseUrl: env.SUPABASE_URL, supabaseJwtSecret: env.SUPABASE_JWT_SECRET, supabaseAnonKey: env.SUPABASE_ANON_KEY, dev: env.AUTH_DEV === '1',
});

createApp({
  table, auth,
  corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
}).listen(Number(env.PORT ?? 3000), () => console.log(`FATEWEAVE server on :${env.PORT ?? 3000}, database ${url.replace(/:[^:@/]+@/, ':***@')}`));
