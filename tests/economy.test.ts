import { describe, expect, it } from 'vitest';
import seed from '../config/world-seed.json';
import { RULES_V03 } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import type { AttributeCode } from '../src/rules/types';
import { applyWorld, createWorld, joinWorld, type WorldResult, type WorldSeed } from '../src/world/engine';
import type { LedgerEntry, WorldActor, WorldCommand, WorldState } from '../src/world/types';
import { ledgerFor, viewFor } from '../src/world/view';

const R = RULES_V03;
const T0 = new Date('2026-10-27T12:00:00Z');
const LATER = new Date('2026-10-30T12:00:00Z');
const DEADLINE = '2026-10-29T12:00:00Z';
const attrs = (): Record<AttributeCode, number> => ({ STR: 1, AGI: 1, VIT: 1, PRE: 1, PER: 1, INT: 1, WIL: 1, CHA: 1, INS: 1, SPR: 1 });

const U1: WorldActor = { userId: 'u1', role: 'player' };
const U2: WorldActor = { userId: 'u2', role: 'player' };
const U3: WorldActor = { userId: 'u3', role: 'player' };
const MAIN: WorldActor = { userId: 'gm-main', role: 'gm' };
const ARB: WorldActor = { userId: 'gm-arb', role: 'gm' };
const SYS: WorldActor = { userId: 'scheduler', role: 'system' };
const START = { crow: 50, nightingale: 30, wren: 0 };

/** 灰鴉 (u1, 50 coins) and 夜鶯 (u2, 30 coins) at the market with a lantern and herbs; 鷦鷯 (u3) watches. */
function world(): WorldState {
  let s = createWorld(seed as WorldSeed, { 'gm-main': { role: 'main' }, 'gm-arb': { role: 'arbiter' } });
  s = joinWorld(s, { id: 'crow', ownerUserId: 'u1', name: '灰鴉', attributes: attrs(), skills: {}, coins: START.crow }, 'market');
  s = joinWorld(s, { id: 'nightingale', ownerUserId: 'u2', name: '夜鶯', attributes: attrs(), skills: {}, coins: START.nightingale }, 'market');
  s = joinWorld(s, { id: 'wren', ownerUserId: 'u3', name: '鷦鷯', attributes: attrs(), skills: {}, coins: START.wren }, 'plaza');
  s.items.lantern.holder = { type: 'character', id: 'crow' };
  for (const n of [1, 2, 3]) s.items[`moonherb-${n}`].holder = { type: 'character', id: 'nightingale' };
  return s;
}

/** Applies commands in order, collecting the ledger the way the store would. */
class Run {
  ledger: LedgerEntry[] = [];
  constructor(public s: WorldState) {}
  do(actor: WorldActor, command: WorldCommand, now = T0): WorldResult {
    const r = applyWorld(this.s, { actor, command }, R, scriptedRng([]), now);
    this.s = r.state;
    this.ledger.push(...r.ledger);
    return r;
  }
}

const coins = (s: WorldState, id: string) => s.characters[id].coins;
const holder = (s: WorldState, id: string) => s.items[id].holder;

/** Coins are only created by GM grants and destroyed by sinks: everything else is a move. */
function assertConservation(r: Run) {
  const minted = r.ledger.filter((e) => e.from.type === 'mint').reduce((a, e) => a + (e.coins ?? 0), 0);
  const sunk = r.ledger.filter((e) => e.to.type === 'sink').reduce((a, e) => a + (e.coins ?? 0), 0);
  const held = Object.values(r.s.economy.locks).filter((l) => l.status === 'held').reduce((a, l) => a + l.coins, 0);
  const balances = Object.values(r.s.characters).reduce((a, c) => a + c.coins, 0);
  expect(balances + held).toBe(START.crow + START.nightingale + START.wren + minted - sunk);
  // Every escrowed item belongs to a lock that is still held, and every held lock's items are in escrow.
  for (const i of Object.values(r.s.items)) {
    if (i.holder.type === 'escrow') expect(r.s.economy.locks[i.holder.id]?.status).toBe('held');
  }
  for (const l of Object.values(r.s.economy.locks)) {
    if (l.status === 'held') for (const id of l.itemIds) expect(holder(r.s, id)).toEqual({ type: 'escrow', id: l.id });
  }
}

