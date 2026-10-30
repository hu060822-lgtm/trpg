import { describe, expect, it } from 'vitest';
import { computeSheet } from '../src/pack/pack';
import { readPackDir } from '../src/pack/zip';
import { DodgeSim, FINE_ALPHABET, fineChar, runDodge, validMoves, pickPattern } from '../src/encounter/dodge';
import { createEncounter, runClock, runCommand, runMove, viewFor, CombatError, type Ctx, type TokenInfo, type Outcome, type Command } from '../src/encounter/engine';
import { areaCells, blockMap, canSee, feetBetween, walkCost, type Grid } from '../src/encounter/geometry';
import { DEFAULT_RULES, scaledDamage, tierFor, factorFor, bonusFor, healthWords } from '../src/encounter/rules';
import { challengeFor, scoreGesture, swayAt, wellFormed } from '../src/encounter/weapons';
import { DEFAULT_PREFS, type DodgeSetup, type EncounterState } from '../src/encounter/types';
import { iatan2, icos, isin, seeded } from '../src/encounter/rng';
import { throwDie } from '../src/dice/physics';

const srd = readPackDir('packs/srd-5e');
const combat = srd.combat!;
const T0 = new Date('2026-10-29T12:00:00Z');

const fighter = {
  method: 'standard', scores: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 }, ranks: {},
  inputs: { level: 1, armor_base: 16, armor_dex_cap: 0, shield: 2 },
  choices: { class: 'fighter', background: 'soldier', species: 'dwarf' },
  picks: { 'class.skills': ['perception', 'survival'], 'class.style': ['defense'], 'background.asi': { str: 2, con: 1 } },
};

/** A table: an open 12×12 map, a fighter (player u1) and whatever monsters, every die showing `die`. */
function table(opts: { die?: number | number[]; monsters?: { id: string; x: number; y: number }[]; walls?: { x: number; y: number; w: number; h: number }[]; prefs?: Partial<typeof DEFAULT_PREFS> } = {}) {
  const dice = Array.isArray(opts.die) ? [...opts.die] : null;
  let n = 0, seed = 1;
  const grid: Grid = { cols: 12, rows: 12, cellDistance: 5, rule: 'chebyshev' };
  const tokens = new Map<string, TokenInfo>();
  tokens.set('t-hero', { id: 't-hero', name: '灰鴉', x: 2, y: 5, size: 1, elevation: 0, hidden: false, characterId: 'c1', ownerUserId: 'u1' });
  for (const [i, m] of (opts.monsters ?? []).entries()) tokens.set(`t-m${i}`, { id: `t-m${i}`, name: m.id, x: m.x, y: m.y, size: 1, elevation: 0, hidden: false, characterId: null, ownerUserId: 'gm' });
  const ctx: Ctx = {
    pack: srd, combat, patterns: combat.patterns, now: T0,
    rng: (sides: number) => Math.min(sides, dice ? (dice.shift() ?? 10) : (opts.die as number ?? 10)),
    id: () => `id${++n}`, seed: () => seed++, grid,
    blocks: blockMap(grid, (opts.walls ?? []).map((w) => ({ kind: 'wall' as const, ...w }))),
    tokens, sheets: new Map([['c1', computeSheet(srd, fighter)]]),
    prefs: () => ({ ...DEFAULT_PREFS, ...opts.prefs }), name: (u) => u,
  };
  return ctx;
}
const P1 = { userId: 'u1', gm: false }, GM = { userId: 'gm1', gm: true };
const entries = (ctx: Ctx) => [...ctx.tokens.values()].map((t) => (t.characterId ? { tokenId: t.id } : { tokenId: t.id, monsterId: t.name }));
const run = (o: Outcome, ctx: Ctx, who: typeof P1, cmd: Command) => runCommand(o.state, ctx, who, cmd);
const heroId = (s: EncounterState) => Object.values(s.combatants).find((c) => c.characterId)!.id;
const foeId = (s: EncounterState, i = 0) => Object.values(s.combatants).filter((c) => !c.characterId)[i].id;

describe('deterministic maths', () => {
  it('sin, cos and atan2 come from a table and agree with each other', () => {
    expect(isin(64)).toBe(16384);
    expect(icos(0)).toBe(16384);
    expect(iatan2(1, 0)).toBe(64);
    expect(iatan2(0, -1)).toBe(128);
    const a = seeded(42), b = seeded(42);
    expect([a.int(100), a.int(100), a.int(100)]).toEqual([b.int(100), b.int(100), b.int(100)]);
  });
});

