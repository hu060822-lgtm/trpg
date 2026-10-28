import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCharacter, exampleBuild } from '../src/character/create';
import type { Submission } from '../src/combat/types';
import { CombatStore } from '../src/persistence/combat-store';
import type { Database } from '../src/persistence/db';
import { openDatabase } from '../src/persistence/drivers';
import { RULES_V03 } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import type { AttributeCode } from '../src/rules/types';
import { freshDatabaseUrl, realPostgres } from './helpers/db';

const R = RULES_V03;
const T0 = new Date('2026-10-27T12:00:00Z');
const wolfAttrs: Record<AttributeCode, number> = { STR: 2, AGI: 2, VIT: 2, PRE: 1, PER: 1, INT: 0, WIL: 1, CHA: 0, INS: 1, SPR: 0 };

let url: string;
let cleanup: () => Promise<void>;
let db: Database;
let store: CombatStore;

async function reopen() {
  await db.close();
  db = await openDatabase(url);
  store = await CombatStore.open(db, R);
}

beforeEach(async () => {
  ({ url, cleanup } = await freshDatabaseUrl());
  db = await openDatabase(url);
  store = await CombatStore.open(db, R);
  await store.saveNewCharacter('u1', createCharacter({ ...exampleBuild('scout', R), name: '灰鴉' }, R, T0, 'c-hero'));
  await store.saveNewCharacter('u2', createCharacter({ ...exampleBuild('medic', R), name: '米菈' }, R, T0, 'c-mira'));
});
afterEach(async () => {
  await db.close();
  await cleanup();
});

/** wolf (gm) acts first, then the hero (1 HP), then mira. */
async function startFight(id = 'f1') {
  return store.createCombat(id, [
    await store.combatantFor('c-hero', { id: 'hero', side: 'party', band: 0, weaponId: 'dagger', armorId: 'leather', hp: 1 }),
    await store.combatantFor('c-mira', { id: 'mira', side: 'party', band: 0, weaponId: 'dagger', armorId: 'none' }),
    { id: 'wolf', name: '灰狼', side: 'beasts', controller: 'gm', attributes: wolfAttrs, skills: { melee: 2, dodge: 1 }, maxHp: 10, band: 0, weaponId: 'claws', armorId: 'hide' },
  ], scriptedRng([1, 1, 20]), T0);
}

let n = 0;
async function send(combatId: string, combatantId: string, action: Submission['action'], rolls: number[] = [], actionId = `a${++n}`) {
  const s = await store.loadCombat(combatId);
  const c = s.combatants[combatantId];
  const actor = c.controller === 'gm' ? { userId: 'gm1', role: 'gm' as const } : { userId: c.controller, role: 'player' as const };
  return store.submit(combatId, { actionId, actor, combatantId, round: s.round, action }, scriptedRng(rolls), T0);
}

