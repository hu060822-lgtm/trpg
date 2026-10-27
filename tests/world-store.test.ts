import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import seed from '../config/world-seed.json';
import { createCharacter, exampleBuild } from '../src/character/create';
import { CombatStore } from '../src/persistence/combat-store';
import { WorldStore } from '../src/persistence/world-store';
import { RULES_V03 } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import type { WorldSeed } from '../src/world/engine';
import type { WorldActor, WorldCommand } from '../src/world/types';

const R = RULES_V03;
const T0 = new Date('2026-10-27T12:00:00Z');
const MAIN: WorldActor = { userId: 'gm-main', role: 'gm' };
const U1: WorldActor = { userId: 'u1', role: 'player' };
const U2: WorldActor = { userId: 'u2', role: 'player' };

let path: string;
let store: WorldStore;

function open() {
  return new WorldStore(new CombatStore(path, R), R);
}

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'fw-world-')), 'game.db');
  store = open();
  store.combat.saveNewCharacter('u1', createCharacter({ ...exampleBuild('guardian', R), name: '灰鴉' }, R, T0, 'crow'));
  store.combat.saveNewCharacter('u2', createCharacter({ ...exampleBuild('scout', R), name: '夜鶯' }, R, T0, 'nightingale'));
  store.createWorld(seed as WorldSeed, { 'gm-main': { role: 'main' }, 'gm-ruins': { role: 'scene', locations: ['ruins'] } });
  store.join('greystone', 'crow', 'ruins');
  store.join('greystone', 'nightingale', 'ruins');
});

const send = (actor: WorldActor, command: WorldCommand, rolls: number[] = []) =>
  store.submit('greystone', { actor, command }, scriptedRng(rolls), T0);

describe('shared world persistence', () => {
  it('NPC deaths, location changes and item moves survive a restart', () => {
    send(MAIN, { type: 'gmSetNpcStatus', npcId: 'keeper', status: 'dead', basis: '戰鬥 c1' });
    send({ userId: 'gm-ruins', role: 'gm' }, { type: 'gmSetLocationState', locationId: 'ruins', key: '鐘樓大門', value: '被炸開' });
    send(U1, { type: 'take', characterId: 'crow', itemId: 'bell-heart' });
    store.combat.close();
    store = open();
    const s = store.load('greystone');
    expect(s.npcs.keeper.status).toBe('dead');
    expect(s.locations.ruins.state['鐘樓大門']).toBe('被炸開');
    expect(s.items['bell-heart'].holder).toEqual({ type: 'character', id: 'crow' });
    expect(store.events('greystone').map((e) => e.kind)).toEqual(expect.arrayContaining(['npcDied', 'locationChanged', 'took']));
    expect(store.changes('greystone').length).toBeGreaterThanOrEqual(3);
  });

  it('the database itself refuses reviving NPCs, deleting items and rewriting history', () => {
    send(MAIN, { type: 'gmSetNpcStatus', npcId: 'keeper', status: 'dead', basis: '戰鬥 c1' });
    const db = store.combat.db;
    expect(() => db.prepare("UPDATE world_npcs SET status = 'alive' WHERE id = 'keeper'").run()).toThrow(/cannot be revived/);
    expect(() => db.prepare("DELETE FROM world_items WHERE id = 'bell-heart'").run()).toThrow(/never deleted/);
    expect(() => db.prepare("UPDATE world_events SET event = '{}'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM world_events').run()).toThrow(/append-only/);
  });

  it('two players acting on the same snapshot: the second commit is rejected by the version check', () => {
    const a = store.load('greystone');
    const b = store.load('greystone');
    store.submit('greystone', { actor: U1, command: { type: 'take', characterId: 'crow', itemId: 'bell-heart' } }, scriptedRng([]), T0, a);
    expect(() => store.submit('greystone', { actor: U2, command: { type: 'take', characterId: 'nightingale', itemId: 'bell-heart' } }, scriptedRng([]), T0, b))
      .toThrow(/重新讀取/);
    expect(store.load('greystone').items['bell-heart'].holder.id).toBe('crow');
    expect(store.events('greystone').filter((e) => e.kind === 'took')).toHaveLength(1);
  });

  it('six processes grabbing the same unique item at the same instant: exactly one gets it', async () => {
    const racers = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    for (const id of racers) {
      store.combat.saveNewCharacter(`user-${id}`, createCharacter({ ...exampleBuild('scout', R), name: id }, R, T0, id));
      store.join('greystone', id, 'ruins');
    }
    store.combat.close();
    const startAt = Date.now() + 2500;
    const results = await Promise.all(racers.map((id) => new Promise<{ characterId: string; ok: boolean; error?: string }>((resolve, reject) => {
      const p = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'fixtures/race-take.ts'), path, id, `user-${id}`, String(startAt)], { cwd: join(__dirname, '..') });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').at(-1)!)); } catch { reject(new Error(err || out)); } });
    })));
    store = open();
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r.error).toMatch(/不在這裡|重新讀取/);
    expect(store.load('greystone').items['bell-heart'].holder).toEqual({ type: 'character', id: winners[0].characterId });
    expect(store.events('greystone').filter((e) => e.kind === 'took')).toHaveLength(1);
  }, 30_000);
});