describe('model B and damage', () => {
  it('picks the tier by margin, and a critical always takes the worst', () => {
    expect(tierFor(DEFAULT_RULES, 7).label).toBe('壓制');
    expect(tierFor(DEFAULT_RULES, 1).label).toBe('優勢');
    expect(tierFor(DEFAULT_RULES, 0).label).toBe('均勢');
    expect(tierFor(DEFAULT_RULES, -2).label).toBe('均勢');
    expect(tierFor(DEFAULT_RULES, -6).label).toBe('劣勢');
    expect(tierFor(DEFAULT_RULES, -7).label).toBe('危急');
    expect(tierFor(DEFAULT_RULES, 9, true).label).toBe('危急');
  });
  it('scales damage by hits, rounding down, at least 1', () => {
    expect(factorFor(DEFAULT_RULES, 0)).toBe(0.5);
    expect(factorFor(DEFAULT_RULES, 9)).toBe(1.25);
    expect(scaledDamage(7, 0.5)).toBe(3);
    expect(scaledDamage(1, 0.5)).toBe(1);
    expect(scaledDamage(0, 1.25)).toBe(0);
    expect(scaledDamage(9, 1.1)).toBe(9);
    expect(bonusFor(DEFAULT_RULES, 0.95)).toBe(2);
    expect(bonusFor(DEFAULT_RULES, 0.6)).toBe(1);
    expect(bonusFor(DEFAULT_RULES, 0.59)).toBe(0);
    expect(healthWords(3, 10, false)).toBe('重傷');
  });
});

describe('the dodge', () => {
  const setup = (tier = DEFAULT_RULES.tiers[2], pattern = combat.patterns[0]): DodgeSetup => ({ tier, duration: tier.duration, pattern, reduced: false, damage: 8 });

  it('replays the same hits from the same seed and moves, on every run', () => {
    for (const p of combat.patterns) {
      const s = setup(DEFAULT_RULES.tiers[2], p);
      const moves = Array.from({ length: 300 }, (_, i) => String((i >> 4) % 9)).join('');
      expect(runDodge(s, 7, moves)).toBe(runDodge(s, 7, moves));
    }
  });

  it('every pack pattern can hit someone who stands still, and the worst tier hits harder than the best', () => {
    let calm = 0, bad = 0;
    for (const p of combat.patterns) {
      for (let seed = 1; seed <= 10; seed++) {
        calm += runDodge(setup(DEFAULT_RULES.tiers[0], p), seed, '');
        bad += runDodge(setup(DEFAULT_RULES.tiers[4], p), seed, '');
      }
      expect([1, 2, 3, 4, 5].reduce((s, seed) => s + runDodge(setup(DEFAULT_RULES.tiers[4], p), seed, ''), 0), p.id).toBeGreaterThan(0);
    }
    expect(bad).toBeGreaterThan(calm);
  });

  it('keeps the knot inside the box', () => {
    const sim = new DodgeSim(setup(DEFAULT_RULES.tiers[4]), 3);
    for (let i = 0; i < 400; i++) sim.step(3);
    expect(sim.x / 1000).toBeLessThanOrEqual(sim.box.o + sim.box.side);
  });

  it('rejects moves that are not digits or too long', () => {
    const s = setup();
    expect(validMoves('0123', s)).toBe(true);
    expect(validMoves('9', s)).toBe(false);
    expect(validMoves('1'.repeat(301), s)).toBe(false);
    expect(validMoves(5, s)).toBe(false);
  });

  it('picks a pattern from the creature list by seed, falling back to anything known', () => {
    expect(pickPattern(['snipe'], combat.patterns, 5).id).toBe('snipe');
    expect(combat.patterns.map((p) => p.id)).toContain(pickPattern(['nope'], combat.patterns, 5).id);
  });
});

