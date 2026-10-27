import { describe, expect, it } from 'vitest';
import seed from '../config/world-seed.json';
import { RULES_V03 } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import type { AttributeCode } from '../src/rules/types';
import { applyWorld, createWorld, joinWorld, nearestOutpost, pvpLegality, type WorldSeed } from '../src/world/engine';
import type { WorldActor, WorldCommand, WorldEvent, WorldState } from '../src/world/types';
import { canSee, historyFor, viewFor } from '../src/world/view';

const R = RULES_V03;
const T0 = new Date('2026-10-27T12:00:00Z');
const attrs = (o: Partial<Record<AttributeCode, number>> = {}): Record<AttributeCode, number> =>
  ({ STR: 1, AGI: 1, VIT: 1, PRE: 1, PER: 1, INT: 1, WIL: 1, CHA: 1, INS: 1, SPR: 1, ...o });

const U1: WorldActor = { userId: 'u1', role: 'player' };
const U2: WorldActor = { userId: 'u2', role: 'player' };
const MAIN: WorldActor = { userId: 'gm-main', role: 'gm' };
const SCENE: WorldActor = { userId: 'gm-ruins', role: 'gm' };
const ARB: WorldActor = { userId: 'gm-arb', role: 'gm' };

/** 灰鴉 (u1) and 夜鶯 (u2, a thief) both standing at `where`. */
function world(where = 'ruins', where2 = where): WorldState {
  let s = createWorld(seed as WorldSeed, {
    'gm-main': { role: 'main' }, 'gm-ruins': { role: 'scene', locations: ['ruins'] }, 'gm-arb': { role: 'arbiter' },
  });
  s = joinWorld(s, { id: 'crow', ownerUserId: 'u1', name: '灰鴉', attributes: attrs({ PER: 2, STR: 3 }), skills: { scouting: 1, melee: 3 }, coins: 50 }, where);
  s = joinWorld(s, { id: 'nightingale', ownerUserId: 'u2', name: '夜鶯', attributes: attrs({ AGI: 3, PRE: 3, INT: 2, PER: 3 }), skills: { stealth: 3, lockpicking: 3, scouting: 3 } }, where2);
  return s;
}

const run = (s: WorldState, actor: WorldActor, command: WorldCommand, rolls: number[] = [], now = T0, expected?: Record<string, number>) =>
  applyWorld(s, { actor, command, expected }, R, scriptedRng(rolls), now);

describe('unique items', () => {
  it('moves the one item entity: once taken it is gone from the ruins for everyone', () => {
    const s = world();
    const a = run(s, U1, { type: 'take', characterId: 'crow', itemId: 'bell-heart' });
    expect(a.state.items['bell-heart'].holder).toEqual({ type: 'character', id: 'crow' });
    expect(Object.keys(a.state.items)).toHaveLength(Object.keys(s.items).length); // moved, never copied
    expect(() => run(a.state, U2, { type: 'take', characterId: 'nightingale', itemId: 'bell-heart' })).toThrow(/不在這裡/);
  });

  it('rejects a command made on a stale view of the item', () => {
    const s = world();
    const seen = s.items['bell-heart'].version;
    const a = run(s, U1, { type: 'take', characterId: 'crow', itemId: 'bell-heart' });
    expect(() => run(a.state, U2, { type: 'take', characterId: 'nightingale', itemId: 'bell-heart' }, [], T0, { 'bell-heart': seen })).toThrow(/重新讀取/);
  });

  it('a non-tradable item binds to whoever takes it and cannot be given away', () => {
    let s = world('plaza');
    s = run(s, U1, { type: 'take', characterId: 'crow', itemId: 'oath-ring' }).state;
    expect(s.items['oath-ring'].boundTo).toBe('crow');
    expect(() => run(s, U1, { type: 'give', characterId: 'crow', itemId: 'oath-ring', to: 'nightingale' })).toThrow(/綁定/);
  });

  it('a destroyed unique item is public news and can never be taken again', () => {
    let s = world();
    s = run(s, SCENE, { type: 'gmItemStatus', itemId: 'bell-heart', status: 'destroyed', basis: '鐘樓倒塌' }).state;
    expect(() => run(s, U1, { type: 'take', characterId: 'crow', itemId: 'bell-heart' })).toThrow(/摧毀/);
    expect(() => run(s, MAIN, { type: 'gmItemStatus', itemId: 'bell-heart', status: 'present', basis: 'x' })).toThrow(/摧毀/);
  });
});