/** Shop stock and item ownership must agree in both directions. */
function assertShopConsistency(s: WorldState) {
  for (const sh of Object.values(s.economy.shops)) {
    for (const l of sh.listings) expect(holder(s, l.itemId)).toEqual({ type: 'shop', id: sh.id });
  }
  for (const i of Object.values(s.items)) {
    if (i.holder.type === 'shop') expect(s.economy.shops[i.holder.id].listings.some((l) => l.itemId === i.id)).toBe(true);
  }
}

describe('shops', () => {
  it('stocking moves the real item to the shop; buying moves coins and the item together', () => {
    const r = new Run(world());
    r.do(U1, { type: 'openShop', characterId: 'crow', shopId: 'crow-shop', name: '灰鴉雜貨', description: '' });
    r.do(U1, { type: 'stockItem', characterId: 'crow', shopId: 'crow-shop', itemId: 'lantern', price: 12 });
    expect(holder(r.s, 'lantern')).toEqual({ type: 'shop', id: 'crow-shop' });
    assertShopConsistency(r.s);

    r.do(U2, { type: 'buy', characterId: 'nightingale', shopId: 'crow-shop', itemId: 'lantern' });
    expect(holder(r.s, 'lantern')).toEqual({ type: 'character', id: 'nightingale' });
    expect([coins(r.s, 'crow'), coins(r.s, 'nightingale')]).toEqual([62, 18]);
    expect(r.s.economy.shops['crow-shop'].listings).toEqual([]);
    assertShopConsistency(r.s);
    assertConservation(r);
    // The same item cannot be sold twice.
    expect(() => r.do(U3, { type: 'buy', characterId: 'wren', shopId: 'crow-shop', itemId: 'lantern' })).toThrow(/已經賣出|才能/);
  });

  it('refuses buyers who are elsewhere, broke, or at a closed shop, and moves nothing', () => {
    const r = new Run(world());
    r.do(U1, { type: 'openShop', characterId: 'crow', shopId: 'crow-shop', name: '灰鴉雜貨', description: '' });
    r.do(U1, { type: 'stockItem', characterId: 'crow', shopId: 'crow-shop', itemId: 'lantern', price: 40 });
    const before = structuredClone(r.s);
    expect(() => r.do(U2, { type: 'buy', characterId: 'nightingale', shopId: 'crow-shop', itemId: 'lantern' })).toThrow(/不夠/);
    expect(() => r.do(U3, { type: 'buy', characterId: 'wren', shopId: 'crow-shop', itemId: 'lantern' })).toThrow(/才能/);
    r.do(U1, { type: 'setShopOpen', characterId: 'crow', shopId: 'crow-shop', open: false });
    expect(() => r.do(U2, { type: 'buy', characterId: 'nightingale', shopId: 'crow-shop', itemId: 'lantern' })).toThrow(/沒有營業/);
    expect(holder(r.s, 'lantern')).toEqual(holder(before, 'lantern'));
    expect(coins(r.s, 'nightingale')).toBe(coins(before, 'nightingale'));
  });

  it('a listing whose item was destroyed underneath it cannot be bought', () => {
    const r = new Run(world());
    r.do(U1, { type: 'openShop', characterId: 'crow', shopId: 'crow-shop', name: '灰鴉雜貨', description: '' });
    r.do(U1, { type: 'stockItem', characterId: 'crow', shopId: 'crow-shop', itemId: 'lantern', price: 5 });
    r.do(MAIN, { type: 'gmItemStatus', itemId: 'lantern', status: 'destroyed', basis: '市集失火' });
    expect(() => r.do(U2, { type: 'buy', characterId: 'nightingale', shopId: 'crow-shop', itemId: 'lantern' })).toThrow(/不一致/);
    expect(coins(r.s, 'nightingale')).toBe(30);
  });

  it('bound items and items you do not hold cannot be stocked', () => {
    const r = new Run(world());
    r.do(U1, { type: 'openShop', characterId: 'crow', shopId: 'crow-shop', name: '灰鴉雜貨', description: '' });
    expect(() => r.do(U1, { type: 'stockItem', characterId: 'crow', shopId: 'crow-shop', itemId: 'moonherb-1', price: 5 })).toThrow(/沒有/);
    r.s.items['oath-ring'].holder = { type: 'character', id: 'crow' };
    r.s.items['oath-ring'].boundTo = 'crow';
    expect(() => r.do(U1, { type: 'stockItem', characterId: 'crow', shopId: 'crow-shop', itemId: 'oath-ring', price: 5 })).toThrow(/綁定/);
    expect(() => r.do(U2, { type: 'stockItem', characterId: 'nightingale', shopId: 'crow-shop', itemId: 'moonherb-1', price: 5 })).toThrow(/不是你的商店/);
  });
});

