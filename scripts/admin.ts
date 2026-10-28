// Server administration from the command line (run where the database lives):
//   npm run admin -- create-world [seed.json] --gm discord:123=main [--gm discord:456=scene:ruins,road] [--gm discord:789=arbiter]
//   npm run admin -- set-gm <worldId> <userId> <main | scene:loc1,loc2 | arbiter | none>
//   npm run admin -- issue-token <userId> [label]        a player's or GM's own API token
//   npm run admin -- issue-service-token [label]         the Discord bot's token
//   npm run admin -- revoke-token <token>
//   npm run admin -- worlds
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CombatStore } from '../src/persistence/combat-store';
import { WorldStore } from '../src/persistence/world-store';
import { RULES_V03 } from '../src/rules/config';
import { Tokens } from '../src/server/auth';
import type { WorldSeed } from '../src/world/engine';
import type { GmGrant } from '../src/world/types';

const path = process.env.DATABASE_PATH ?? './data/fateweave.db';
mkdirSync(dirname(path), { recursive: true });
const store = new WorldStore(new CombatStore(path, RULES_V03), RULES_V03);
const tokens = new Tokens(store.combat.db);
const [cmd, ...args] = process.argv.slice(2);

function grant(spec: string): GmGrant {
  if (spec === 'main' || spec === 'arbiter') return { role: spec };
  if (spec.startsWith('scene:')) return { role: 'scene', locations: spec.slice(6).split(',') };
  throw new Error(`unknown GM grant ${spec}`);
}

switch (cmd) {
  case 'create-world': {
    const seedPath = args[0] && !args[0].startsWith('--') ? args[0] : 'config/world-seed.json';
    const gms: Record<string, GmGrant> = {};
    args.forEach((a, i) => {
      if (a !== '--gm') return;
      const [user, spec] = args[i + 1].split('=');
      gms[user] = grant(spec);
    });
    if (!Object.values(gms).some((g) => g.role === 'main')) throw new Error('a world needs at least one main GM: --gm <userId>=main');
    const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as WorldSeed;
    store.createWorld(seed, gms);
    console.log(`created world ${seed.id} (${seed.name}) with GMs ${Object.keys(gms).join(', ')}`);
    break;
  }
  case 'set-gm':
    store.setGm(args[0], args[1], args[2] === 'none' ? null : grant(args[2]));
    console.log(`${args[1]} in ${args[0]}: ${args[2]}`);
    break;
  case 'issue-token':
    console.log(tokens.issue(args[0], 'user', args[1] ?? ''));
    break;
  case 'issue-service-token':
    console.log(tokens.issue('service:discord', 'service', args[0] ?? 'discord bot'));
    break;
  case 'revoke-token':
    tokens.revoke(args[0]);
    console.log('revoked');
    break;
  case 'worlds':
    for (const id of store.worldIds()) console.log(id, store.load(id).name, JSON.stringify(store.load(id).gms));
    break;
  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
}
store.combat.close();