describe('hidden information', () => {
  it('a hidden item cannot be taken until found, and only the finder learns of it', () => {
    let s = world();
    expect(() => run(s, U1, { type: 'take', characterId: 'crow', itemId: 'old-map' })).toThrow(/不在這裡/);
    expect(viewFor(s, U1).items['old-map']).toBeUndefined();
    const r = run(s, U1, { type: 'search', characterId: 'crow' }, [12]); // 12 + PER 2 + scouting 1 = 15 ≥ 14
    s = r.state;
    expect(s.items['old-map'].discoveredBy).toEqual(['crow']);
    const found = r.events.find((e) => e.kind === 'searchResult')!;
    expect(found).toMatchObject({ visibility: 'private', audience: ['crow'] });
    expect(canSee(s, U2, found)).toBe(false);
    expect(viewFor(s, U1).items['old-map']).toBeDefined();
    expect(viewFor(s, U2).items['old-map']).toBeUndefined();
    expect(run(s, U1, { type: 'take', characterId: 'crow', itemId: 'old-map' }).state.items['old-map'].holder.id).toBe('crow');
  });

  it('player views never contain GM notes, other inventories or where other players are', () => {
    let s = world('ruins', 'plaza');
    s = run(s, U2, { type: 'take', characterId: 'nightingale', itemId: 'oath-ring' }).state;
    const v = viewFor(s, U1);
    expect(Object.values(v.locations).every((l) => l.gmNotes === '')).toBe(true);
    expect(v.items['oath-ring']).toBeUndefined();
    expect(v.characters.nightingale.locationId).toBe('');
    expect(v.characters.nightingale.skills).toEqual({});
    expect(v.gms).toEqual({});
    expect(viewFor(s, MAIN).locations.plaza.gmNotes).not.toBe('');
  });
});

describe('authorization', () => {
  it('players command only their own living characters', () => {
    const s = world();
    expect(() => run(s, U2, { type: 'move', characterId: 'crow', to: 'road' })).toThrow(/不能操作/);
    expect(() => run(s, U1, { type: 'gmSetLocationState', locationId: 'ruins', key: '鐘樓大門', value: '打開' })).toThrow(/GM 權限/);
  });

  it('claiming to be a GM grants nothing without a grant in the world', () => {
    const s = world();
    expect(() => run(s, { userId: 'u1', role: 'gm' }, { type: 'gmPublish', title: '假消息', body: '...' })).toThrow(/GM 權限/);
  });

  it('a scene GM acts only on assigned locations; an arbiter only on rulings', () => {
    const s = world();
    expect(run(s, SCENE, { type: 'gmSetLocationState', locationId: 'ruins', key: '鐘樓大門', value: '打開' }).state.locations.ruins.state['鐘樓大門']).toBe('打開');
    expect(() => run(s, SCENE, { type: 'gmSetLocationState', locationId: 'market', key: 'x', value: 1 })).toThrow(/被指派/);
    expect(() => run(s, SCENE, { type: 'gmSetZone', locationId: 'ruins', zone: 'safe' })).toThrow(/GM 權限/);
    expect(() => run(s, ARB, { type: 'gmSetNpcStatus', npcId: 'keeper', status: 'dead', basis: 'x' })).toThrow(/GM 權限/);
    expect(() => run(s, U1, { type: 'advanceDay' })).toThrow(/GM 權限/);
  });

  it('a dead NPC cannot be brought back with an ordinary command', () => {
    const s = run(world(), MAIN, { type: 'gmSetNpcStatus', npcId: 'keeper', status: 'dead', basis: 'combat c1' }).state;
    expect(() => run(s, MAIN, { type: 'gmSetNpcStatus', npcId: 'keeper', status: 'alive', basis: 'oops' })).toThrow(/不能用一般操作復活/);
  });

  it('every change is audited with before and after state', () => {
    const r = run(world(), SCENE, { type: 'gmSetLocationState', locationId: 'ruins', key: '鐘樓大門', value: '打開' });
    expect(r.changes[0]).toMatchObject({ entity: 'location', entityId: 'ruins', actor: SCENE, reversible: true });
    expect((r.changes[0].before as any).state['鐘樓大門']).toBe('緊閉');
    expect((r.changes[0].after as any).state['鐘樓大門']).toBe('打開');
  });
});