describe('weapon gestures', () => {
  it('a clean slash along the line scores high; a scribble scores low', () => {
    const c = challengeFor('slash', 11)!;
    if (c.kind !== 'slash') throw new Error();
    const samples = Array.from({ length: 11 }, (_, i) => ({ t: 100 + i * 40, x: Math.round(c.a.x + ((c.b.x - c.a.x) * i) / 10), y: Math.round(c.a.y + ((c.b.y - c.a.y) * i) / 10), d: 1 as const }));
    expect(scoreGesture(c, { kind: 'pointer', samples })).toBeGreaterThanOrEqual(0.9);
    expect(scoreGesture(c, { kind: 'pointer', samples: [{ t: 0, x: 0, y: 0, d: 1 }, { t: 50, x: 10, y: 990, d: 1 }] })).toBeLessThan(0.3);
  });
  const line = (pts: { x: number; y: number }[], t0: number, dt: number) => pts.map((p, i) => ({ t: t0 + i * dt, x: Math.round(p.x), y: Math.round(p.y), d: 1 as const }));
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, n: number) => Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
  it('every weapon kind: doing it right scores high, doing it wrong scores low', () => {
    const good: Record<string, number> = {}, bad: Record<string, number> = {};
    for (const seed of [3, 8, 21]) {
      const th = challengeFor('thrust', seed)!; if (th.kind !== 'thrust') throw new Error();
      good.thrust = scoreGesture(th, { kind: 'pointer', samples: line(lerp(th.from, th.to, 6), 0, 30) });
      bad.thrust = scoreGesture(th, { kind: 'pointer', samples: line(lerp(th.to, th.from, 6), 0, 30) });
      const sm = challengeFor('smash', seed)!; if (sm.kind !== 'smash') throw new Error();
      good.smash = scoreGesture(sm, { kind: 'pointer', samples: [...line(lerp(sm.start, { x: sm.start.x, y: sm.raise - 20 }, 6), 0, 60), ...line(lerp({ x: sm.start.x, y: sm.raise - 20 }, sm.target, 4), 400, 40)] });
      bad.smash = scoreGesture(sm, { kind: 'pointer', samples: line(lerp(sm.start, sm.target, 4), 0, 40) });
      const la = challengeFor('lash', seed)!; if (la.kind !== 'lash') throw new Error();
      good.lash = scoreGesture(la, { kind: 'pointer', samples: line(la.points, 0, 30) });
      bad.lash = scoreGesture(la, { kind: 'pointer', samples: line(lerp({ x: 100, y: 950 }, { x: 900, y: 950 }, 10), 0, 60) });
      const dr = challengeFor('draw', seed)!; if (dr.kind !== 'draw') throw new Error();
      // Grab the string, pull straight away from the target to full draw, let go at once.
      const away = { x: dr.bow.x - dr.target.x, y: dr.bow.y - dr.target.y }, n = Math.hypot(away.x, away.y);
      const back = { x: dr.bow.x + (away.x / n) * (dr.full + 10), y: dr.bow.y + (away.y / n) * (dr.full + 10) };
      good.draw = scoreGesture(dr, { kind: 'pointer', samples: line(lerp(dr.bow, back, 8), 0, 40) });
      bad.draw = scoreGesture(dr, { kind: 'pointer', samples: line(lerp(dr.bow, { x: dr.bow.x + 40, y: dr.bow.y + 30 }, 3), 0, 40) });
      const ai = challengeFor('aim', seed)!; if (ai.kind !== 'aim') throw new Error();
      // A good shot leans against the sway at the moment of release.
      const sway = swayAt(ai, 250);
      const shift = { x: ai.target.x - ai.sight.x - sway.x, y: ai.target.y - ai.sight.y - sway.y };
      good.aim = scoreGesture(ai, { kind: 'pointer', samples: line(lerp({ x: 500, y: 500 }, { x: 500 + shift.x, y: 500 + shift.y }, 5), 0, 50) });
      bad.aim = scoreGesture(ai, { kind: 'pointer', samples: line([{ x: 500, y: 500 }], 0, 50) });
      const tw = challengeFor('throw', seed)!; if (tw.kind !== 'throw') throw new Error();
      good.throw = scoreGesture(tw, { kind: 'pointer', samples: line(lerp(tw.hand, { x: tw.hand.x + (tw.target.x - tw.hand.x) * 0.5, y: tw.hand.y + (tw.target.y - tw.hand.y) * 0.5 }, 5), 0, 25) });
      bad.throw = scoreGesture(tw, { kind: 'pointer', samples: line(lerp(tw.hand, { x: tw.hand.x + 300, y: tw.hand.y }, 5), 0, 25) });
      const ru = challengeFor('rune', seed, 5)!; if (ru.kind !== 'rune') throw new Error();
      const circle = Array.from({ length: 41 }, (_, i) => ({ x: ru.centre.x + Math.cos((i / 40) * Math.PI * 2) * ru.r, y: ru.centre.y + Math.sin((i / 40) * Math.PI * 2) * ru.r }));
      const sigil = ru.points.flatMap((p, i) => (i ? lerp(ru.points[i - 1], p, 6).slice(1) : [p]));
      good.rune = scoreGesture(ru, { kind: 'pointer', samples: [...line(circle, 0, 30), { t: 1300, x: 0, y: 0, d: 0 as const }, ...line(sigil, 1400, 30)] });
      bad.rune = scoreGesture(ru, { kind: 'pointer', samples: line([...ru.points].reverse(), 0, 200) });
      for (const k of Object.keys(good)) {
        expect(good[k], `${k} done right (seed ${seed})`).toBeGreaterThanOrEqual(0.85);
        expect(bad[k], `${k} done wrong (seed ${seed})`).toBeLessThan(0.45);
      }
    }
  });
  it('the one-key form scores by timing', () => {
    const c = challengeFor('thrust', 4)!;
    expect(scoreGesture(c, { kind: 'keys', presses: [{ t: c.beat, key: ' ' }] })).toBe(1);
    expect(scoreGesture(c, { kind: 'keys', presses: [{ t: c.beat + 1000, key: ' ' }] })).toBe(0);
  });
  it('refuses input no pointer could make', () => {
    expect(wellFormed({ kind: 'pointer', samples: [{ t: 10, x: 0, y: 0, d: 1 }, { t: 5, x: 0, y: 0, d: 1 }] })).toBe(false);
    expect(wellFormed({ kind: 'pointer', samples: [{ t: 10, x: 0.5, y: 0, d: 1 }] })).toBe(false);
    expect(wellFormed({ kind: 'keys', presses: [{ t: 99999, key: ' ' }] })).toBe(false);
  });
});

