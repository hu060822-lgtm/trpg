import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCharacter, exampleBuild } from '../src/character/create';
import type { Submission } from '../src/combat/types';
import { CombatStore } from '../src/persistence/combat-store';
import { RULES_V03 } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import type { AttributeCode } from '../src/rules/types';

const R = RULES_V03;
const T0 = new Date('2026-10-27T12:00:00Z');
const wolfAttrs: Record<AttributeCode, number> = { STR: 2, AGI: 2, VIT: 2, PRE: 1, PER: 1, INT: 0, WIL: 1, CHA: 0, INS: 1, SPR: 0 };

let path: string;
let store: CombatStore;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'fw-')), 'game.db');
  store = new CombatStore(path, R);
  store.saveNewCharacter('u1', createCharacter({ ...exampleBuild('scout', R), name: '灰鴉' }, R, T0, 'c-hero'));
  store.saveNewCharacter('u2', createCharacter({ ...exampleBuild('medic', R), name: '米菈' }, R, T0, 'c-mira'));
});

/** wolf (gm) acts first, then the hero (1 HP), then mira. */
function startFight(id = 'f1') {
  return store.createCombat(id, [
    store.combatantFor('c-hero', { id: 'hero', side: 'party', band: 0, weaponId: 'dagger', armorId: 'leather', hp: 1 }),
    store.combatantFor('c-mira', { id: 'mira', side: 'party', band: 0, weaponId: 'dagger', armorId: 'none' }),
    { id: 'wolf', name: '灰狼', side: 'beasts', controller: 'gm', attributes: wolfAttrs, skills: { melee: 2, dodge: 1 }, maxHp: 10, band: 0, weaponId: 'claws', armorId: 'hide' },
  ], scriptedRng([1, 1, 20]), T0);
}

let n = 0;
function send(combatId: string, combatantId: string, action: Submission['action'], rolls: number[] = [], actionId = `a${++n}`) {
  const s = store.loadCombat(combatId);
  const c = s.combatants[combatantId];
  const actor = c.controller === 'gm' ? { userId: 'gm1', role: 'gm' as const } : { userId: c.controller, role: 'player' as const };
  return store.submit(combatId, { actionId, actor, combatantId, round: s.round, action }, scriptedRng(rolls), T0);
}

describe('combat persistence', () => {
  it('reloads the exact state after reopening the database (no rollback on re-login)', () => {
    startFight();
    send('f1', 'wolf', { type: 'attack', targetId: 'hero' }, [15]);
    const before = store.loadCombat('f1');
    store.close();
    store = new CombatStore(path, R);
    expect(store.loadCombat('f1')).toEqual(before);
    expect(store.events('f1').map((e) => e.seq)).toEqual(before.events.map((e) => e.seq));
    expect(store.getCharacter('c-hero')).toMatchObject({ hp: 0, condition: 'dying' });
  });

  it('stores a resubmitted action once', () => {
    startFight();
    const first = send('f1', 'wolf', { type: 'defend' }, [], 'same-id');
    const again = send('f1', 'wolf', { type: 'defend' }, [], 'same-id');
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(store.events('f1').filter((e) => e.kind === 'defend')).toHaveLength(1);
  });

  it('leaves the database untouched when a submission is rejected', () => {
    startFight();
    const before = store.loadCombat('f1');
    expect(() => send('f1', 'hero', { type: 'defend' })).toThrow(/還沒輪到/);
    expect(store.loadCombat('f1')).toEqual(before);
  });

  it('a second connection sees and continues from the latest state', () => {
    startFight();
    send('f1', 'wolf', { type: 'defend' });
    const other = new CombatStore(path, R);
    const s = other.loadCombat('f1');
    expect(s.combatants.wolf.defending).toBe(true);
    other.close();
  });
});

describe('permanent death', () => {
  function killHero() {
    startFight();
    send('f1', 'wolf', { type: 'attack', targetId: 'hero' }, [15]); // hero → dying
    send('f1', 'wolf', { type: 'endTurn' });
    send('f1', 'hero', { type: 'deathSave' }, [5]); // the player rolls: fails (1)
    for (let i = 0; i < 2; i++) {
      send('f1', 'mira', { type: 'endTurn' });
      send('f1', 'wolf', { type: 'endTurn' });
      send('f1', 'hero', { type: 'deathSave' }, [5]); // fails 2, then 3
    }
  }

  it('writes the death record and marks the character dead in the same transaction', () => {
    killHero();
    expect(store.getCharacter('c-hero')).toMatchObject({ status: 'dead', condition: 'dead', hp: 0 });
    expect(store.deathRecord('c-hero')).toMatchObject({ combat_id: 'f1', cause: 'dying-failures' });
  });

  it('cannot be undone through the API or even a direct database update', () => {
    killHero();
    expect(() => store.renameCharacter({ userId: 'u1', role: 'player' }, 'c-hero', '復活的灰鴉')).toThrow(/永久死亡/);
    expect(() => store.db.prepare("UPDATE characters SET status = 'alive' WHERE id = 'c-hero'").run()).toThrow(/permanent death/);
    expect(() => store.combatantFor('c-hero', { id: 'h2', side: 'party', band: 0, weaponId: 'dagger', armorId: 'none' })).toThrow(/永久死亡/);
  });

  it('survives a restart', () => {
    killHero();
    store.close();
    store = new CombatStore(path, R);
    expect(store.getCharacter('c-hero').status).toBe('dead');
  });

  it('a new character can still be created for the same player', () => {
    killHero();
    store.saveNewCharacter('u1', createCharacter({ ...exampleBuild('ranger', R), name: '新角色' }, R, T0, 'c-new'));
    expect(store.getCharacter('c-new')).toMatchObject({ status: 'alive', ownerUserId: 'u1' });
  });
});

describe('ownership and timeouts', () => {
  it('players cannot edit other players’ characters', () => {
    expect(() => store.renameCharacter({ userId: 'u2', role: 'player' }, 'c-hero', 'x')).toThrow(/別人/);
  });

  it('the scheduler resolves overdue turns only', () => {
    startFight();
    expect(store.runTimeouts(scriptedRng([]), new Date('2026-10-28T11:00:00Z'))).toEqual([]);
    expect(store.runTimeouts(scriptedRng([5]), new Date('2026-10-28T12:00:00Z'))).toEqual(['f1']);
    expect(store.events('f1').some((e) => e.kind === 'timeout')).toBe(true);
  });
});