describe('history visibility', () => {
  const kinds = (es: WorldEvent[]) => es.map((e) => e.kind);

  it('players see public news, scenes they witnessed and messages to them; never GM entries', () => {
    let s = world('ruins', 'plaza');
    const events: WorldEvent[] = [];
    const go = (actor: WorldActor, c: WorldCommand, rolls: number[] = []) => { const r = run(s, actor, c, rolls); s = r.state; events.push(...r.events); };
    go(U1, { type: 'search', characterId: 'crow' }, [2]);
    go(MAIN, { type: 'gmSetNpcStatus', npcId: 'keeper', status: 'dead', basis: '戰鬥 c1' });
    go(MAIN, { type: 'gmPublish', title: '鐘聲', body: '沉鐘遺跡傳來鐘聲。' });
    const crow = historyFor(s, U1, events);
    const nightingale = historyFor(s, U2, events);
    expect(kinds(crow)).toEqual(expect.arrayContaining(['searched', 'searchResult', 'npcDied', 'worldEvent']));
    expect(kinds(crow)).not.toContain('searchRolls');
    expect(kinds(nightingale)).toEqual(['npcDied', 'worldEvent']); // public only: not at the ruins
    expect(kinds(historyFor(s, SCENE, events))).toEqual(expect.arrayContaining(['searchRolls', 'npcDiedBasis']));
    expect(kinds(historyFor(s, ARB, events))).toEqual(['npcDied', 'worldEvent']);
  });
});

describe('PvP legality (approved draft: zones, hostility, afterimage protection)', () => {
  it('is forbidden in a safe zone', () => {
    expect(pvpLegality(world('plaza'), 'crow', 'nightingale', T0)).toMatchObject({ allowed: false, reason: '安全區禁止 PvP' });
  });

  it('needs public hostility declared 60 game minutes earlier in a controlled zone, and is a crime', () => {
    let s = world('market');
    expect(pvpLegality(s, 'crow', 'nightingale', T0).reason).toMatch(/宣告敵意/);
    s = run(s, U1, { type: 'declareHostility', characterId: 'crow', targetId: 'nightingale' }).state;
    expect(pvpLegality(s, 'crow', 'nightingale', T0).reason).toMatch(/還差 60 分鐘/);
    s = run(s, U1, { type: 'wait', characterId: 'crow', minutes: 60 }).state;
    expect(pvpLegality(s, 'crow', 'nightingale', T0)).toMatchObject({ allowed: true, lethal: true, crime: true });
    const r = run(s, U1, { type: 'attack', characterId: 'crow', targetId: 'nightingale' });
    expect(r.pvp).toMatchObject({ attackerId: 'crow', targetId: 'nightingale' });
    expect(r.state.characters.crow.crimes).toEqual([{ locationId: 'market', kind: 'assault', day: 1 }]);
  });

  it('a target who logged off in a safe spot is out of reach; an afterimage can be downed but not killed', () => {
    let s = world('road');
    s = run(s, U2, { type: 'setOnline', characterId: 'nightingale', online: false }).state;
    expect(s.characters.nightingale.afterimageUntil).toBe('2026-10-28T12:00:00.000Z');
    expect(pvpLegality(s, 'crow', 'nightingale', T0)).toMatchObject({ allowed: true, lethal: false });
    // Opting in to lethal PvP does not remove afterimage protection.
    s = run(s, U2, { type: 'setLethalOptIn', characterId: 'nightingale', optIn: true }).state;
    expect(pvpLegality(s, 'crow', 'nightingale', T0).lethal).toBe(false);
    let p = world('plaza');
    p = run(p, U2, { type: 'setOnline', characterId: 'nightingale', online: false }).state;
    expect(p.characters.nightingale.afterimageUntil).toBeUndefined();
  });

  it('an unrescued afterimage returns to the nearest outpost and loses a share of carried coins', () => {
    let s = world('ruins');
    s = run(s, U1, { type: 'setOnline', characterId: 'crow', online: false }).state;
    expect(nearestOutpost(s, 'ruins')).toBe('plaza');
    expect(() => run(s, U1, { type: 'expireAfterimages' })).toThrow(/GM 權限/);
    const early = run(s, MAIN, { type: 'expireAfterimages' }, [], new Date('2026-10-28T11:00:00Z')).state;
    expect(early.characters.crow.locationId).toBe('ruins');
    const r = run(s, MAIN, { type: 'expireAfterimages' }, [], new Date('2026-10-28T12:00:01Z'));
    expect(r.state.characters.crow).toMatchObject({ locationId: 'plaza', coins: 45 });
    expect(r.state.characters.crow.afterimageUntil).toBeUndefined();
  });
});

