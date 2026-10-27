import { describe, expect, it } from 'vitest';
import {
  CombatError, applyTimeout, attackCheck, attackDamage, defenseOf, startCombat, submitAction, weapon, COMBAT_V03,
} from '../src/combat/engine';
import type { CombatState, CombatantSetup, Submission } from '../src/combat/types';
import { RULES_V02, RULES_V03 } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import type { AttributeCode } from '../src/rules/types';

const R = RULES_V03;
const T0 = new Date('2026-10-27T12:00:00Z');
const attrs = (o: Partial<Record<AttributeCode, number>> = {}): Record<AttributeCode, number> =>
  ({ STR: 1, AGI: 1, VIT: 1, PRE: 1, PER: 1, INT: 1, WIL: 1, CHA: 1, INS: 1, SPR: 1, ...o });

const hero = (o: Partial<CombatantSetup> = {}): CombatantSetup => ({
  id: 'hero', name: '灰鴉', side: 'party', controller: 'u1', characterId: 'c-hero',
  attributes: attrs({ STR: 3, AGI: 2, PER: 2, INT: 2 }), skills: { melee: 3, dodge: 1, medicine: 2 },
  maxHp: 12, band: 0, weaponId: 'sword', armorId: 'leather', ...o,
});
const wolf = (o: Partial<CombatantSetup> = {}): CombatantSetup => ({
  id: 'wolf', name: '灰狼', side: 'beasts', controller: 'gm',
  attributes: attrs({ STR: 2, AGI: 2, VIT: 2 }), skills: { melee: 2, dodge: 1 },
  maxHp: 10, band: 0, weaponId: 'claws', armorId: 'hide', ...o,
});

/** Starts a fight where `first` wins initiative. */
function fight(setups: CombatantSetup[], initRolls: number[]): CombatState {
  return startCombat({ id: 'f1', combatants: setups, rules: R, rng: scriptedRng(initRolls), now: T0 });
}

const sub = (s: CombatState, combatantId: string, action: Submission['action'], o: Partial<Submission> = {}): Submission => ({
  actionId: `${combatantId}-${s.seq}-${action.type}`,
  actor: { userId: s.combatants[combatantId].controller === 'gm' ? 'gm1' : s.combatants[combatantId].controller, role: s.combatants[combatantId].controller === 'gm' ? 'gm' : 'player' },
  combatantId, round: s.round, action, ...o,
});

const act = (s: CombatState, id: string, action: Submission['action'], rolls: number[] = [], o: Partial<Submission> = {}) =>
  submitAction(s, sub(s, id, action, o), R, scriptedRng(rolls), T0);

describe('starting a combat', () => {
  it('orders by d20 + AGI + PER and opens the first turn with 2 AP', () => {
    const s = fight([hero(), wolf()], [5, 15]);
    expect(s.order).toEqual(['wolf', 'hero']); // wolf 15+2+1=18, hero 5+2+2=9
    expect(s.turn).toMatchObject({ combatantId: 'wolf', ap: 2 });
    expect(s.turn!.deadline).toBe('2026-10-28T12:00:00.000Z');
  });

  it('refuses the historical v0.2 ruleset', () => {
    expect(() => startCombat({ id: 'x', combatants: [hero(), wolf()], rules: RULES_V02, rng: scriptedRng([1, 1]), now: T0 })).toThrow(/historical/);
  });
});

describe('attacks and damage', () => {
  it('computes defense from base + AGI + dodge + armor (+ defend)', () => {
    const s = fight([hero(), wolf()], [15, 5]);
    expect(defenseOf(s.combatants.wolf, COMBAT_V03)).toBe(8 + 2 + 1 + 1);
  });

  it('strong hit: weapon 5 + 2, minus armor 1', () => {
    const s = fight([hero(), wolf()], [15, 5]);
    // hero: d20 10 + STR 3 + melee 3 = 16 vs 12 → +4 strong
    const r = act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [10]);
    const atk = r.events.find((e) => e.kind === 'attack')!;
    expect(atk.data).toMatchObject({ total: 16, defense: 12, tier: 'strong', damage: 6 });
    expect(r.state.combatants.wolf.hp).toBe(4);
    expect(r.state.combatants.wolf.condition).toBe('wounded');
  });

  it('partial success deals half damage before armor', () => {
    const s = fight([hero(), wolf()], [15, 5]);
    const r = act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [4]); // 10 vs 12 → −2 partial → floor(5/2)=2 −1
    expect(r.state.combatants.wolf.hp).toBe(9);
  });

  it('rejects out-of-range melee and lets a bow reach', () => {
    const s = fight([hero(), wolf({ band: 2 })], [15, 5]);
    expect(() => act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [10])).toThrow(/打不到/);
    const archer = fight([hero({ weaponId: 'bow', skills: { ranged: 3 } }), wolf({ band: 2 })], [15, 5]);
    expect(act(archer, 'hero', { type: 'attack', targetId: 'wolf' }, [10]).events.some((e) => e.kind === 'attack')).toBe(true);
  });

  it('severe wounds roll with disadvantage', () => {
    const s = fight([hero({ hp: 3 }), wolf()], [15, 5]);
    expect(s.combatants.hero.condition).toBe('severe');
    const r = act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [18, 2]);
    expect(r.events.find((e) => e.kind === 'attack')!.data.d20).toEqual([18, 2]);
    expect(r.events.find((e) => e.kind === 'attack')!.data.total).toBe(8);
  });
});