describe('grid geometry', () => {
  const grid: Grid = { cols: 10, rows: 10, cellDistance: 5, rule: 'chebyshev' };
  it('measures between footprints and through height', () => {
    expect(feetBetween(grid, { x: 0, y: 0, size: 1 }, { x: 1, y: 1, size: 1 })).toBe(5);
    expect(feetBetween(grid, { x: 0, y: 0, size: 1 }, { x: 3, y: 0, size: 2 })).toBe(15);
    expect(feetBetween({ ...grid, rule: 'alternate' }, { x: 0, y: 0, size: 1 }, { x: 2, y: 2, size: 1 })).toBe(15);
    expect(feetBetween(grid, { x: 0, y: 0, size: 1, elevation: 0 }, { x: 0, y: 0, size: 1, elevation: 20 })).toBe(20);
  });
  it('walls block sight and walking; open doors do not', () => {
    const wall = blockMap(grid, [{ kind: 'wall', x: 5, y: 0, w: 1, h: 10 }]);
    expect(canSee(grid, wall, { x: 2, y: 5, size: 1 }, { x: 8, y: 5, size: 1 })).toBe(false);
    expect(walkCost(grid, wall, { x: 2, y: 5, size: 1 }, { x: 8, y: 5 }, [])).toBeNull();
    const door = blockMap(grid, [{ kind: 'wall', x: 5, y: 0, w: 1, h: 4 }, { kind: 'door', x: 5, y: 4, w: 1, h: 1, open: true }, { kind: 'wall', x: 5, y: 5, w: 1, h: 5 }]);
    expect(walkCost(grid, door, { x: 2, y: 4, size: 1 }, { x: 8, y: 4 }, [])).toBe(30);
    expect(walkCost(grid, blockMap(grid, []), { x: 0, y: 0, size: 1 }, { x: 3, y: 3 }, [{ x: 1, y: 1, size: 1 }])).toBe(20);
  });
  it('a 15 ft cone covers the squares in front of the caster', () => {
    const cells = areaCells(grid, { kind: 'cone', size: 15 }, { x: 0, y: 4, size: 1 }, { x: 3, y: 4 });
    expect(cells).toContainEqual({ x: 1, y: 4 });
    expect(cells).toContainEqual({ x: 3, y: 5 });
    expect(cells).not.toContainEqual({ x: 0, y: 4 });
    expect(cells).not.toContainEqual({ x: 1, y: 7 });
  });
});