describe('direct trades', () => {
  it('locks what the proposer offers until the other side accepts, then swaps both sides at once', () => {
    const r = new Run(world());
    const t = r.do(U1, { type: 'proposeTrade', characterId: 'crow', to: 'nightingale', give: { coins: 20, itemIds: ['lantern'] }, want: { coins: 0, itemIds: ['moonherb-1', 'moonherb-2'] } });
    const id = Object.keys(r.s.economy.trades)[0];
    expect(t.state.economy.trades[id].status).toBe('pending');
    expect(coins(r.s, 'crow')).toBe(30); // the 20 are set aside, not spendable
    expect(holder(r.s, 'lantern').type).toBe('escrow');
    assertConservation(r);

    r.do(U2, { type: 'acceptTrade', characterId: 'nightingale', tradeId: id });
    expect(r.s.economy.trades[id].status).toBe('completed');
    expect(holder(r.s, 'lantern')).toEqual({ type: 'character', id: 'nightingale' });
    expect(holder(r.s, 'moonherb-1')).toEqual({ type: 'character', id: 'crow' });
    expect([coins(r.s, 'crow'), coins(r.s, 'nightingale')]).toEqual([30, 50]);
    assertConservation(r);
    expect(() => r.do(U2, { type: 'acceptTrade', characterId: 'nightingale', tradeId: id })).toThrow(/已經結束/);
  });

  it('locked coins cannot be spent twice', () => {
    const r = new Run(world());
    r.do(U1, { type: 'proposeTrade', characterId: 'crow', to: 'nightingale', give: { coins: 40, itemIds: [] }, want: { coins: 0, itemIds: ['moonherb-1'] } });
    expect(() => r.do(U1, { type: 'proposeTrade', characterId: 'crow', to: 'wren', give: { coins: 40, itemIds: [] }, want: { coins: 0, itemIds: [] } })).toThrow(/不夠/);
  });

  it('an acceptor who cannot pay leaves everything where it was', () => {
    const r = new Run(world());
    r.do(U1, { type: 'proposeTrade', characterId: 'crow', to: 'nightingale', give: { coins: 0, itemIds: ['lantern'] }, want: { coins: 999, itemIds: [] } });
    const id = Object.keys(r.s.economy.trades)[0];
    expect(() => r.do(U2, { type: 'acceptTrade', characterId: 'nightingale', tradeId: id })).toThrow(/不夠/);
    expect(r.s.economy.trades[id].status).toBe('pending');
    expect(coins(r.s, 'nightingale')).toBe(30);
  });

  it('decline and cancel return the locked offer; only the right side may do each', () => {
    const r = new Run(world());
    r.do(U1, { type: 'proposeTrade', characterId: 'crow', to: 'nightingale', give: { coins: 10, itemIds: ['lantern'] }, want: { coins: 5, itemIds: [] } });
    const id = Object.keys(r.s.economy.trades)[0];
    expect(() => r.do(U1, { type: 'declineTrade', characterId: 'crow', tradeId: id })).toThrow(/不能結束/);
    r.do(U2, { type: 'declineTrade', characterId: 'nightingale', tradeId: id });
    expect(r.s.economy.trades[id].status).toBe('declined');
    expect(holder(r.s, 'lantern')).toEqual({ type: 'character', id: 'crow' });
    expect(coins(r.s, 'crow')).toBe(50);
    assertConservation(r);
  });

  it('both sides must stand in the same place to complete the swap', () => {
    const r = new Run(world());
    r.do(U3, { type: 'proposeTrade', characterId: 'wren', to: 'nightingale', give: { coins: 0, itemIds: [] }, want: { coins: 1, itemIds: [] } });
    const id = Object.keys(r.s.economy.trades)[0];
    expect(() => r.do(U2, { type: 'acceptTrade', characterId: 'nightingale', tradeId: id })).toThrow(/同一個地點/);
  });
});

