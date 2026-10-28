import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import seed from '../config/world-seed.json';
import { createCharacter, exampleBuild } from '../src/character/create';
import { CombatStore } from '../src/persistence/combat-store';
import type { Database } from '../src/persistence/db';
import { openDatabase } from '../src/persistence/drivers';
import { WorldStore } from '../src/persistence/world-store';
import { RULES_V03 } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import type { WorldSeed } from '../src/world/engine';
import type { WorldActor, WorldCommand } from '../src/world/types';
import { freshDatabaseUrl, realPostgres } from './helpers/db';

const R = RULES_V03;
const T0 = new Date('2026-10-27T12:00:00Z');
const MAIN: WorldActor = { userId: 'gm-main', role: 'gm' };
const U1: WorldActor = { userId: 'u1', role: 'player' };
const U2: WorldActor = { userId: 'u2', role: 'player' };

let url: string;
let cleanup: () => Promise<void>;
let db: Database;
let store: WorldStore;

async function open() {
  db = await openDatabase(url);
  store = await WorldStore.open(await CombatStore.open(db, R), R);
}

async function reopen() {
  await db.close();
  await open();
}

afterEach(async () => {
  await db.close();
  await cleanup();
});

beforeEach(async () => {
  ({ url, cleanup } = await freshDatabaseUrl());
  await open();
  await store.combat.saveNewCharacter('u1', createCharacter({ ...exampleBuild('guardian', R), name: '灰鴉' }, R, T0, 'crow'));
  await store.combat.saveNewCharacter('u2', createCharacter({ ...exampleBuild('scout', R), name: '夜鶯' }, R, T0, 'nightingale'));
  await store.createWorld(seed as WorldSeed, { 'gm-main': { role: 'main' }, 'gm-ruins': { role: 'scene', locations: ['ruins'] } });
  await store.join('greystone', 'crow', 'ruins');
  await store.join('greystone', 'nightingale', 'ruins');
});

const send = (actor: WorldActor, command: WorldCommand, rolls: number[] = []) =>
  store.submit('greystone', { actor, command }, scriptedRng(rolls), T0);

describe('shared world persistence', () => {
  it('NPC deaths, location changes and item moves survive a restart', async () => {
    await send(MAIN, { type: 'gmSetNpcStatus', npcId: 'keeper', status: 'dead', basis: '戰鬥 c1' });
    await send({ userId: 'gm-ruins', role: 'gm' }, { type: 'gmSetLocationState', locationId: 'ruins', key: '鐘樓大門', value: '被炸開' });
    await send(U1, { type: 'take', characterId: 'crow', itemId: 'bell-heart' });
    await reopen();
    const s = (await store.load('greystone'));
    expect(s.npcs.keeper.status).toBe('dead');
    expect(s.locations.ruins.state['鐘樓大門']).toBe('被炸開');
    expect(s.items['bell-heart'].holder).toEqual({ type: 'character', id: 'crow' });
    expect((await store.events('greystone')).map((e) => e.kind)).toEqual(expect.arrayContaining(['npcDied', 'locationChanged', 'took']));
    expect((await store.changes('greystone')).length).toBeGreaterThanOrEqual(3);
  });

  it('the database itself refuses reviving NPCs, deleting items and rewriting history', async () => {
    await send(MAIN, { type: 'gmSetNpcStatus', npcId: 'keeper', status: 'dead', basis: '戰鬥 c1' });
    const db = store.combat.db;
    await expect(db.run("UPDATE world_npcs SET status = 'alive' WHERE id = 'keeper'")).rejects.toThrow(/cannot be revived/);
    await expect(db.run("DELETE FROM world_items WHERE id = 'bell-heart'")).rejects.toThrow(/never deleted/);
    await expect(db.run("UPDATE world_events SET event = '{}'")).rejects.toThrow(/append-only/);
    await expect(db.run('DELETE FROM world_events')).rejects.toThrow(/append-only/);
  });

  it('two players acting on the same snapshot: the second commit is rejected by the version check', async () => {
    const a = (await store.load('greystone'));
    const b = (await store.load('greystone'));
    await store.submit('greystone', { actor: U1, command: { type: 'take', characterId: 'crow', itemId: 'bell-heart' } }, scriptedRng([]), T0, a);
    await expect(store.submit('greystone', { actor: U2, command: { type: 'take', characterId: 'nightingale', itemId: 'bell-heart' } }, scriptedRng([]), T0, b))
      .rejects.toThrow(/重新讀取/);
    expect((await store.load('greystone')).items['bell-heart'].holder.id).toBe('crow');
    expect((await store.events('greystone')).filter((e) => e.kind === 'took')).toHaveLength(1);
  });

  it('six processes grabbing the same unique item at the same instant: exactly one gets it', async () => {
    const racers = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    for (const id of racers) {
      await store.combat.saveNewCharacter(`user-${id}`, createCharacter({ ...exampleBuild('scout', R), name: id }, R, T0, id));
      await store.join('greystone', id, 'ruins');
    }
    let results: { characterId: string; ok: boolean; error?: string }[];
    if (realPostgres) {
      // Separate processes, each with its own connection pool, against one PostgreSQL server.
      const startAt = Date.now() + 2500;
      results = await Promise.all(racers.map((id) => new Promise<{ characterId: string; ok: boolean; error?: string }>((resolve, reject) => {
        const p = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'fixtures/race-take.ts'), url, id, `user-${id}`, String(startAt)], { cwd: join(__dirname, '..') });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').at(-1)!)); } catch { reject(new Error(err || out)); } });
      })));
    } else {
      // PGlite is single-process: the racers are concurrent requests in this process instead.
      results = await Promise.all(racers.map(async (id) => {
        try {
          await store.submit('greystone', { actor: { userId: `user-${id}`, role: 'player' }, command: { type: 'take', characterId: id, itemId: 'bell-heart' } }, scriptedRng([]), new Date());
          return { characterId: id, ok: true };
        } catch (e) {
          return { characterId: id, ok: false, error: (e as Error).message };
        }
      }));
    }
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r.error).toMatch(/不在這裡|重新讀取/);
    expect((await store.load('greystone')).items['bell-heart'].holder).toEqual({ type: 'character', id: winners[0].characterId });
    expect((await store.events('greystone')).filter((e) => e.kind === 'took')).toHaveLength(1);
  }, 30_000);
});