describe('permissions through the store', () => {
  it('rejects requests claiming the scheduler identity', () => {
    expect(() => send({ userId: 'u1', role: 'system' }, { type: 'advanceDay' })).toThrow(/scheduler/);
    expect(store.runDaily('greystone', scriptedRng([]), T0).state.day).toBe(2);
  });

  it('a player view hides GM notes and unwitnessed history; the audit trail is main-GM only', () => {
    send(MAIN, { type: 'gmSetNpcStatus', npcId: 'smuggler', status: 'dead', basis: '暗巷' });
    const v = store.viewFor('greystone', U1);
    expect(v.world.locations.ruins.gmNotes).toBe('');
    expect(v.history.map((e) => e.kind)).not.toContain('npcDied'); // a non-public NPC at the market: crow was not there
    expect(v.audit).toEqual([]);
    expect(store.viewFor('greystone', MAIN).audit.length).toBeGreaterThan(0);
  });
});

describe('PvP opens a real combat', () => {
  it('an afterimage target enters the fight death-protected; an online one does not', () => {
    send(U2, { type: 'setOnline', characterId: 'nightingale', online: false });
    const r = send(U1, { type: 'attack', characterId: 'crow', targetId: 'nightingale' }, [10, 5]);
    expect(r.combat!.combatants.nightingale.deathProtected).toBe(true);
    expect(r.combat!.combatants.crow.deathProtected).toBe(false);
    expect(store.combat.loadCombat(r.combat!.id).status).toBe('active');
  });

  it('a character who died is refused by the world and cannot rejoin', () => {
    store.combat.db.prepare("UPDATE characters SET status = 'dead', condition = 'dead' WHERE id = 'nightingale'").run();
    expect(() => send(U2, { type: 'move', characterId: 'nightingale', to: 'road' })).toThrow(/永久死亡/);
    expect(store.load('greystone').characters.nightingale.status).toBe('dead');
  });
});