describe('commissions', () => {
  it('a delivery commission locks the reward and settles itself when the right items arrive', () => {
    const r = new Run(world());
    r.do(U1, { type: 'postCommission', characterId: 'crow', title: '採三株月光草', requirement: { kind: 'deliver', template: 'moonherb', qty: 3 }, reward: 25, deadline: DEADLINE });
    const id = Object.keys(r.s.economy.commissions)[0];
    expect(coins(r.s, 'crow')).toBe(25);
    r.do(U2, { type: 'acceptCommission', characterId: 'nightingale', commissionId: id });
    expect(() => r.do(U2, { type: 'submitCommission', characterId: 'nightingale', commissionId: id, itemIds: ['moonherb-1', 'moonherb-2'] })).toThrow(/剛好 3 件/);
    r.do(U2, { type: 'submitCommission', characterId: 'nightingale', commissionId: id, itemIds: ['moonherb-1', 'moonherb-2', 'moonherb-3'] });
    expect(r.s.economy.commissions[id].status).toBe('completed');
    expect(coins(r.s, 'nightingale')).toBe(55);
    expect(holder(r.s, 'moonherb-3')).toEqual({ type: 'character', id: 'crow' });
    assertConservation(r);
  });

  it('a GM-judged commission waits in submitted until a GM approves or returns it', () => {
    const r = new Run(world());
    r.do(U1, { type: 'postCommission', characterId: 'crow', title: '查出走私販的下落', requirement: { kind: 'gm', text: '帶回可信的情報' }, reward: 10, deadline: DEADLINE });
    const id = Object.keys(r.s.economy.commissions)[0];
    r.do(U2, { type: 'acceptCommission', characterId: 'nightingale', commissionId: id });
    r.do(U2, { type: 'submitCommission', characterId: 'nightingale', commissionId: id, itemIds: [] });
    expect(r.s.economy.commissions[id].status).toBe('submitted');
    expect(() => r.do(U1, { type: 'reviewCommission', characterId: 'crow', commissionId: id, approve: true })).toThrow();
    r.do(ARB, { type: 'reviewCommission', characterId: 'crow', commissionId: id, approve: false });
    expect(r.s.economy.commissions[id].status).toBe('accepted');
    r.do(U2, { type: 'submitCommission', characterId: 'nightingale', commissionId: id, itemIds: [] });
    r.do(MAIN, { type: 'reviewCommission', characterId: 'crow', commissionId: id, approve: true });
    expect(r.s.economy.commissions[id].status).toBe('completed');
    expect(coins(r.s, 'nightingale')).toBe(40);
    assertConservation(r);
  });

  it('can be cancelled only before anyone takes it; an expired one refunds the issuer', () => {
    const r = new Run(world());
    r.do(U1, { type: 'postCommission', characterId: 'crow', title: 'A', requirement: { kind: 'gm', text: 'x' }, reward: 10, deadline: DEADLINE });
    r.do(U1, { type: 'postCommission', characterId: 'crow', title: 'B', requirement: { kind: 'gm', text: 'x' }, reward: 10, deadline: DEADLINE });
    const [a, b] = Object.keys(r.s.economy.commissions);
    r.do(U1, { type: 'cancelCommission', characterId: 'crow', commissionId: a });
    expect(r.s.economy.commissions[a].status).toBe('cancelled');
    r.do(U2, { type: 'acceptCommission', characterId: 'nightingale', commissionId: b });
    expect(() => r.do(U1, { type: 'cancelCommission', characterId: 'crow', commissionId: b })).toThrow(/爭議/);
    r.do(SYS, { type: 'settleDeadlines' }, LATER);
    expect(r.s.economy.commissions[b].status).toBe('expired');
    expect(coins(r.s, 'crow')).toBe(50);
    assertConservation(r);
  });
});