describe('permissions through the store', () => {
  it('rejects requests claiming the scheduler identity', async () => {
    await expect(send({ userId: 'u1', role: 'system' }, { type: 'advanceDay' })).rejects.toThrow(/scheduler/);
    expect((await store.runDaily('greystone', scriptedRng([]), T0)).state.day).toBe(2);
  });

  it('a player view hides GM notes and unwitnessed history; the audit trail is main-GM only', async () => {
    await send(MAIN, { type: 'gmSetNpcStatus', npcId: 'smuggler', status: 'dead', basis: '暗巷' });
    const v = (await store.viewFor('greystone', U1));
    expect(v.world.locations.ruins.gmNotes).toBe('');
    expect(v.history.map((e) => e.kind)).not.toContain('npcDied'); // a non-public NPC at the market: crow was not there
    expect(v.audit).toEqual([]);
    expect((await store.viewFor('greystone', MAIN)).audit.length).toBeGreaterThan(0);
  });
});

describe('PvP opens a real combat', () => {
  it('an afterimage target enters the fight death-protected; an online one does not', async () => {
    await send(U2, { type: 'setOnline', characterId: 'nightingale', online: false });
    const r = (await send(U1, { type: 'attack', characterId: 'crow', targetId: 'nightingale' }, [10, 5]));
    expect(r.combat!.combatants.nightingale.deathProtected).toBe(true);
    expect(r.combat!.combatants.crow.deathProtected).toBe(false);
    expect((await store.combat.loadCombat(r.combat!.id)).status).toBe('active');
  });

  it('a character who died is refused by the world and cannot rejoin', async () => {
    await store.combat.db.run("UPDATE characters SET status = 'dead', condition = 'dead' WHERE id = 'nightingale'");
    await expect(send(U2, { type: 'move', characterId: 'nightingale', to: 'road' })).rejects.toThrow(/永久死亡/);
    expect((await store.load('greystone')).characters.nightingale.status).toBe('dead');
  });
});

