import { describe, expect, it } from 'vitest';
import seed from '../config/world-seed.json';
import { RULES_V03 } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import type { AttributeCode } from '../src/rules/types';
import { WORLD_V03, applyWorld, createWorld, joinWorld, type WorldResult, type WorldSeed } from '../src/world/engine';
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
  const balances = Object.values(r.s.characters).reduce((a, c) => a + c.coins, 0) + Object.values(r.s.economy.teams).reduce((a, t) => a + t.coins, 0);
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
      type: 'proposeContract', characterId: 'crow', with: ['nightingale'], title: '月光草供貨', deadline: DEADLINE,
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

  it('if neither performed, it is breached by both and each gets back only part of the deposit', () => {
    const r = new Run(world());
    const id = signed(r);
    r.do(SYS, { type: 'settleDeadlines' }, LATER);
    expect(r.s.economy.contracts[id].breachedBy).toEqual(['crow', 'nightingale']);
    // allBreachRefundRatio 0.5: 5 of each 10-coin deposit comes back, 5 is destroyed.
    expect([coins(r.s, 'crow'), coins(r.s, 'nightingale')]).toEqual([45, 25]);
    expect(r.ledger.filter((e) => e.to.type === 'sink').map((e) => e.coins)).toEqual([5, 5]);
    assertConservation(r);
  });

  it('an unsigned proposal lapses at the deadline; an active one ends early only when both ask', () => {
    const r = new Run(world());
    r.do(U1, { type: 'proposeContract', characterId: 'crow', with: ['nightingale'], title: '口頭約定', deadline: DEADLINE, deposits: { crow: 5 }, clauses: [{ kind: 'gmVerified', from: 'crow', text: '護送到遺跡' }] });
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
    r.do(U1, { type: 'proposeContract', characterId: 'crow', with: ['nightingale'], title: '護送', deadline: DEADLINE, deposits: {}, clauses: [{ kind: 'gmVerified', from: 'nightingale', text: '護送灰鴉到遺跡' }] });
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
    r.do(ARB, { type: 'gmResolveDispute', disputeId: d, outcome: { breachBy: ['crow'] } });
    expect(r.s.economy.contracts[id].status).toBe('breached');
    expect(r.s.economy.disputes[d].status).toBe('resolved');
    expect([coins(r.s, 'crow'), coins(r.s, 'nightingale')]).toEqual([40, 40]);
    assertConservation(r);
  });
});