describe('contracts', () => {
  /** 灰鴉 pays 15 for three herbs; each side puts up a 10-coin deposit. */
  function signed(r: Run) {
    r.do(U1, {
      type: 'proposeContract', characterId: 'crow', with: 'nightingale', title: '月光草供貨', deadline: DEADLINE,
      deposits: { crow: 10, nightingale: 10 },
      clauses: [
        { kind: 'payCoins', from: 'crow', to: 'nightingale', amount: 15 },
        { kind: 'deliverTemplate', from: 'nightingale', to: 'crow', template: 'moonherb', qty: 3 },
      ],
    });
    const id = Object.keys(r.s.economy.contracts)[0];
    expect(r.s.economy.contracts[id].status).toBe('proposed');
    r.do(U2, { type: 'signContract', characterId: 'nightingale', contractId: id });
    return id;
  }

  it('is never fulfilled while any clause is still open', () => {
    const r = new Run(world());
    const id = signed(r);
    expect(r.s.economy.contracts[id].status).toBe('active');
    expect([coins(r.s, 'crow'), coins(r.s, 'nightingale')]).toEqual([40, 20]);
    r.do(U1, { type: 'fulfillClause', characterId: 'crow', contractId: id, clauseId: `${id}-1` });
    expect(r.s.economy.contracts[id].status).toBe('active');
    expect(() => r.do(U1, { type: 'fulfillClause', characterId: 'crow', contractId: id, clauseId: `${id}-2` })).toThrow(/不是你要履行/);
    r.do(U2, { type: 'fulfillClause', characterId: 'nightingale', contractId: id, clauseId: `${id}-2`, itemIds: ['moonherb-1', 'moonherb-2', 'moonherb-3'] });
    expect(r.s.economy.contracts[id].status).toBe('fulfilled');
    expect([coins(r.s, 'crow'), coins(r.s, 'nightingale')]).toEqual([35, 45]); // deposits back
    assertConservation(r);
  });

  it('at the deadline, the one party who did not perform forfeits their deposit to the other', () => {
    const r = new Run(world());
    const id = signed(r);
    r.do(U1, { type: 'fulfillClause', characterId: 'crow', contractId: id, clauseId: `${id}-1` });
    r.do(SYS, { type: 'settleDeadlines' }, LATER);
    const k = r.s.economy.contracts[id];
    expect(k.status).toBe('breached');
    expect(k.breachedBy).toEqual(['nightingale']);
    expect([coins(r.s, 'crow'), coins(r.s, 'nightingale')]).toEqual([45, 35]);
    assertConservation(r);
  });

  it('if neither performed, it is breached by both and both deposits come back', () => {
    const r = new Run(world());
    const id = signed(r);
    r.do(SYS, { type: 'settleDeadlines' }, LATER);
    expect(r.s.economy.contracts[id].breachedBy).toEqual(['crow', 'nightingale']);
    expect([coins(r.s, 'crow'), coins(r.s, 'nightingale')]).toEqual([50, 30]);
  });

  it('an unsigned proposal lapses at the deadline; an active one ends early only when both ask', () => {
    const r = new Run(world());
    r.do(U1, { type: 'proposeContract', characterId: 'crow', with: 'nightingale', title: '口頭約定', deadline: DEADLINE, deposits: { crow: 5 }, clauses: [{ kind: 'gmVerified', from: 'crow', text: '護送到遺跡' }] });
    const lapsed = Object.keys(r.s.economy.contracts)[0];
    r.do(SYS, { type: 'settleDeadlines' }, LATER);
    expect(r.s.economy.contracts[lapsed].status).toBe('cancelled');
    expect(coins(r.s, 'crow')).toBe(50);

    const r2 = new Run(world());
    const id = signed(r2);
    r2.do(U1, { type: 'requestCancelContract', characterId: 'crow', contractId: id });
    expect(r2.s.economy.contracts[id].status).toBe('active');
    r2.do(U2, { type: 'requestCancelContract', characterId: 'nightingale', contractId: id });
    expect(r2.s.economy.contracts[id].status).toBe('cancelled');
    assertConservation(r2);
  });

  it('only a GM can tick a GM-verified clause', () => {
    const r = new Run(world());
    r.do(U1, { type: 'proposeContract', characterId: 'crow', with: 'nightingale', title: '護送', deadline: DEADLINE, deposits: {}, clauses: [{ kind: 'gmVerified', from: 'nightingale', text: '護送灰鴉到遺跡' }] });
    const id = Object.keys(r.s.economy.contracts)[0];
    r.do(U2, { type: 'signContract', characterId: 'nightingale', contractId: id });
    expect(() => r.do(U2, { type: 'fulfillClause', characterId: 'nightingale', contractId: id, clauseId: `${id}-1` })).toThrow(/GM/);
    expect(() => r.do(U1, { type: 'gmVerifyClause', contractId: id, clauseId: `${id}-1` })).toThrow();
    r.do(ARB, { type: 'gmVerifyClause', contractId: id, clauseId: `${id}-1` });
    expect(r.s.economy.contracts[id].status).toBe('fulfilled');
  });

  it('a dispute freezes the contract (no deadline breach, no clauses) until a GM rules', () => {
    const r = new Run(world());
    const id = signed(r);
    r.do(U2, { type: 'raiseDispute', characterId: 'nightingale', kind: 'contract', ref: id, reason: '灰鴉說好先付錢' });
    expect(r.s.economy.contracts[id].status).toBe('disputed');
    expect(() => r.do(U1, { type: 'fulfillClause', characterId: 'crow', contractId: id, clauseId: `${id}-1` })).toThrow(/不能履行/);
    r.do(SYS, { type: 'settleDeadlines' }, LATER);
    expect(r.s.economy.contracts[id].status).toBe('disputed');
    const d = Object.keys(r.s.economy.disputes)[0];
    expect(() => r.do(U1, { type: 'gmResolveDispute', disputeId: d, outcome: 'cancel' })).toThrow();
    r.do(ARB, { type: 'gmResolveDispute', disputeId: d, outcome: { breachBy: 'crow' } });
    expect(r.s.economy.contracts[id].status).toBe('breached');
    expect(r.s.economy.disputes[d].status).toBe('resolved');
    expect([coins(r.s, 'crow'), coins(r.s, 'nightingale')]).toEqual([40, 40]);
    assertConservation(r);
  });
});