describe('turn rules', () => {
  it('limits attacks per turn and auto-advances when AP runs out', () => {
    const s = fight([hero(), wolf()], [15, 5]);
    const r1 = act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [2]);
    expect(() => act(r1.state, 'hero', { type: 'attack', targetId: 'wolf' }, [10])).toThrow(/攻擊次數/);
    const r2 = act(r1.state, 'hero', { type: 'defend' });
    expect(r2.state.turn!.combatantId).toBe('wolf');
    expect(r2.state.combatants.hero.defending).toBe(true);
  });

  it('moves one band per AP', () => {
    const s = fight([hero(), wolf({ band: 2 })], [15, 5]);
    expect(() => act(s, 'hero', { type: 'move', to: 2 })).toThrow(/一個距離/);
    expect(act(s, 'hero', { type: 'move', to: 1 }).state.combatants.hero.band).toBe(1);
  });

  it('rejects other players, wrong turns and stale rounds', () => {
    const s = fight([hero(), wolf()], [15, 5]);
    const err = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as CombatError).code; } return 'none'; };
    expect(err(() => act(s, 'hero', { type: 'defend' }, [], { actor: { userId: 'intruder', role: 'player' } }))).toBe('forbidden');
    expect(err(() => act(s, 'wolf', { type: 'defend' }))).toBe('not-your-turn');
    expect(err(() => act(s, 'hero', { type: 'defend' }, [], { round: 0 }))).toBe('stale');
  });

  it('applies a resubmitted action id once and does not roll again', () => {
    const s = fight([hero(), wolf()], [15, 5]);
    const submission = sub(s, 'hero', { type: 'attack', targetId: 'wolf' });
    const r1 = submitAction(s, submission, R, scriptedRng([10]), T0);
    const r2 = submitAction(r1.state, submission, R, scriptedRng([]), T0);
    expect(r2.duplicate).toBe(true);
    expect(r2.state).toBe(r1.state);
  });

  it('never mutates the input state', () => {
    const s = fight([hero(), wolf()], [15, 5]);
    const before = structuredClone(s);
    act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [20]);
    expect(s).toEqual(before);
  });
});

describe('dying and permanent death', () => {
  // Hero acts first; the wolf starts at 1 HP so any hit drops it.
  const downWolf = () => {
    const s = fight([hero(), wolf({ hp: 1 })], [15, 5]);
    return act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [10]);
  };

  it('drops to dying at 0 HP and rolls a death save at the start of its turn', () => {
    const r = downWolf();
    expect(r.events.map((e) => e.kind)).toContain('dying');
    expect(r.state.combatants.wolf.condition).toBe('dying');
  });

  it('dies after 3 failed death saves; the death is permanent and the dead are skipped', () => {
    // wolf2 keeps the fight going while the wolf bleeds out. Order: hero, wolf, wolf2.
    let s = fight([hero(), wolf({ hp: 1 }), wolf({ id: 'wolf2', name: '灰狼二' })], [15, 5, 1]);
    s = act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [10]).state;
    for (let round = 1; round <= 3; round++) {
      s = act(s, 'hero', { type: 'endTurn' }, [5]).state; // wolf's save: 5 + VIT 2 = 7 < 14
      expect(s.combatants.wolf.dying.failures).toBe(round);
      s = act(s, 'wolf2', { type: 'endTurn' }).state;
    }
    expect(s.combatants.wolf.condition).toBe('dead');
    const death = s.events.find((e) => e.kind === 'death')!;
    expect(death.data).toMatchObject({ cause: 'dying-failures', permanent: true });
    // The dead wolf no longer rolls or takes turns: no dice are needed to pass it.
    s = act(s, 'hero', { type: 'endTurn' }, []).state;
    expect(s.turn!.combatantId).toBe('wolf2');
    expect(() => act(s, 'wolf', { type: 'defend' })).toThrow(/還沒輪到/);
  });

  it('natural 1 on a death save counts as two failures; natural 20 stabilizes', () => {
    let s = fight([hero(), wolf({ hp: 1 }), wolf({ id: 'wolf2' })], [15, 5, 1]);
    s = act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [10]).state;
    const nat1 = submitAction(s, sub(s, 'hero', { type: 'endTurn' }), R, scriptedRng([1]), T0).state;
    expect(nat1.combatants.wolf.dying.failures).toBe(2);
    const nat20 = submitAction(s, sub(s, 'hero', { type: 'endTurn' }), R, scriptedRng([20]), T0).state;
    expect(nat20.combatants.wolf.condition).toBe('stable');
  });

  it('a hit on a dying combatant adds a failure; a hit of max HP or more kills outright', () => {
    let s = fight([hero(), wolf({ hp: 1 }), wolf({ id: 'wolf2' })], [15, 5, 1]);
    s = act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [10]).state;
    s = submitAction(s, sub(s, 'hero', { type: 'endTurn' }), R, scriptedRng([10]), T0).state; // save fails (14 needed)
    s = act(s, 'wolf2', { type: 'endTurn' }).state;
    // round 2: hero's turn comes before the wolf's death save
    const hit = act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [2]); // vs helpless defense 8: 2+3+3=8 → success 5−1=4
    expect(hit.state.combatants.wolf.dying.failures).toBe(2);
    const axe = fight([hero({ weaponId: 'greataxe' }), wolf({ hp: 1, maxHp: 6 }), wolf({ id: 'wolf2' })], [15, 5, 1]);
    let t = act(axe, 'hero', { type: 'attack', targetId: 'wolf' }, [10]).state;
    t = submitAction(t, sub(t, 'hero', { type: 'endTurn' }), R, scriptedRng([10]), T0).state;
    t = act(t, 'wolf2', { type: 'endTurn' }).state;
    const kill = act(t, 'hero', { type: 'attack', targetId: 'wolf' }, [10]); // 7+? ≥ 6
    expect(kill.state.combatants.wolf.condition).toBe('dead');
    expect(kill.events.find((e) => e.kind === 'death')!.data).toMatchObject({ cause: 'massive-damage', permanent: true });
  });
});

