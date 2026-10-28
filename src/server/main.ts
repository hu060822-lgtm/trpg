import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CombatStore } from '../persistence/combat-store';
import { WorldStore } from '../persistence/world-store';
import { RULES_V03 } from '../rules/config';
import { randomRng } from '../rules/dice';
import { createApp } from './app';
import { Tokens } from './auth';
import { Scheduler } from './scheduler';

/** Starts the game server. Env: DATABASE_PATH (default ./data/fateweave.db), PORT (default 3000). */
const path = process.env.DATABASE_PATH ?? './data/fateweave.db';
const port = Number(process.env.PORT ?? 3000);

mkdirSync(dirname(path), { recursive: true });
const store = new WorldStore(new CombatStore(path, RULES_V03), RULES_V03);
const tokens = new Tokens(store.combat.db);
const scheduler = new Scheduler(store, randomRng);

createApp({ store, tokens, rules: RULES_V03 }).listen(port, () => {
  console.log(`FATEWEAVE server on :${port}, database ${path}`);
});

setInterval(() => {
  for (const r of scheduler.tick(new Date())) if (r.errors.length) console.error(`[scheduler] ${r.worldId}`, r.errors);
}, 60_000);