describe('theft in four checks', () => {
  // nightingale: approach AGI 3 + stealth 3 vs crow's awareness 8 + PER 2 + scouting 1 = 11
  //              grab PRE 3 + lockpicking 3 vs 14; crow notices with PER 2 + scouting 1 vs 8 + 3 + 3 = 14
  //              evidence INT 2 + stealth 3 vs 14
  const robbed = (where: string) => {
    let s = world(where);
    s.items['bell-heart'].holder = { type: 'character', id: 'crow' };
    return s;
  };

  it('is refused in a safe zone and for bound items', () => {
    expect(() => run(robbed('plaza'), U2, { type: 'steal', characterId: 'nightingale', targetId: 'crow', itemId: 'bell-heart' })).toThrow(/禁止偷竊/);
    const s = robbed('road');
    s.items['oath-ring'].holder = { type: 'character', id: 'crow' };
    s.items['oath-ring'].boundTo = 'crow';
    expect(() => run(s, U2, { type: 'steal', characterId: 'nightingale', targetId: 'crow', itemId: 'oath-ring' })).toThrow(/綁定/);
  });

  it('a clean theft of a unique item moves it, tells the victim it is gone, and opens a ruling that locks it', () => {
    const r = run(robbed('road'), U2, { type: 'steal', characterId: 'nightingale', targetId: 'crow', itemId: 'bell-heart' }, [10, 10, 5, 12]);
    const s = r.state;
    expect(s.items['bell-heart'].holder).toEqual({ type: 'character', id: 'nightingale' });
    const ruling = Object.values(s.rulings)[0];
    expect(ruling).toMatchObject({ status: 'open', itemId: 'bell-heart', subjects: ['nightingale', 'crow'] });
    expect(s.items['bell-heart'].lockedBy).toBe(ruling.id);
    const victim = historyFor(s, U1, r.events);
    expect(victim.find((e) => e.kind === 'theftDiscovered')!.text).toBe('你的沉鐘之心不見了，沒有留下任何線索。');
    expect(victim.some((e) => e.kind === 'theft')).toBe(false); // the GM entry with every roll is GM-only
    expect(() => run(s, U2, { type: 'give', characterId: 'nightingale', itemId: 'bell-heart', to: 'crow' })).toThrow(/裁決中/);
    expect(s.characters.nightingale.crimes).toEqual([]); // wilderness: no automatic consequences
  });

  it('an arbiter can overturn the ruling: the item goes back and unlocks', () => {
    const stolen = run(robbed('road'), U2, { type: 'steal', characterId: 'nightingale', targetId: 'crow', itemId: 'bell-heart' }, [10, 10, 5, 12]).state;
    const id = Object.keys(stolen.rulings)[0];
    expect(() => run(stolen, U1, { type: 'gmRuling', rulingId: id, decision: 'overturn' })).toThrow(/GM 權限/);
    const r = run(stolen, ARB, { type: 'gmRuling', rulingId: id, decision: 'overturn' });
    expect(r.state.items['bell-heart'].holder).toEqual({ type: 'character', id: 'crow' });
    expect(r.state.items['bell-heart'].lockedBy).toBeUndefined();
    expect(() => run(r.state, ARB, { type: 'gmRuling', rulingId: id, decision: 'confirm' })).toThrow(/結案/);
  });

  it('a theft noticed in a controlled zone is a recorded crime that everyone present sees', () => {
    const r = run(robbed('market'), U2, { type: 'steal', characterId: 'nightingale', targetId: 'crow', itemId: 'bell-heart' }, [10, 10, 15]);
    expect(r.state.characters.nightingale.crimes).toEqual([{ locationId: 'market', kind: 'theft', day: 1 }]);
    expect(r.events.find((e) => e.kind === 'crime')).toMatchObject({ visibility: 'scene' });
    expect(historyFor(r.state, U1, r.events).find((e) => e.kind === 'theftNoticed')!.text).toBe('夜鶯 偷走了你的沉鐘之心，被你發現了。');
  });

  it('a botched approach on a sleeping afterimage in the wild takes nothing and alerts no one', () => {
    let s = robbed('road');
    s = run(s, U1, { type: 'setOnline', characterId: 'crow', online: false }).state;
    const r = run(s, U2, { type: 'steal', characterId: 'nightingale', targetId: 'crow', itemId: 'bell-heart' }, [1, 12]); // nat 1 vs 8
    expect(r.state.items['bell-heart'].holder.id).toBe('crow');
    expect(r.events.some((e) => e.kind === 'theftNoticed')).toBe(false);
  });

  it('robbing an afterimage: the victim cannot notice, guards can in a controlled zone', () => {
    let s = robbed('market');
    s = run(s, U1, { type: 'setOnline', characterId: 'crow', online: false }).state;
    // approach vs base awareness 8 only; guards PER-equivalent 2 + 2 vs 14
    const r = run(s, U2, { type: 'steal', characterId: 'nightingale', targetId: 'crow', itemId: 'bell-heart' }, [5, 10, 3, 12]);
    expect((r.events.find((e) => e.kind === 'theft')!.data as any).steps.notice.by).toBe('guards');
    expect(r.state.items['bell-heart'].holder.id).toBe('nightingale');
  });
});