describe('the encounter: dice first, then interaction', () => {
  it('rolls initiative by hand for players and at once for monsters, then starts turns', () => {
    const ctx = table({ monsters: [{ id: 'goblin', x: 3, y: 5 }] });
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx));
    expect(o.state.status).toBe('initiative');
    expect(o.state.step).toMatchObject({ kind: 'initiative', awaiting: ['u1'] });
    expect(o.state.combatants[foeId(o.state)].initiative).not.toBeNull();
    o = run(o, ctx, P1, { type: 'release', stepId: o.state.step!.id });
    expect(o.state.status).toBe('active');
    expect(o.state.order).toHaveLength(2);
  });

  it('a player attack: roll → gesture → hit → damage, and the monster takes it (GM creatures do not dodge)', () => {
    const ctx = table({ die: 12, monsters: [{ id: 'goblin', x: 3, y: 5 }] });
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx));
    o = run(o, ctx, P1, { type: 'release', stepId: o.state.step!.id });
    // Make it the hero's turn whatever the order.
    if (o.state.turn!.combatantId !== heroId(o.state)) o = run(o, ctx, GM, { type: 'gm', op: { kind: 'nextTurn' } });
    const hero = heroId(o.state), gob = foeId(o.state);
    o = run(o, ctx, P1, { type: 'attack', combatantId: hero, source: { kind: 'weapon', id: 'longsword' }, targets: [gob] });
    expect(o.state.step?.kind).toBe('attackRoll');
    o = run(o, ctx, P1, { type: 'release', stepId: o.state.step!.id });
    // The dice are on the table before the gesture opens.
    expect(o.state.flow?.roll?.total).toBeGreaterThan(0);
    expect(o.state.step?.kind).toBe('attackInteract');
    o = run(o, ctx, P1, { type: 'gesture', stepId: o.state.step!.id, input: { kind: 'keys', presses: [] } });
    expect(o.state.flow).toBeNull();
    const g = o.state.combatants[gob];
    expect(g.hp).toBeLessThan(g.maxHp);
    expect(o.events.some((e) => e.kind === 'resolved' && e.log)).toBe(true);
  });

  it('a monster hit on a player: attack and damage rolled first, then the dodge decides the multiplier', () => {
    const ctx = table({ die: 15, monsters: [{ id: 'goblin', x: 3, y: 5 }] });
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx));
    o = run(o, ctx, P1, { type: 'release', stepId: o.state.step!.id });
    if (o.state.turn!.combatantId !== foeId(o.state)) o = run(o, ctx, GM, { type: 'gm', op: { kind: 'nextTurn' } });
    const hero = heroId(o.state), gob = foeId(o.state);
    const atk = combat.monsters.find((m) => m.id === 'goblin')!.attacks[0];
    o = run(o, ctx, GM, { type: 'attack', combatantId: gob, source: { kind: 'monster', id: atk.id }, targets: [hero] });
    expect(o.state.flow?.roll).toBeDefined();
    expect(o.state.flow?.results[0].damage?.total).toBeGreaterThan(0);
    const st = o.state.step!;
    expect(st.kind).toBe('dodge');
    // A goblin is a minion: a short dodge.
    expect(st.dodge!.duration).toBeLessThanOrEqual(DEFAULT_RULES.shortDodgeMs);
    expect(() => runCommand(o.state, ctx, P1, { type: 'dodge', stepId: st.id, moves: '' })).toThrow('閃避還沒開始');
    o = run(o, ctx, P1, { type: 'begin', stepId: st.id });
    expect(() => runCommand(o.state, ctx, P1, { type: 'begin', stepId: st.id })).toThrow(CombatError);
    const before = o.state.combatants[hero].hp;
    const hits = runDodge(o.state.step!.dodge!, o.state.step!.seed, '');
    const dmg = o.state.flow!.results[0].damage!.total;
    o = run(o, ctx, P1, { type: 'dodge', stepId: st.id, moves: '' });
    expect(before - o.state.combatants[hero].hp).toBe(Math.min(before, scaledDamage(dmg, factorFor(DEFAULT_RULES, hits))));
    expect(o.vitals[0]).toMatchObject({ characterId: 'c1' });
  });

  it('a dodge left alone times out to plain dice damage', () => {
    const ctx = table({ die: 15, monsters: [{ id: 'goblin', x: 3, y: 5 }] });
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx));
    o = run(o, ctx, P1, { type: 'release', stepId: o.state.step!.id });
    if (o.state.turn!.combatantId !== foeId(o.state)) o = run(o, ctx, GM, { type: 'gm', op: { kind: 'nextTurn' } });
    o = run(o, ctx, GM, { type: 'attack', combatantId: foeId(o.state), source: { kind: 'monster', id: combat.monsters.find((m) => m.id === 'goblin')!.attacks[0].id }, targets: [heroId(o.state)] });
    const dmg = o.state.flow!.results[0].damage!.total, hp = o.state.combatants[heroId(o.state)].hp;
    expect(runClock(o.state, ctx)).toBeNull();
    const later = runClock(o.state, { ...ctx, now: new Date(T0.getTime() + 31000) })!;
    expect(hp - later.state.combatants[heroId(o.state)].hp).toBe(Math.min(hp, dmg));
  });

  it('quick mode skips every interaction', () => {
    const ctx = table({ die: 15, monsters: [{ id: 'goblin', x: 3, y: 5 }] });
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx), { mode: 'quick' });
    expect(o.state.status).toBe('active');
    if (o.state.turn!.combatantId !== heroId(o.state)) o = run(o, ctx, GM, { type: 'gm', op: { kind: 'nextTurn' } });
    o = run(o, ctx, P1, { type: 'attack', combatantId: heroId(o.state), source: { kind: 'weapon', id: 'longsword' }, targets: [foeId(o.state)] });
    expect(o.state.step).toBeNull();
    expect(o.state.flow).toBeNull();
  });

  it('save attacks: damage once, each target saves by hand, then dodges', () => {
    const ctx = table({ die: 5, monsters: [{ id: 'young_red_dragon', x: 4, y: 5 }] });
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx));
    o = run(o, ctx, P1, { type: 'release', stepId: o.state.step!.id });
    if (o.state.turn!.combatantId !== foeId(o.state)) o = run(o, ctx, GM, { type: 'gm', op: { kind: 'nextTurn' } });
    const breath = combat.monsters.find((m) => m.id === 'young_red_dragon')!.attacks.find((a) => a.save && a.area)!;
    o = run(o, ctx, GM, { type: 'attack', combatantId: foeId(o.state), source: { kind: 'monster', id: breath.id }, targets: [], point: { x: 2, y: 5 } });
    expect(o.state.step?.kind).toBe('saveRoll');
    expect(o.state.flow?.results[0].damage?.total).toBeGreaterThan(0);
    o = run(o, ctx, P1, { type: 'release', stepId: o.state.step!.id });
    expect(o.state.flow?.results[0].save?.success).toBe(false);
    expect(o.state.step?.kind).toBe('dodge');
    // Failed by a lot: the worst tiers.
    expect(['劣勢', '危急']).toContain(o.state.step!.dodge!.tier.label);
  });

  it('enforces range, sight and the action economy', () => {
    const ctx = table({ die: 12, monsters: [{ id: 'goblin', x: 9, y: 5 }], walls: [{ x: 6, y: 0, w: 1, h: 12 }] });
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx), { mode: 'quick' });
    if (o.state.turn!.combatantId !== heroId(o.state)) o = run(o, ctx, GM, { type: 'gm', op: { kind: 'nextTurn' } });
    const hero = heroId(o.state), gob = foeId(o.state);
    expect(() => run(o, ctx, P1, { type: 'attack', combatantId: hero, source: { kind: 'weapon', id: 'longsword' }, targets: [gob] })).toThrow('超出觸及');
    expect(() => run(o, ctx, P1, { type: 'attack', combatantId: hero, source: { kind: 'weapon', id: 'longbow' }, targets: [gob] })).toThrow('看不到');
    expect(() => run(o, ctx, { userId: 'u2', gm: false }, { type: 'endTurn', combatantId: hero })).toThrow('只能操作自己的角色');
    // Walking: 30 ft, the wall in the way.
    expect(() => runMove(o.state, ctx, P1, 't-hero', { x: 9, y: 4 })).toThrow('走不到');
    o = runMove(o.state, ctx, P1, 't-hero', { x: 5, y: 5 });
    expect(o.state.turn!.movementUsed).toBe(15);
    expect(() => runMove(o.state, ctx, P1, 't-hero', { x: 5, y: 11 })).toThrow('走不到');
  });

  it('GMs can pause, force a result, and every override is logged', () => {
    const ctx = table({ die: 15, monsters: [{ id: 'goblin', x: 3, y: 5 }] });
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx));
    o = run(o, ctx, P1, { type: 'release', stepId: o.state.step!.id });
    if (o.state.turn!.combatantId !== foeId(o.state)) o = run(o, ctx, GM, { type: 'gm', op: { kind: 'nextTurn' } });
    o = run(o, ctx, GM, { type: 'attack', combatantId: foeId(o.state), source: { kind: 'monster', id: combat.monsters.find((m) => m.id === 'goblin')!.attacks[0].id }, targets: [heroId(o.state)] });
    o = run(o, ctx, GM, { type: 'gm', op: { kind: 'pause' }, reason: '玩家斷線' });
    expect(o.state.status).toBe('paused');
    expect(o.events[0]).toMatchObject({ kind: 'override', log: true });
    expect(o.events[0].text).toContain('玩家斷線');
    expect(() => run(o, ctx, P1, { type: 'begin', stepId: o.state.step!.id })).toThrow('暫停');
    o = run(o, ctx, GM, { type: 'gm', op: { kind: 'resume' } });
    const dmg = o.state.flow!.results[0].damage!.total, hp = o.state.combatants[heroId(o.state)].hp;
    o = run(o, ctx, GM, { type: 'gm', op: { kind: 'force', hits: 0 } });
    expect(hp - o.state.combatants[heroId(o.state)].hp).toBe(scaledDamage(dmg, 0.5));
  });

  it('NPCs on autopilot walk up and attack by themselves', () => {
    const ctx = table({ die: 15, monsters: [{ id: 'goblin', x: 7, y: 5 }] });
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx), { autoNpc: true });
    o = run(o, ctx, P1, { type: 'release', stepId: o.state.step!.id });
    if (o.state.turn!.combatantId === heroId(o.state)) o = run(o, ctx, P1, { type: 'endTurn', combatantId: heroId(o.state) });
    expect(o.state.step?.kind).toBe('npcPending');
    o = runClock(o.state, { ...ctx, now: new Date(T0.getTime() + 4000) })!;
    expect(o.moves.length).toBeGreaterThan(0);
    // It walked up and swung; the player now has a dodge to do.
    expect(o.state.step?.kind).toBe('dodge');
  });

  it('players do not see hidden creatures or enemy numbers', () => {
    const ctx = table({ monsters: [{ id: 'goblin', x: 3, y: 5 }, { id: 'ogre', x: 8, y: 8 }] });
    const o = createEncounter(ctx, 'r1', 'm1', [{ tokenId: 't-hero' }, { tokenId: 't-m0', monsterId: 'goblin' }, { tokenId: 't-m1', monsterId: 'ogre', hidden: true }]);
    const v = viewFor(o.state, 'u1', false, DEFAULT_PREFS);
    expect(Object.keys(v.combatants)).toHaveLength(2);
    const gob = Object.values(v.combatants).find((c) => c.monsterId === 'goblin')!;
    expect(gob.hp).toBeNull();
    expect(gob.ac).toBeNull();
    expect(gob.health).toBe('毫髮無傷');
    expect(Object.keys(viewFor(o.state, 'gm1', true, DEFAULT_PREFS).combatants)).toHaveLength(3);
  });

  it('a player at 0 HP makes death saves on their turn', () => {
    const ctx = table({ die: 15, monsters: [{ id: 'goblin', x: 3, y: 5 }] });
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx), { mode: 'quick' });
    o = run(o, ctx, GM, { type: 'gm', op: { kind: 'hp', combatantId: heroId(o.state), hp: 0 } });
    // Quick mode rolls by itself; walk round to the hero's turn.
    for (let i = 0; i < 3 && o.state.combatants[heroId(o.state)].dying?.successes !== 1; i++) o = run(o, ctx, GM, { type: 'gm', op: { kind: 'nextTurn' } });
    expect(o.state.combatants[heroId(o.state)].dying?.successes).toBeGreaterThanOrEqual(1);
  });
});