describe('a duel to the death needs a GM to confirm the death', () => {
  // nightingale starts at 1 HP; crow wins initiative and knocks her down, then she fails her death saves.
  async function duelToDeath() {
    await store.combat.db.run("UPDATE characters SET hp = 1 WHERE id = 'nightingale'");
    await send(U1, { type: 'inviteDuel', characterId: 'crow', targetId: 'nightingale' });
    const duelId = (await store.load('greystone')).duels[0].id;
    const r = (await send(U2, { type: 'respondDuel', characterId: 'nightingale', duelId, accept: true }, [20, 1])); // initiative
    const combatId = r.combat!.id;
    expect(r.combat!.combatants.nightingale).toMatchObject({ deathProtected: false, deathNeedsRuling: true });
    let k = 0;
    const act = async (who: string, action: import('../src/combat/types').CombatAction, rolls: number[] = []) => {
      const c = (await store.combat.loadCombat(combatId));
      const actor = who === 'crow' ? U1 : U2;
      return (await store.submitCombat('greystone', combatId, { actionId: `x${++k}`, actor: { userId: actor.userId, role: 'player' }, combatantId: who, round: c.round, action }, scriptedRng(rolls), T0));
    };
    await act('crow', { type: 'attack', targetId: 'nightingale' }, [20]);
    await act('crow', { type: 'endTurn' });
    await act('nightingale', { type: 'deathSave' }, [1]); // natural 1: two failures
    await act('crow', { type: 'endTurn' });
    await act('nightingale', { type: 'deathSave' }, [2]); // third failure → death pending
    return combatId;
  }

  it('the dice decide, but the character is only held unconscious until a GM rules', async () => {
    const combatId = await duelToDeath();
    expect((await store.combat.getCharacter('nightingale'))).toMatchObject({ status: 'alive', condition: 'deathPending' });
    expect((await store.combat.deathRecord('nightingale'))).toBeUndefined();
    const ruling = Object.values((await store.load('greystone')).rulings).find((r) => r.kind === 'pvp-death')!;
    expect(ruling).toMatchObject({ status: 'open', characterId: 'nightingale', combatId, subjects: ['nightingale', 'crow'] });
    await expect(send(U2, { type: 'move', characterId: 'nightingale', to: 'road' })).rejects.toThrow(/無法行動/);
    await send(MAIN, { type: 'gmRuling', rulingId: ruling.id, decision: 'confirm' });
    expect((await store.combat.getCharacter('nightingale'))).toMatchObject({ status: 'dead', condition: 'dead' });
    expect((await store.combat.deathRecord('nightingale'))).toMatchObject({ combat_id: combatId, cause: 'pvp:dying-failures' });
  });

  it('a GM can rule the death invalid: the character survives at 1 HP', async () => {
    await duelToDeath();
    const ruling = Object.values((await store.load('greystone')).rulings).find((r) => r.kind === 'pvp-death')!;
    await send(MAIN, { type: 'gmRuling', rulingId: ruling.id, decision: 'overturn' });
    expect((await store.combat.getCharacter('nightingale'))).toMatchObject({ status: 'alive', condition: 'stable', hp: 1 });
    expect((await store.combat.deathRecord('nightingale'))).toBeUndefined();
  });
});