describe('a duel to the death needs a GM to confirm the death', () => {
  // nightingale starts at 1 HP; crow wins initiative and knocks her down, then she fails her death saves.
  function duelToDeath() {
    store.combat.db.prepare("UPDATE characters SET hp = 1 WHERE id = 'nightingale'").run();
    send(U1, { type: 'inviteDuel', characterId: 'crow', targetId: 'nightingale' });
    const duelId = store.load('greystone').duels[0].id;
    const r = send(U2, { type: 'respondDuel', characterId: 'nightingale', duelId, accept: true }, [20, 1]); // initiative
    const combatId = r.combat!.id;
    expect(r.combat!.combatants.nightingale).toMatchObject({ deathProtected: false, deathNeedsRuling: true });
    let k = 0;
    const act = (who: string, action: import('../src/combat/types').CombatAction, rolls: number[] = []) => {
      const c = store.combat.loadCombat(combatId);
      const actor = who === 'crow' ? U1 : U2;
      return store.submitCombat('greystone', combatId, { actionId: `x${++k}`, actor: { userId: actor.userId, role: 'player' }, combatantId: who, round: c.round, action }, scriptedRng(rolls), T0);
    };
    act('crow', { type: 'attack', targetId: 'nightingale' }, [20]);
    act('crow', { type: 'endTurn' });
    act('nightingale', { type: 'deathSave' }, [1]); // natural 1: two failures
    act('crow', { type: 'endTurn' });
    act('nightingale', { type: 'deathSave' }, [2]); // third failure → death pending
    return combatId;
  }

  it('the dice decide, but the character is only held unconscious until a GM rules', () => {
    const combatId = duelToDeath();
    expect(store.combat.getCharacter('nightingale')).toMatchObject({ status: 'alive', condition: 'deathPending' });
    expect(store.combat.deathRecord('nightingale')).toBeUndefined();
    const ruling = Object.values(store.load('greystone').rulings).find((r) => r.kind === 'pvp-death')!;
    expect(ruling).toMatchObject({ status: 'open', characterId: 'nightingale', combatId, subjects: ['nightingale', 'crow'] });
    expect(() => send(U2, { type: 'move', characterId: 'nightingale', to: 'road' })).toThrow(/無法行動/);
    send(MAIN, { type: 'gmRuling', rulingId: ruling.id, decision: 'confirm' });
    expect(store.combat.getCharacter('nightingale')).toMatchObject({ status: 'dead', condition: 'dead' });
    expect(store.combat.deathRecord('nightingale')).toMatchObject({ combat_id: combatId, cause: 'pvp:dying-failures' });
  });

  it('a GM can rule the death invalid: the character survives at 1 HP', () => {
    duelToDeath();
    const ruling = Object.values(store.load('greystone').rulings).find((r) => r.kind === 'pvp-death')!;
    send(MAIN, { type: 'gmRuling', rulingId: ruling.id, decision: 'overturn' });
    expect(store.combat.getCharacter('nightingale')).toMatchObject({ status: 'alive', condition: 'stable', hp: 1 });
    expect(store.combat.deathRecord('nightingale')).toBeUndefined();
  });
});