describe('teams and the end of a fight', () => {
  it('ends by itself when the last enemy falls, instead of going round forever', () => {
    const ctx = table({ die: 20, monsters: [{ id: 'goblin', x: 3, y: 5 }] });
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx), { mode: 'quick' });
    if (o.state.step) o = run(o, ctx, P1, { type: 'release', stepId: o.state.step.id });
    o = run(o, ctx, GM, { type: 'gm', op: { kind: 'hp', combatantId: foeId(o.state), hp: 0 } });
    expect(o.state.status).toBe('ended');
    expect(o.state.outcome?.winner).toBe('我方');
    expect(o.events.some((e) => e.kind === 'victory' && e.text.includes('我方 獲勝'))).toBe(true);
  });

  it('three teams: goblins and bandits fight each other too, and the fight runs until one team is left', () => {
    const ctx = table({ die: 20, monsters: [{ id: 'goblin', x: 3, y: 5 }, { id: 'bandit', x: 8, y: 8 }] });
    let o = createEncounter(ctx, 'r1', 'm1', [{ tokenId: 't-hero' }, { tokenId: 't-m0', monsterId: 'goblin', team: '哥布林' }, { tokenId: 't-m1', monsterId: 'bandit', team: '盜賊' }], { mode: 'quick' });
    if (o.state.step) o = run(o, ctx, P1, { type: 'release', stepId: o.state.step.id });
    const [gob, ban] = [foeId(o.state, 0), foeId(o.state, 1)];
    expect(o.state.combatants[gob].team).toBe('哥布林');
    o = run(o, ctx, GM, { type: 'gm', op: { kind: 'hp', combatantId: gob, hp: 0 } });
    expect(o.state.status).toBe('active');
    o = run(o, ctx, GM, { type: 'gm', op: { kind: 'team', combatantId: ban, team: '我方' } });
    expect(o.state.status).toBe('ended');
    expect(o.state.outcome?.winner).toBe('我方');
  });

  it('a single-team fight never ends by itself, and the GM can switch auto-end off', () => {
    const ctx = table({ die: 20, monsters: [{ id: 'goblin', x: 3, y: 5 }] });
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx), { mode: 'quick', autoEnd: false });
    if (o.state.step) o = run(o, ctx, P1, { type: 'release', stepId: o.state.step.id });
    o = run(o, ctx, GM, { type: 'gm', op: { kind: 'hp', combatantId: foeId(o.state), hp: 0 } });
    expect(o.state.status).toBe('active');
  });
});