describe('economy persistence', () => {
  const pay = (actor: WorldActor, command: WorldCommand, requestId: string, snapshot?: Awaited<ReturnType<WorldStore['load']>>) =>
    store.submit('greystone', { actor, command, requestId }, scriptedRng([]), T0, snapshot);

  /** 灰鴉 gets 40 coins and a lantern on the shelf of her shop in the ruins. */
  async function shop() {
    await pay(MAIN, { type: 'gmGrantCoins', characterId: 'nightingale', amount: 40, reason: '起始資金' }, 'grant-1');
    await send(U1, { type: 'take', characterId: 'crow', itemId: 'bell-heart' });
    await pay(U1, { type: 'openShop', characterId: 'crow', shopId: 'crow-shop', name: '灰鴉雜貨', description: '' }, 'shop-1');
    await pay(U1, { type: 'stockItem', characterId: 'crow', shopId: 'crow-shop', itemId: 'bell-heart', price: 30 }, 'stock-1');
  }

  it('commands that move value must carry a request id', async () => {
    await expect(send(MAIN, { type: 'gmGrantCoins', characterId: 'crow', amount: 5, reason: 'x' })).rejects.toThrow(/requestId/);
  });

  it('a repeated purchase request is applied once: the retry gets the first result and pays nothing', async () => {
    await shop();
    const buy: WorldCommand = { type: 'buy', characterId: 'nightingale', shopId: 'crow-shop', itemId: 'bell-heart' };
    const first = (await pay(U2, buy, 'buy-1'));
    const again = (await pay(U2, buy, 'buy-1'));
    expect(first.replayed).toBeUndefined();
    expect(again.replayed).toBe(true);
    expect(again.ledger).toEqual(first.ledger);
    const s = (await store.load('greystone'));
    expect(s.characters.nightingale.coins).toBe(10);
    expect(s.characters.crow.coins).toBe(30);
    expect((await store.ledger('greystone')).filter((e) => e.reason.startsWith('buy')).length).toBe(2); // one coin move, one item move
    await expect(pay(U2, { ...buy, itemId: 'old-map' }, 'buy-1')).rejects.toThrow(/另一個操作/);
    await expect(pay(U1, buy, 'buy-1')).rejects.toThrow(/另一個操作/);
  });

  it('two buyers on the same snapshot: only one gets the item, the other is told to reload', async () => {
    await shop();
    await pay(MAIN, { type: 'gmGrantCoins', characterId: 'crow', amount: 1, reason: 'x' }, 'grant-2');
    await store.combat.saveNewCharacter('u3', createCharacter({ ...exampleBuild('scout', R), name: '鷦鷯' }, R, T0, 'wren'));
    await store.join('greystone', 'wren', 'ruins');
    await pay(MAIN, { type: 'gmGrantCoins', characterId: 'wren', amount: 40, reason: 'x' }, 'grant-3');
    const a = (await store.load('greystone'));
    const b = (await store.load('greystone'));
    await pay(U2, { type: 'buy', characterId: 'nightingale', shopId: 'crow-shop', itemId: 'bell-heart' }, 'race-a', a);
    await expect(pay({ userId: 'u3', role: 'player' }, { type: 'buy', characterId: 'wren', shopId: 'crow-shop', itemId: 'bell-heart' }, 'race-b', b)).rejects.toThrow(/重新讀取/);
    const s = (await store.load('greystone'));
    expect(s.items['bell-heart'].holder).toEqual({ type: 'character', id: 'nightingale' });
    expect(s.characters.wren.coins).toBe(40);
  });

  it('shops, contracts, locks and the ledger survive a restart, and the ledger cannot be edited', async () => {
    await shop();
    await pay(U2, {
      type: 'proposeContract', characterId: 'nightingale', with: ['crow'], title: '護送', deadline: '2026-10-29T12:00:00Z', deposits: { nightingale: 10 },
      clauses: [{ kind: 'payCoins', from: 'nightingale', to: 'crow', amount: 5 }],
    }, 'k-1');
    await reopen();
    const s = (await store.load('greystone'));
    expect(s.economy.shops['crow-shop'].listings).toEqual([{ itemId: 'bell-heart', price: 30 }]);
    const k = Object.values(s.economy.contracts)[0];
    expect(k.status).toBe('proposed');
    expect(s.economy.locks[k.depositLocks.nightingale]).toMatchObject({ status: 'held', coins: 10 });
    expect(s.characters.nightingale.coins).toBe(30);
    const db = store.combat.db;
    await expect(db.run('UPDATE world_ledger SET coins = 1')).rejects.toThrow(/append-only/);
    await expect(db.run('DELETE FROM world_ledger')).rejects.toThrow(/append-only/);
    await expect(db.run('DELETE FROM world_records')).rejects.toThrow(/never deleted/);
    // The deadline hook runs as the scheduler and lapses the unsigned contract.
    await store.runDeadlines('greystone', scriptedRng([]), new Date('2026-10-30T12:00:00Z'));
    expect((await store.load('greystone')).characters.nightingale.coins).toBe(40);
  });

  it('a team, its treasury and its open votes survive a restart', async () => {
    await pay(MAIN, { type: 'gmGrantCoins', characterId: 'crow', amount: 20, reason: 'x' }, 't-0');
    await send(U1, { type: 'take', characterId: 'crow', itemId: 'bell-heart' });
    await pay(U1, { type: 'createTeam', characterId: 'crow', teamId: 'crows', name: '鴉群', policy: 'majority' }, 't-1');
    await pay(U1, { type: 'inviteToTeam', characterId: 'crow', teamId: 'crows', targetId: 'nightingale' }, 't-2');
    await pay(U2, { type: 'respondTeamInvite', characterId: 'nightingale', teamId: 'crows', accept: true }, 't-3');
    await pay(U1, { type: 'depositToTeam', characterId: 'crow', teamId: 'crows', coins: 15, itemIds: ['bell-heart'] }, 't-4');
    await pay(U1, { type: 'proposeTeam', characterId: 'crow', teamId: 'crows', motion: { kind: 'withdraw', to: 'nightingale', coins: 5, itemIds: [] } }, 't-5');
    await reopen();
    const t = (await store.load('greystone')).economy.teams.crows;
    expect(t).toMatchObject({ coins: 15, members: ['crow', 'nightingale'], policy: 'majority' });
    expect(t.proposals[0].status).toBe('open');
    expect((await store.load('greystone')).items['bell-heart'].holder).toEqual({ type: 'team', id: 'crows' });
    const vote: WorldCommand = { type: 'voteTeam', characterId: 'nightingale', teamId: 'crows', proposalId: t.proposals[0].id, approve: true };
    await pay(U2, vote, 't-6');
    await pay(U2, vote, 't-6'); // a retried vote is not counted twice
    const after = (await store.load('greystone'));
    expect(after.economy.teams.crows.coins).toBe(10);
    expect(after.characters.nightingale.coins).toBe(5);
  });

  it('a player only reads ledger lines that touch their own characters', async () => {
    await shop();
    expect((await store.viewFor('greystone', U1)).ledger.every((e) => e.to.id !== 'nightingale' || e.from.id === 'crow')).toBe(true);
    expect((await store.viewFor('greystone', U2)).ledger.map((e) => e.reason)).toEqual(['grant: 起始資金']);
    expect((await store.viewFor('greystone', MAIN)).ledger.length).toBe((await store.ledger('greystone')).length);
  });
});