describe('who sees what', () => {
  it('trades, contracts and their escrow are visible only to the parties; shops and commissions are public', () => {
    const r = new Run(world());
    r.do(U1, { type: 'openShop', characterId: 'crow', shopId: 'crow-shop', name: '灰鴉雜貨', description: '' });
    r.do(U2, { type: 'proposeTrade', characterId: 'nightingale', to: 'crow', give: { coins: 5, itemIds: ['moonherb-1'] }, want: { coins: 0, itemIds: [] } });
    r.do(U1, { type: 'postCommission', characterId: 'crow', title: 'A', requirement: { kind: 'gm', text: 'x' }, reward: 10, deadline: DEADLINE });
    const outsider = viewFor(r.s, U3);
    const party = viewFor(r.s, U1);
    expect(Object.keys(outsider.economy.trades)).toHaveLength(0);
    expect(outsider.items['moonherb-1']).toBeUndefined();
    expect(Object.keys(party.economy.trades)).toHaveLength(1);
    expect(party.items['moonherb-1'].holder.type).toBe('escrow');
    expect(outsider.economy.shops['crow-shop']).toBeDefined();
    expect(Object.keys(outsider.economy.commissions)).toHaveLength(1);
    expect(ledgerFor(r.s, U3, r.ledger)).toHaveLength(0);
    expect(ledgerFor(r.s, U1, r.ledger).length).toBeGreaterThan(0);
    expect(ledgerFor(r.s, ARB, r.ledger)).toEqual(r.ledger);
  });
});