describe('fine dodge input', () => {
  const setup = (): DodgeSetup => ({ tier: DEFAULT_RULES.tiers[2], duration: DEFAULT_RULES.tiers[2].duration, pattern: combat.patterns[0], reduced: false, damage: 8 });
  it('accepts ~-prefixed recordings, replays them the same every time, and old digit recordings still work', () => {
    const s = setup();
    const fine = '~' + Array.from({ length: 200 }, (_, i) => FINE_ALPHABET[(i >> 3) % 64]).join('') + '...';
    expect(validMoves(fine, s)).toBe(true);
    expect(validMoves('~!', s)).toBe(false);
    expect(validMoves('~' + 'A'.repeat(301), s)).toBe(false);
    expect(runDodge(s, 9, fine)).toBe(runDodge(s, 9, fine));
    expect(validMoves('0123', s)).toBe(true);
  });
  it('moves 32 ways at full or half speed, half going half as far', () => {
    const a = new DodgeSim(setup(), 1, true), b = new DodgeSim(setup(), 1, true);
    const x0 = a.x;
    a.stepFine(fineChar(-1, 0, false));
    b.stepFine(fineChar(-1, 0, true));
    expect(x0 - a.x).toBe(a.reach);
    expect(x0 - b.x).toBe(Math.trunc(a.reach / 2));
    expect(fineChar(0, 0, false)).toBe('.');
    expect(fineChar(1, 1, false)).toBe(FINE_ALPHABET[4]);
  });
});