describe('contracts with more than two parties', () => {
  /** 灰鴉 pays 9, 夜鶯 and 鷦鷯 each deliver one herb; everyone puts up 6. */
  function three(r: Run) {
    r.s.characters.wren.coins = 0;
    r.s.items['moonherb-3'].holder = { type: 'character', id: 'wren' };
    r.do(MAIN, { type: 'gmGrantCoins', characterId: 'wren', amount: 10, reason: '測試' });
    r.do(U1, {
      type: 'proposeContract', characterId: 'crow', with: ['nightingale', 'wren'], title: '三方採集', deadline: DEADLINE,
      deposits: { crow: 6, nightingale: 6, wren: 6 },
      clauses: [
        { kind: 'payCoins', from: 'crow', to: 'nightingale', amount: 9 },
        { kind: 'deliverItem', from: 'nightingale', to: 'crow', itemId: 'moonherb-1' },
        { kind: 'deliverItem', from: 'wren', to: 'crow', itemId: 'moonherb-3' },
      ],
    });
    return Object.keys(r.s.economy.contracts)[0];
  }

  it('is active only once every party has signed', () => {
    const r = new Run(world());
    const id = three(r);
    r.do(U2, { type: 'signContract', characterId: 'nightingale', contractId: id });
    expect(r.s.economy.contracts[id].status).toBe('proposed');
    expect(() => r.do(U2, { type: 'fulfillClause', characterId: 'nightingale', contractId: id, clauseId: `${id}-2` })).toThrow(/不能履行/);
    r.do(U3, { type: 'signContract', characterId: 'wren', contractId: id });
    expect(r.s.economy.contracts[id].status).toBe('active');
    assertConservation(r);
  });

  it('splits a breaching party\'s deposit among those who kept their word', () => {
    const r = new Run(world());
    const id = three(r);
    r.do(U2, { type: 'signContract', characterId: 'nightingale', contractId: id });
    r.do(U3, { type: 'signContract', characterId: 'wren', contractId: id });
    r.do(U1, { type: 'fulfillClause', characterId: 'crow', contractId: id, clauseId: `${id}-1` });
    r.do(U2, { type: 'fulfillClause', characterId: 'nightingale', contractId: id, clauseId: `${id}-2` });
    expect(r.s.economy.contracts[id].status).toBe('active'); // 鷦鷯 still owes
    r.do(SYS, { type: 'settleDeadlines' }, LATER);
    expect(r.s.economy.contracts[id].breachedBy).toEqual(['wren']);
    // crow: 50 - 9 = 41, + own 6 back + 3; nightingale: 30 + 9 = 39, + own 6 back + 3; wren loses 6.
    expect([coins(r.s, 'crow'), coins(r.s, 'nightingale'), coins(r.s, 'wren')]).toEqual([44, 42, 4]);
    assertConservation(r);
  });

  it('a lone holdout can block mutual cancellation; anyone can still walk away before it is active', () => {
    const r = new Run(world());
    const id = three(r);
    r.do(U2, { type: 'signContract', characterId: 'nightingale', contractId: id });
    r.do(U3, { type: 'signContract', characterId: 'wren', contractId: id });
    r.do(U1, { type: 'requestCancelContract', characterId: 'crow', contractId: id });
    r.do(U2, { type: 'requestCancelContract', characterId: 'nightingale', contractId: id });
    expect(r.s.economy.contracts[id].status).toBe('active');
    r.do(U3, { type: 'requestCancelContract', characterId: 'wren', contractId: id });
    expect(r.s.economy.contracts[id].status).toBe('cancelled');

    const r2 = new Run(world());
    const id2 = three(r2);
    r2.do(U3, { type: 'requestCancelContract', characterId: 'wren', contractId: id2 });
    expect(r2.s.economy.contracts[id2].status).toBe('cancelled');
    expect(coins(r2.s, 'crow')).toBe(50);
    assertConservation(r2);
  });

  it('caps the number of parties and rejects duplicates', () => {
    const r = new Run(world());
    const base = { type: 'proposeContract' as const, characterId: 'crow', title: 'x', deadline: DEADLINE, deposits: {}, clauses: [{ kind: 'gmVerified' as const, from: 'crow', text: 'x' }] };
    expect(() => r.do(U1, { ...base, with: [] })).toThrow(/兩位/);
    expect(() => r.do(U1, { ...base, with: ['nightingale', 'nightingale'] })).toThrow(/兩次/);
    expect(() => applyWorld(r.s, { actor: U1, command: { ...base, with: ['nightingale', 'wren'] } }, R, scriptedRng([]), T0,
      { ...WORLD_V03, economy: { ...WORLD_V03.economy, contractMaxParties: 2 } })).toThrow(/最多 2/);
  });

  it('a GM can find several parties in breach at once', () => {
    const r = new Run(world());
    const id = three(r);
    r.do(U2, { type: 'signContract', characterId: 'nightingale', contractId: id });
    r.do(U3, { type: 'signContract', characterId: 'wren', contractId: id });
    r.do(U1, { type: 'raiseDispute', characterId: 'crow', kind: 'contract', ref: id, reason: '兩人都沒交貨' });
    const d = Object.keys(r.s.economy.disputes)[0];
    r.do(ARB, { type: 'gmResolveDispute', disputeId: d, outcome: { breachBy: ['nightingale', 'wren'] } });
    // Both forfeited deposits go to 灰鴉, the only party who kept the contract.
    expect([coins(r.s, 'crow'), coins(r.s, 'nightingale'), coins(r.s, 'wren')]).toEqual([62, 24, 4]);
    assertConservation(r);
  });
});