describe('rescue, protection, timeouts and the end of combat', () => {
  const medic = (o: Partial<CombatantSetup> = {}): CombatantSetup => ({
    id: 'mira', name: '米菈', side: 'party', controller: 'u2', characterId: 'c-mira',
    attributes: attrs({ INT: 3, WIL: 3 }), skills: { medicine: 3, firstAid: 2 },
    maxHp: 12, band: 0, weaponId: 'dagger', armorId: 'none', medkits: 1, ...o,
  });
  // mira 15+1+1=17, hero 5+2+2=9, wolf 1+2+1=4 → mira, hero, wolf
  const downed = () => fight([medic(), hero({ hp: 0 }), wolf()], [15, 5, 1]);

  it('a successful rescue stabilizes the dying ally', () => {
    const s = downed();
    expect(s.combatants.hero.condition).toBe('dying');
    const r = act(s, 'mira', { type: 'rescue', targetId: 'hero' }, [8]); // 8 + 3 + 3 = 14
    expect(r.state.combatants.hero).toMatchObject({ condition: 'stable', hp: 1 });
  });

  it('a dying player rolls their own death save on their turn; the server makes the roll', () => {
    const s = act(downed(), 'mira', { type: 'endTurn' }).state;
    expect(s.turn).toMatchObject({ combatantId: 'hero', kind: 'deathSave', ap: 0 });
    expect(() => act(s, 'hero', { type: 'defend' })).toThrow(/只能擲瀕死判定/);
    expect(() => act(s, 'mira', { type: 'deathSave' }, [], { combatantId: 'hero', actor: { userId: 'u2', role: 'player' } })).toThrow(/不能操作/);
    const r = act(s, 'hero', { type: 'deathSave' }, [15]); // 15 + VIT 1 = 16 ≥ 14
    expect(r.events.find((e) => e.kind === 'deathSave')!.data).toMatchObject({ d20: 15, success: true, successes: 1 });
    expect(r.state.turn!.combatantId).toBe('wolf');
    expect(() => act(downed(), 'mira', { type: 'deathSave' })).toThrow(/沒有瀕死/);
  });

  it('a timed-out death save is rolled by the server, never skipped', () => {
    const s = act(downed(), 'mira', { type: 'endTurn' }).state;
    const r = applyTimeout(s, R, scriptedRng([3]), new Date(new Date(s.turn!.deadline).getTime() + 1));
    expect(r.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['timeout', 'deathSave']));
    expect(r.events.find((e) => e.kind === 'deathSave')!.data).toMatchObject({ success: false, failures: 1, automatic: true });
    expect(r.state.turn!.combatantId).toBe('wolf');
  });

  it('a strong rescue puts the ally back on their feet at a quarter of max HP', () => {
    const r = act(downed(), 'mira', { type: 'rescue', targetId: 'hero' }, [11]); // 17 → strong
    expect(r.state.combatants.hero).toMatchObject({ condition: 'severe', hp: 3 });
  });

  it('a medkit grants advantage and is used up', () => {
    const r = act(downed(), 'mira', { type: 'rescue', targetId: 'hero', useMedkit: true }, [3, 12]);
    expect(r.events.find((e) => e.kind === 'rescue')!.data).toMatchObject({ d20: [3, 12], tier: 'strong', medkit: true });
    expect(r.state.combatants.mira.medkits).toBe(0);
  });

  it('cannot rescue an enemy or a target in another band', () => {
    const s = fight([medic(), hero(), wolf({ hp: 0 }), wolf({ id: 'wolf2' })], [15, 5, 1, 1]);
    expect(() => act(s, 'mira', { type: 'rescue', targetId: 'wolf' })).toThrow(/同陣營/);
    const far = fight([medic({ band: 1 }), hero({ hp: 0 }), wolf()], [15, 5, 1]);
    expect(() => act(far, 'mira', { type: 'rescue', targetId: 'hero' })).toThrow(/同一距離/);
  });

  it('a death-protected combatant stabilizes at 0 HP and cannot be finished off', () => {
    let s = fight([hero({ hp: 1, deathProtected: true }), wolf(), wolf({ id: 'wolf2' }), medic()], [1, 15, 10, 2]);
    s = act(s, 'wolf', { type: 'attack', targetId: 'hero' }, [15]).state;
    expect(s.combatants.hero).toMatchObject({ condition: 'stable', hp: 0 });
    s = act(s, 'wolf', { type: 'endTurn' }).state;
    s = act(s, 'wolf2', { type: 'attack', targetId: 'hero' }, [15]).state;
    expect(s.combatants.hero.condition).toBe('stable');
    expect(s.events.some((e) => e.kind === 'death')).toBe(false);
  });

  it('a timed-out turn takes the safe default (defend) and never attacks', () => {
    const s = fight([hero(), wolf()], [15, 5]);
    expect(applyTimeout(s, R, scriptedRng([]), new Date('2026-10-28T11:59:00Z')).state).toBe(s);
    const r = applyTimeout(s, R, scriptedRng([]), new Date('2026-10-28T12:00:00Z'));
    expect(r.events.map((e) => e.kind)).toEqual(['timeout', 'defend', 'turnStarted']);
    expect(r.state.combatants.hero.defending).toBe(true);
    expect(r.state.combatants.wolf.hp).toBe(10);
    expect(r.state.turn!.combatantId).toBe('wolf');
  });

  it('a potion heals an able ally in the same band', () => {
    const s = fight([medic({ potions: 1 }), hero({ hp: 4 }), wolf()], [15, 5, 1]);
    const r = act(s, 'mira', { type: 'usePotion', targetId: 'hero' });
    expect(r.state.combatants.hero.hp).toBe(8);
    expect(r.state.combatants.mira.potions).toBe(0);
  });

  it('a successful escape removes the combatant from the fight', () => {
    const s = fight([hero(), wolf(), wolf({ id: 'wolf2' })], [15, 5, 1]);
    const r = act(s, 'hero', { type: 'escape' }, [15]); // 15 + AGI 2 + dodge 1 = 18 ≥ 14
    expect(r.state.combatants.hero.condition).toBe('escaped');
    expect(r.state.status).toBe('ended');
    expect(r.state.winner).toBe('beasts');
  });

  it('ends when one side has nobody able to act, and refuses further actions', () => {
    const s = fight([hero(), wolf({ hp: 1 })], [15, 5]);
    const r = act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [10]);
    expect(r.state.status).toBe('ended');
    expect(r.state.winner).toBe('party');
    expect(r.events.at(-1)!.data.outcome).toMatchObject({ wolf: { condition: 'dying' } });
    expect(() => act(r.state, 'hero', { type: 'defend' })).toThrow(/結束/);
  });
});

describe('odds preview helpers', () => {
  it('attackCheck and attackDamage give the numbers the engine actually rolls with', () => {
    const s = fight([hero(), wolf()], [15, 5]);
    const input = attackCheck(s.combatants.hero, s.combatants.wolf, COMBAT_V03);
    expect(input).toEqual({ attribute: 3, skill: 3, tn: 12, mode: 'normal' });
    const r = act(s, 'hero', { type: 'attack', targetId: 'wolf' }, [10]);
    const atk = r.events.find((e) => e.kind === 'attack')!.data as { total: number; defense: number; tier: 'strong'; damage: number };
    expect(atk.total).toBe(10 + input.attribute + input.skill);
    expect(atk.defense).toBe(input.tn);
    expect(attackDamage(weapon('sword'), atk.tier, s.combatants.wolf, COMBAT_V03)).toBe(atk.damage);
  });
});