describe('economy persistence', () => {
  const pay = (actor: WorldActor, command: WorldCommand, requestId: string, snapshot?: ReturnType<WorldStore['load']>) =>
    store.submit('greystone', { actor, command, requestId }, scriptedRng([]), T0, snapshot);

  /** 灰鴉 gets 40 coins and a lantern on the shelf of her shop in the ruins. */
  function shop() {
    pay(MAIN, { type: 'gmGrantCoins', characterId: 'nightingale', amount: 40, reason: '起始資金' }, 'grant-1');
    send(U1, { type: 'take', characterId: 'crow', itemId: 'bell-heart' });
    pay(U1, { type: 'openShop', characterId: 'crow', shopId: 'crow-shop', name: '灰鴉雜貨', description: '' }, 'shop-1');
    pay(U1, { type: 'stockItem', characterId: 'crow', shopId: 'crow-shop', itemId: 'bell-heart', price: 30 }, 'stock-1');
  }

  it('commands that move value must carry a request id', () => {
    expect(() => send(MAIN, { type: 'gmGrantCoins', characterId: 'crow', amount: 5, reason: 'x' })).toThrow(/requestId/);
  });

  it('a repeated purchase request is applied once: the retry gets the first result and pays nothing', () => {
    shop();
    const buy: WorldCommand = { type: 'buy', characterId: 'nightingale', shopId: 'crow-shop', itemId: 'bell-heart' };
    const first = pay(U2, buy, 'buy-1');
    const again = pay(U2, buy, 'buy-1');
    expect(first.replayed).toBeUndefined();
    expect(again.replayed).toBe(true);
    expect(again.ledger).toEqual(first.ledger);
    const s = store.load('greystone');
    expect(s.characters.nightingale.coins).toBe(10);
    expect(s.characters.crow.coins).toBe(30);
    expect(store.ledger('greystone').filter((e) => e.reason.startsWith('buy')).length).toBe(2); // one coin move, one item move
    expect(() => pay(U2, { ...buy, itemId: 'old-map' }, 'buy-1')).toThrow(/另一個操作/);
    expect(() => pay(U1, buy, 'buy-1')).toThrow(/另一個操作/);
  });

  it('two buyers on the same snapshot: only one gets the item, the other is told to reload', () => {
    shop();
    pay(MAIN, { type: 'gmGrantCoins', characterId: 'crow', amount: 1, reason: 'x' }, 'grant-2');
    store.combat.saveNewCharacter('u3', createCharacter({ ...exampleBuild('scout', R), name: '鷦鷯' }, R, T0, 'wren'));
    store.join('greystone', 'wren', 'ruins');
    pay(MAIN, { type: 'gmGrantCoins', characterId: 'wren', amount: 40, reason: 'x' }, 'grant-3');
    const a = store.load('greystone');
    const b = store.load('greystone');
    pay(U2, { type: 'buy', characterId: 'nightingale', shopId: 'crow-shop', itemId: 'bell-heart' }, 'race-a', a);
    expect(() => pay({ userId: 'u3', role: 'player' }, { type: 'buy', characterId: 'wren', shopId: 'crow-shop', itemId: 'bell-heart' }, 'race-b', b)).toThrow(/重新讀取/);
    const s = store.load('greystone');
    expect(s.items['bell-heart'].holder).toEqual({ type: 'character', id: 'nightingale' });
    expect(s.characters.wren.coins).toBe(40);
  });

  it('shops, contracts, locks and the ledger survive a restart, and the ledger cannot be edited', () => {
    shop();
    pay(U2, {
      type: 'proposeContract', characterId: 'nightingale', with: 'crow', title: '護送', deadline: '2026-10-29T12:00:00Z', deposits: { nightingale: 10 },
      clauses: [{ kind: 'payCoins', from: 'nightingale', to: 'crow', amount: 5 }],
    }, 'k-1');
    store.combat.close();
    store = open();
    const s = store.load('greystone');
    expect(s.economy.shops['crow-shop'].listings).toEqual([{ itemId: 'bell-heart', price: 30 }]);
    const k = Object.values(s.economy.contracts)[0];
    expect(k.status).toBe('proposed');
    expect(s.economy.locks[k.depositLocks.nightingale]).toMatchObject({ status: 'held', coins: 10 });
    expect(s.characters.nightingale.coins).toBe(30);
    const db = store.combat.db;
    expect(() => db.prepare('UPDATE world_ledger SET coins = 1').run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM world_ledger').run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM world_records').run()).toThrow(/never deleted/);
    // The deadline hook runs as the scheduler and lapses the unsigned contract.
    store.runDeadlines('greystone', scriptedRng([]), new Date('2026-10-30T12:00:00Z'));
    expect(store.load('greystone').characters.nightingale.coins).toBe(40);
  });

  it('a player only reads ledger lines that touch their own characters', () => {
    shop();
    expect(store.viewFor('greystone', U1).ledger.every((e) => e.to.id !== 'nightingale' || e.from.id === 'crow')).toBe(true);
    expect(store.viewFor('greystone', U2).ledger.map((e) => e.reason)).toEqual(['grant: 起始資金']);
    expect(store.viewFor('greystone', MAIN).ledger.length).toBe(store.ledger('greystone').length);
  });
});