describe('teams and their shared treasury', () => {
  const T = 'crows';
  /** 灰鴉 leads, 夜鶯 and 鷦鷯 join. */
  function crew(r: Run, policy: 'leader' | 'majority' = 'leader') {
    r.do(U1, { type: 'createTeam', characterId: 'crow', teamId: T, name: '鴉群', policy });
    for (const [u, id] of [[U2, 'nightingale'], [U3, 'wren']] as const) {
      r.do(U1, { type: 'inviteToTeam', characterId: 'crow', teamId: T, targetId: id });
      r.do(u, { type: 'respondTeamInvite', characterId: id, teamId: T, accept: true });
    }
    return r.s.economy.teams[T];
  }

  it('members pay into one treasury and items deposited are held by the team', () => {
    const r = new Run(world());
    crew(r);
    expect(r.s.economy.teams[T].members).toEqual(['crow', 'nightingale', 'wren']);
    r.do(U2, { type: 'depositToTeam', characterId: 'nightingale', teamId: T, coins: 20, itemIds: ['moonherb-1'] });
    r.do(U1, { type: 'depositToTeam', characterId: 'crow', teamId: T, coins: 10, itemIds: [] });
    expect(r.s.economy.teams[T].coins).toBe(30);
    expect(holder(r.s, 'moonherb-1')).toEqual({ type: 'team', id: T });
    expect(() => r.do(U3, { type: 'depositToTeam', characterId: 'wren', teamId: T, coins: 1, itemIds: [] })).toThrow(/不夠/);
    // Team coins count toward the total: nothing was created or lost.
    const total = Object.values(r.s.characters).reduce((a, c) => a + c.coins, 0) + r.s.economy.teams[T].coins;
    expect(total).toBe(80);
  });

  it('under the leader policy the leader withdraws alone; other members need a majority', () => {
    const r = new Run(world());
    crew(r);
    r.do(U2, { type: 'depositToTeam', characterId: 'nightingale', teamId: T, coins: 30, itemIds: [] });
    r.do(U1, { type: 'proposeTeam', characterId: 'crow', teamId: T, motion: { kind: 'withdraw', to: 'wren', coins: 10, itemIds: [] } });
    expect(coins(r.s, 'wren')).toBe(10);
    r.do(U2, { type: 'proposeTeam', characterId: 'nightingale', teamId: T, motion: { kind: 'withdraw', to: 'nightingale', coins: 20, itemIds: [] } });
    const p = r.s.economy.teams[T].proposals.at(-1)!;
    expect(p.status).toBe('open'); // 1 of 3
    expect(coins(r.s, 'nightingale')).toBe(0);
    r.do(U3, { type: 'voteTeam', characterId: 'wren', teamId: T, proposalId: p.id, approve: true });
    expect(r.s.economy.teams[T].proposals.at(-1)!.status).toBe('passed');
    expect(coins(r.s, 'nightingale')).toBe(20);
    expect(r.s.economy.teams[T].coins).toBe(0);
  });

  it('under majority rule even the leader must win a vote, and two no votes of three kill a motion', () => {
    const r = new Run(world());
    crew(r, 'majority');
    r.do(U1, { type: 'depositToTeam', characterId: 'crow', teamId: T, coins: 30, itemIds: [] });
    r.do(U1, { type: 'proposeTeam', characterId: 'crow', teamId: T, motion: { kind: 'withdraw', to: 'crow', coins: 30, itemIds: [] } });
    const pid = r.s.economy.teams[T].proposals[0].id;
    expect(coins(r.s, 'crow')).toBe(20);
    r.do(U2, { type: 'voteTeam', characterId: 'nightingale', teamId: T, proposalId: pid, approve: false });
    r.do(U3, { type: 'voteTeam', characterId: 'wren', teamId: T, proposalId: pid, approve: false });
    expect(r.s.economy.teams[T].proposals[0].status).toBe('rejected');
    expect(() => r.do(U2, { type: 'voteTeam', characterId: 'nightingale', teamId: T, proposalId: pid, approve: true })).toThrow(/已經結束/);
    expect(r.s.economy.teams[T].coins).toBe(30);
  });

  it('a motion that passes after the treasury was emptied is void, not paid twice', () => {
    const r = new Run(world());
    crew(r, 'majority');
    r.do(U1, { type: 'depositToTeam', characterId: 'crow', teamId: T, coins: 10, itemIds: [] });
    r.do(U1, { type: 'proposeTeam', characterId: 'crow', teamId: T, motion: { kind: 'withdraw', to: 'crow', coins: 10, itemIds: [] } });
    r.do(U2, { type: 'proposeTeam', characterId: 'nightingale', teamId: T, motion: { kind: 'withdraw', to: 'nightingale', coins: 10, itemIds: [] } });
    const [a, b] = r.s.economy.teams[T].proposals.map((p) => p.id);
    r.do(U3, { type: 'voteTeam', characterId: 'wren', teamId: T, proposalId: a, approve: true });
    r.do(U3, { type: 'voteTeam', characterId: 'wren', teamId: T, proposalId: b, approve: true });
    expect(r.s.economy.teams[T].proposals.map((p) => p.status)).toEqual(['passed', 'void']);
    expect([coins(r.s, 'crow'), coins(r.s, 'nightingale'), r.s.economy.teams[T].coins]).toEqual([50, 30, 0]);
  });

  it('dead members stop counting toward a majority, and a dead leader hands over to the next living member', () => {
    const r = new Run(world());
    crew(r, 'majority');
    r.do(U2, { type: 'depositToTeam', characterId: 'nightingale', teamId: T, coins: 10, itemIds: [] });
    r.s.characters.crow.status = 'dead';
    r.do(U2, { type: 'proposeTeam', characterId: 'nightingale', teamId: T, motion: { kind: 'withdraw', to: 'nightingale', coins: 10, itemIds: [] } });
    expect(r.s.economy.teams[T].proposals[0].status).toBe('open'); // 1 of 2 living is not more than half
    r.do(U3, { type: 'voteTeam', characterId: 'wren', teamId: T, proposalId: r.s.economy.teams[T].proposals[0].id, approve: true });
    expect(coins(r.s, 'nightingale')).toBe(30);
    expect(() => r.do(U3, { type: 'inviteToTeam', characterId: 'wren', teamId: T, targetId: 'crow' })).toThrow(/隊長/);
    r.s.characters.nightingale.online = true;
    expect(() => r.do(U2, { type: 'inviteToTeam', characterId: 'nightingale', teamId: T, targetId: 'crow' })).toThrow(/死亡/);
  });

  it('leaving keeps deposits in the treasury; the last member must empty it; disbanding needs an empty treasury', () => {
    const r = new Run(world());
    crew(r);
    r.do(U2, { type: 'depositToTeam', characterId: 'nightingale', teamId: T, coins: 6, itemIds: [] });
    r.do(U2, { type: 'leaveTeam', characterId: 'nightingale', teamId: T });
    expect(r.s.economy.teams[T].coins).toBe(6);
    expect(() => r.do(U1, { type: 'proposeTeam', characterId: 'crow', teamId: T, motion: { kind: 'disband' } })).toThrow(/分配完/);
    r.do(U1, { type: 'leaveTeam', characterId: 'crow', teamId: T });
    expect(r.s.economy.teams[T].leaderId).toBe('wren');
    expect(() => r.do(U3, { type: 'leaveTeam', characterId: 'wren', teamId: T })).toThrow(/領完/);
    r.do(U3, { type: 'proposeTeam', characterId: 'wren', teamId: T, motion: { kind: 'withdraw', to: 'wren', coins: 6, itemIds: [] } });
    r.do(U3, { type: 'proposeTeam', characterId: 'wren', teamId: T, motion: { kind: 'disband' } });
    expect(r.s.economy.teams[T].status).toBe('disbanded');
  });

  it('kicks need a vote and cannot target the leader; a character is in one team at a time', () => {
    const r = new Run(world());
    crew(r);
    expect(() => r.do(U2, { type: 'proposeTeam', characterId: 'nightingale', teamId: T, motion: { kind: 'kick', target: 'crow' } })).toThrow(/隊長以外/);
    r.do(U1, { type: 'proposeTeam', characterId: 'crow', teamId: T, motion: { kind: 'kick', target: 'wren' } });
    r.do(U2, { type: 'voteTeam', characterId: 'nightingale', teamId: T, proposalId: r.s.economy.teams[T].proposals[0].id, approve: true });
    expect(r.s.economy.teams[T].members).toEqual(['crow', 'nightingale']);
    expect(() => r.do(U2, { type: 'createTeam', characterId: 'nightingale', teamId: 'x', name: 'x', policy: 'leader' })).toThrow(/已經在一支隊伍/);
  });

  it('outsiders see the roster but not the treasury, votes or team-held items', () => {
    const r = new Run(world());
    r.do(U1, { type: 'createTeam', characterId: 'crow', teamId: T, name: '鴉群', policy: 'leader' });
    r.do(U1, { type: 'depositToTeam', characterId: 'crow', teamId: T, coins: 10, itemIds: ['lantern'] });
    const out = viewFor(r.s, U2);
    expect(out.economy.teams[T].members).toEqual(['crow']);
    expect(out.economy.teams[T].coins).toBe(0);
    expect(out.items.lantern).toBeUndefined();
    expect(ledgerFor(r.s, U2, r.ledger)).toHaveLength(0);
    const own = viewFor(r.s, U1);
    expect(own.economy.teams[T].coins).toBe(10);
    expect(own.items.lantern.holder).toEqual({ type: 'team', id: T });
  });
});