describe('physical dice in a fight', () => {
  it('with the tray physics, every die is a real throw: replaying its toss lands on the number the server used', () => {
    const ctx = table({ monsters: [{ id: 'goblin', x: 3, y: 5 }] });
    let n = 0;
    ctx.toss = (sides, launch, lane) => { const toss = { seed: 9000 + ++n * 31, lane, ...(launch ? { launch } : {}) }; return { value: throwDie(sides, toss), toss }; };
    let o = createEncounter(ctx, 'r1', 'm1', entries(ctx));
    o = run(o, ctx, P1, { type: 'release', stepId: o.state.step!.id, launch: { hand: [-3, 1], v: [14, -2] } });
    const init = o.events.find((e) => e.kind === 'initiative' && (e.data as { combatantId: string }).combatantId === heroId(o.state))!;
    const faces = (init.data as { dice: { sides: number; value: number; toss?: { seed: number; lane: number; launch?: unknown } }[] }).dice;
    expect(faces).toHaveLength(1);
    expect(faces[0].toss?.launch).toEqual({ hand: [-3, 1], v: [14, -2] });
    expect(throwDie(20, faces[0].toss as never)).toBe(faces[0].value);
  });
});

describe('map templates', () => {
  it('every template fits its grid, stays under the object limit and keeps doors out of walls, for many seeds', async () => {
    const { MAP_TEMPLATES, buildTemplate } = await import('../src/table/templates');
    const { MAP_LIMITS } = await import('../src/table/maps');
    const { MAP_OBJECT_KINDS } = await import('../src/table/types');
    expect(MAP_TEMPLATES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(MAP_TEMPLATES.map((t) => t.id)).size).toBe(MAP_TEMPLATES.length);
    for (const t of MAP_TEMPLATES) for (const seed of [1, 2, 3, 99, 12345]) {
      const b = buildTemplate(t, seed);
      expect(b.objects.length, t.id).toBeLessThanOrEqual(MAP_LIMITS.objects);
      for (const o of b.objects) {
        expect(MAP_OBJECT_KINDS).toContain(o.kind);
        expect(o.x >= 0 && o.y >= 0 && o.x + o.w <= b.cols && o.y + o.h <= b.rows, `${t.id} ${o.kind}`).toBe(true);
      }
      const walls = b.objects.filter((o) => o.kind === 'wall' || o.kind === 'fence');
      for (const d of b.objects.filter((o) => o.kind === 'door' || o.kind === 'gate')) {
        expect(walls.some((w) => d.x < w.x + w.w && w.x < d.x + d.w && d.y < w.y + w.h && w.y < d.y + d.h), `${t.id} door at ${d.x},${d.y}`).toBe(false);
      }
    }
  });
});
