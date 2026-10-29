// Server administration from the command line. Point DATABASE_URL at the same database as the server
// (the Supabase connection string in production; default ./data/pglite locally):
//   npm run admin -- create-world [seed.json] --gm pw:<name>=main [--gm pw:<name>=scene:ruins,road] [--gm pw:<name>=arbiter]
//   npm run admin -- set-gm <worldId> <userId> <main | scene:loc1,loc2 | arbiter | none>
//   npm run admin -- issue-token <userId> [label]        an API token for scripts or tests
//   npm run admin -- issue-service-token [label]         a service token (may act for users with X-Act-As)
//   npm run admin -- revoke-token <token>
//   npm run admin -- worlds
// A player's user id is shown on the web client's 帳號 page and by GET /api/me.
import { mkdirSync, readFileSync } from 'node:fs';
import { openGame, parseGrant } from '../src/server/boot';
import type { WorldSeed } from '../src/world/engine';
import type { GmGrant } from '../src/world/types';

const url = process.env.DATABASE_URL ?? './data/pglite';
if (!url.startsWith('postgres')) mkdirSync(url, { recursive: true });
const { db, store, auth } = await openGame(url);
const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'create-world': {
    const seedPath = args[0] && !args[0].startsWith('--') ? args[0] : 'config/world-seed.json';
    const gms: Record<string, GmGrant> = {};
    args.forEach((a, i) => {
      if (a !== '--gm') return;
      const pair = args[i + 1];
      const at = pair.lastIndexOf('=');
      gms[pair.slice(0, at)] = parseGrant(pair.slice(at + 1));
    });
    if (!Object.values(gms).some((g) => g.role === 'main')) throw new Error('a world needs at least one main GM: --gm <userId>=main');
    const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as WorldSeed;
    await store.createWorld(seed, gms);
    console.log(`created world ${seed.id} (${seed.name}) with GMs ${Object.keys(gms).join(', ')}`);
    break;
  }
  case 'set-gm':
    await store.setGm(args[0], args[1], args[2] === 'none' ? null : parseGrant(args[2]));
    console.log(`${args[1]} in ${args[0]}: ${args[2]}`);
    break;
  case 'issue-token':
    console.log(await auth.issue(args[0], 'user', args[1] ?? ''));
    break;
  case 'issue-service-token':
    console.log(await auth.issue('service:bot', 'service', args[0] ?? 'service'));
    break;
  case 'revoke-token':
    await auth.revoke(args[0]);
    console.log('revoked');
    break;
  case 'worlds':
    for (const id of await store.worldIds()) {
      const s = await store.load(id);
      console.log(id, s.name, JSON.stringify(s.gms));
    }
    break;
  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
}
await db.close();