describe('a team as a party to contracts and commissions', () => {
  const T = 'crows';
  const TK = 'team:crows';
  /** 灰鴉 (leader) and 夜鶯 share a 30-coin treasury; 鷦鷯 is outside. */
  function pair(r: Run, policy: 'leader' | 'majority' = 'leader') {
    r.do(U1, { type: 'createTeam', characterId: 'crow', teamId: T, name: '鴉群', policy });
    r.do(U1, { type: 'inviteToTeam', characterId: 'crow', teamId: T, targetId: 'nightingale' });
    r.do(U2, { type: 'respondTeamInvite', characterId: 'nightingale', teamId: T, accept: true });
    r.do(U1, { type: 'depositToTeam', characterId: 'crow', teamId: T, coins: 30, itemIds: [] });
    r.do(MAIN, { type: 'gmGrantCoins', characterId: 'wren', amount: 20, reason: '測試' });
  }
  /** Proposes a team action and has 夜鶯 vote for it. */
  const act = (r: Run, command: WorldCommand) => {
    r.do(U1, { type: 'proposeTeam', characterId: 'crow', teamId: T, motion: { kind: 'act', command: command as never } });
    const p = r.s.economy.teams[T].proposals.at(-1)!;
    if (p.status === 'open') r.do(U2, { type: 'voteTeam', characterId: 'nightingale', teamId: T, proposalId: p.id, approve: true });
    return r.s.economy.teams[T].proposals.at(-1)!;
  };

  it('nobody can act in the team\'s name without a vote, not even the leader', () => {
    const r = new Run(world());
    pair(r);
    expect(() => r.do(U1, { type: 'postCommission', characterId: TK, title: 'x', requirement: { kind: 'gm', text: 'x' }, reward: 5, deadline: DEADLINE })).toThrow(/投票/);
    expect(() => r.do(U1, { type: 'proposeContract', characterId: TK, with: ['wren'], title: 'x', deadline: DEADLINE, deposits: {}, clauses: [{ kind: 'gmVerified', from: TK, text: 'x' }] })).toThrow(/投票/);
  });

  it('a commission posted by vote is paid from the treasury, and its reward returns there if cancelled', () => {
    const r = new Run(world());
    pair(r);
    const p = act(r, { type: 'postCommission', characterId: TK, title: '找回遺失的鐘錘', requirement: { kind: 'gm', text: '帶回鐘錘' }, reward: 12, deadline: DEADLINE });
    expect(p.status).toBe('passed');
    const k = Object.values(r.s.economy.commissions)[0];
    expect(k.issuerId).toBe(TK);
    expect(r.s.economy.teams[T].coins).toBe(18);
    r.do(U3, { type: 'acceptCommission', characterId: 'wren', commissionId: k.id });
    r.do(U3, { type: 'submitCommission', characterId: 'wren', commissionId: k.id, itemIds: [] });
    r.do(MAIN, { type: 'reviewCommission', characterId: '', commissionId: k.id, approve: true });
    expect(coins(r.s, 'wren')).toBe(32);
    assertConservation(r);
  });

  it('a motion the team could not carry out is refused when proposed, before anyone votes', () => {
    const r = new Run(world());
    pair(r);
    expect(() => r.do(U1, { type: 'proposeTeam', characterId: 'crow', teamId: T, motion: { kind: 'act', command: { type: 'postCommission', characterId: TK, title: 'x', requirement: { kind: 'gm', text: 'x' }, reward: 99, deadline: DEADLINE } } }))
      .toThrow(/不夠/);
    expect(() => r.do(U1, { type: 'proposeTeam', characterId: 'crow', teamId: T, motion: { kind: 'act', command: { type: 'postCommission', characterId: 'team:other', title: 'x', requirement: { kind: 'gm', text: 'x' }, reward: 1, deadline: DEADLINE } } }))
      .toThrow(/這支隊伍/);
    expect(r.s.economy.teams[T].coins).toBe(30);
  });

  it('signs a contract by vote, pays from the treasury and receives items into it; breaching costs the team its deposit', () => {
    const r = new Run(world());
    pair(r);
    r.s.items['moonherb-3'].holder = { type: 'character', id: 'wren' };
    r.do(U3, {
      type: 'proposeContract', characterId: 'wren', with: [TK], title: '月光草換錢', deadline: DEADLINE, deposits: { wren: 4, [TK]: 6 },
      clauses: [{ kind: 'deliverItem', from: 'wren', to: TK, itemId: 'moonherb-3' }, { kind: 'payCoins', from: TK, to: 'wren', amount: 10 }],
    });
    const id = Object.keys(r.s.economy.contracts)[0];
    act(r, { type: 'signContract', characterId: TK, contractId: id });
    expect(r.s.economy.contracts[id].status).toBe('active');
    expect(r.s.economy.teams[T].coins).toBe(24); // deposit locked from the treasury
    r.do(U3, { type: 'fulfillClause', characterId: 'wren', contractId: id, clauseId: `${id}-1` });
    expect(holder(r.s, 'moonherb-3')).toEqual({ type: 'team', id: T });
    r.do(SYS, { type: 'settleDeadlines' }, LATER); // the team never voted to pay
    expect(r.s.economy.contracts[id].breachedBy).toEqual([TK]);
    expect(coins(r.s, 'wren')).toBe(26); // 20 - 4 + 4 back + 6 forfeited by the team
    expect(r.s.economy.teams[T].coins).toBe(24);
    assertConservation(r);
  });

  it('pays a clause by vote and the contract completes', () => {
    const r = new Run(world());
    pair(r);
    r.do(U3, { type: 'proposeContract', characterId: 'wren', with: [TK], title: '護衛費', deadline: DEADLINE, deposits: {}, clauses: [{ kind: 'payCoins', from: TK, to: 'wren', amount: 10 }] });
    const id = Object.keys(r.s.economy.contracts)[0];
    act(r, { type: 'signContract', characterId: TK, contractId: id });
    act(r, { type: 'fulfillClause', characterId: TK, contractId: id, clauseId: `${id}-1` });
    expect(r.s.economy.contracts[id].status).toBe('fulfilled');
    expect([coins(r.s, 'wren'), r.s.economy.teams[T].coins]).toEqual([30, 20]);
  });

  it('members of the team see its contracts; outsiders do not', () => {
    const r = new Run(world());
    pair(r);
    r.do(U3, { type: 'proposeContract', characterId: 'wren', with: [TK], title: '護衛費', deadline: DEADLINE, deposits: { wren: 2 }, clauses: [{ kind: 'payCoins', from: TK, to: 'wren', amount: 10 }] });
    expect(Object.keys(viewFor(r.s, U2).economy.contracts)).toHaveLength(1);
    r.do(U2, { type: 'leaveTeam', characterId: 'nightingale', teamId: T });
    expect(Object.keys(viewFor(r.s, U2).economy.contracts)).toHaveLength(0);
    expect(Object.keys(viewFor(r.s, U1).economy.locks)).toHaveLength(1);
  });

  it('the team decides by vote whether a member\'s afterimage loss also hits their share of the treasury', () => {
    const r = new Run(world());
    pair(r);
    const expire = (rr: Run) => {
      rr.s.characters.crow.online = false;
      rr.s.characters.crow.afterimageUntil = T0.toISOString();
      rr.do(SYS, { type: 'expireAfterimages' }, LATER);
    };
    const off = new Run(structuredClone(r.s));
    expire(off);
    expect(off.s.economy.teams[T].coins).toBe(30); // default: the treasury is untouched
    r.do(U1, { type: 'proposeTeam', characterId: 'crow', teamId: T, motion: { kind: 'afterimage', share: true } });
    r.do(U2, { type: 'voteTeam', characterId: 'nightingale', teamId: T, proposalId: r.s.economy.teams[T].proposals[0].id, approve: true });
    expect(r.s.economy.teams[T].afterimageShare).toBe(true);
    expire(r);
    // crow's share is 30 / 2 living members = 15; 10% of it, rounded down, is 1.
    expect(r.s.economy.teams[T].coins).toBe(29);
    expect(r.ledger.at(-1)).toMatchObject({ from: { type: 'team', id: T }, to: { type: 'sink' }, coins: 1 });
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