describe('combat persistence', () => {
  it('reloads the exact state after reopening the database (no rollback on re-login)', async () => {
    await startFight();
    await send('f1', 'wolf', { type: 'attack', targetId: 'hero' }, [15]);
    const before = await store.loadCombat('f1');
    await reopen();
    expect(await store.loadCombat('f1')).toEqual(before);
    expect((await store.events('f1')).map((e) => e.seq)).toEqual(before.events.map((e) => e.seq));
    expect(await store.getCharacter('c-hero')).toMatchObject({ hp: 0, condition: 'dying' });
  });

  it('stores a resubmitted action once', async () => {
    await startFight();
    const first = await send('f1', 'wolf', { type: 'defend' }, [], 'same-id');
    const again = await send('f1', 'wolf', { type: 'defend' }, [], 'same-id');
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect((await store.events('f1')).filter((e) => e.kind === 'defend')).toHaveLength(1);
  });

  it('leaves the database untouched when a submission is rejected', async () => {
    await startFight();
    const before = await store.loadCombat('f1');
    await expect(send('f1', 'hero', { type: 'defend' })).rejects.toThrow(/還沒輪到/);
    expect(await store.loadCombat('f1')).toEqual(before);
  });

  it('a second connection sees and continues from the latest state', async () => {
    await startFight();
    await send('f1', 'wolf', { type: 'defend' });
    // PGlite allows one process per data directory, so without a real server the second store shares the database.
    const otherDb = realPostgres ? await openDatabase(url) : db;
    const other = await CombatStore.open(otherDb, R);
    expect((await other.loadCombat('f1')).combatants.wolf.defending).toBe(true);
    if (realPostgres) await otherDb.close();
  });

  it('two submissions to the same turn at once: one applies, the other is refused, nothing is half-written', async () => {
    await startFight();
    const s = await store.loadCombat('f1');
    const sub = (actionId: string) => store.submit('f1', {
      actionId, actor: { userId: 'gm1', role: 'gm' }, combatantId: 'wolf', round: s.round, action: { type: 'attack', targetId: 'mira' },
    }, scriptedRng([15, 3]), T0);
    const results = await Promise.allSettled([sub('x1'), sub('x2')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.events('f1')).filter((e) => e.kind === 'attack')).toHaveLength(1);
  });
});

describe('permanent death', () => {
  async function killHero() {
    await startFight();
    await send('f1', 'wolf', { type: 'attack', targetId: 'hero' }, [15]); // hero → dying
    await send('f1', 'wolf', { type: 'endTurn' });
    await send('f1', 'hero', { type: 'deathSave' }, [5]); // the player rolls: fails (1)
    for (let i = 0; i < 2; i++) {
      await send('f1', 'mira', { type: 'endTurn' });
      await send('f1', 'wolf', { type: 'endTurn' });
      await send('f1', 'hero', { type: 'deathSave' }, [5]); // fails 2, then 3
    }
  }

  it('writes the death record and marks the character dead in the same transaction', async () => {
    await killHero();
    expect(await store.getCharacter('c-hero')).toMatchObject({ status: 'dead', condition: 'dead', hp: 0 });
    expect(await store.deathRecord('c-hero')).toMatchObject({ combat_id: 'f1', cause: 'dying-failures' });
  });

  it('cannot be undone through the API or even a direct database update', async () => {
    await killHero();
    await expect(store.renameCharacter({ userId: 'u1', role: 'player' }, 'c-hero', '復活的灰鴉')).rejects.toThrow(/永久死亡/);
    await expect(db.run("UPDATE characters SET status = 'alive' WHERE id = 'c-hero'")).rejects.toThrow(/permanent death/);
    await expect(store.combatantFor('c-hero', { id: 'h2', side: 'party', band: 0, weaponId: 'dagger', armorId: 'none' })).rejects.toThrow(/永久死亡/);
  });

  it('survives a restart', async () => {
    await killHero();
    await reopen();
    expect((await store.getCharacter('c-hero')).status).toBe('dead');
  });

  it('a new character can still be created for the same player', async () => {
    await killHero();
    await store.saveNewCharacter('u1', createCharacter({ ...exampleBuild('ranger', R), name: '新角色' }, R, T0, 'c-new'));
    expect(await store.getCharacter('c-new')).toMatchObject({ status: 'alive', ownerUserId: 'u1' });
  });
});

describe('ownership and timeouts', () => {
  it('players cannot edit other players’ characters', async () => {
    await expect(store.renameCharacter({ userId: 'u2', role: 'player' }, 'c-hero', 'x')).rejects.toThrow(/別人/);
  });

  it('the scheduler resolves overdue turns only', async () => {
    await startFight();
    expect(await store.runTimeouts(scriptedRng([]), new Date('2026-10-28T11:00:00Z'))).toEqual([]);
    expect(await store.runTimeouts(scriptedRng([5]), new Date('2026-10-28T12:00:00Z'))).toEqual(['f1']);
    expect((await store.events('f1')).some((e) => e.kind === 'timeout')).toBe(true);
  });
});
