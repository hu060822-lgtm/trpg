// Phase 4: shops, direct trades, commissions and contracts on top of the shared world.
// Every coin or item movement goes through lock/transfer helpers that write the ledger, so balances
// can always be recomputed and nothing is ever moved without a record.
import type { Ctx, Helpers } from './engine';
import type {
  Bundle, Clause, Commission, Contract, Dispute, EconomyCommand, Item, LedgerEntry, Lock, Party, Shop, Trade, WorldCharacter,
} from './types';

type Fail = (code: string, message: string) => never;

/** Commands that move coins or items between players; the store requires a request id for each. */
export const ECONOMY_COMMANDS: ReadonlySet<string> = new Set<EconomyCommand['type']>([
  'gmGrantCoins', 'openShop', 'setShopOpen', 'stockItem', 'unstockItem', 'buy', 'proposeTrade', 'acceptTrade', 'declineTrade', 'cancelTrade',
  'postCommission', 'acceptCommission', 'submitCommission', 'reviewCommission', 'cancelCommission', 'proposeContract', 'signContract',
  'fulfillClause', 'requestCancelContract', 'raiseDispute', 'gmVerifyClause', 'gmResolveDispute', 'settleDeadlines',
]);

/** Where each economy entity kind lives in WorldState.economy. */
export const ECONOMY_COLLECTIONS = {
  shop: 'shops', trade: 'trades', commission: 'commissions', contract: 'contracts', lock: 'locks', dispute: 'disputes',
} as const;

export function performEconomy(ctx: Ctx, cmd: EconomyCommand, h: Helpers): void {
  const { s } = ctx;
  const eco = s.economy;
  const fail: Fail = (code, message) => { throw new h.WorldError(code, message); };
  const tx = `T${s.seq + 1}`;
  const nextId = (prefix: string) => `${prefix}${s.seq + 1}`;
  const name = (id: string) => s.characters[id]?.name ?? id;
  const coinsOk = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;

  // ---------- ledger and asset movement ----------

  const ledger = (from: Party, to: Party, what: { coins?: number; itemId?: string }, reason: string) => {
    s.seq += 1;
    const e: LedgerEntry = { seq: s.seq, at: ctx.now.toISOString(), tx, from, to, ...what, reason };
    ctx.ledger.push(e);
  };
  const ch = (id: string): Party => ({ type: 'character', id });

  const addCoins = (c: WorldCharacter, delta: number, basis: string) => {
    if (c.coins + delta < 0) fail('insufficient-coins', `${c.name} 的錢幣不夠（有 ${c.coins}，需要 ${-delta}）`);
    h.change(ctx, 'character', c.id, c, basis, false, (t) => { t.coins += delta; });
  };

  /** An item a character can hand over: theirs, present, tradable, unbound and not frozen. */
  const handable = (c: WorldCharacter, id: string): Item => {
    const i = h.item(ctx, id);
    if (i.holder.type !== 'character' || i.holder.id !== c.id) fail('not-yours', `${c.name} 沒有${i.name}`);
    h.movable(i);
    if (!i.tradable || i.boundTo) fail('bound', `${i.name} 已綁定，不能交易`);
    return i;
  };

  const checkBundle = (b: Bundle) => {
    if (!coinsOk(b.coins)) fail('bad-amount', '錢幣數量必須是 0 以上的整數');
    if (new Set(b.itemIds).size !== b.itemIds.length) fail('bad-items', '同一件物品不能列兩次');
  };

  const moveItem = (i: Item, to: Item['holder'], reason: string) => {
    const from = { ...i.holder };
    h.change(ctx, 'item', i.id, i, reason, true, (t) => { t.holder = to; });
    ledger(from, to, { itemId: i.id }, reason);
  };

  /** Character → character, all or nothing (validated before anything moves). */
  const transfer = (from: WorldCharacter, to: WorldCharacter, b: Bundle, reason: string) => {
    checkBundle(b);
    const items = b.itemIds.map((id) => handable(from, id));
    if (from.coins < b.coins) fail('insufficient-coins', `${from.name} 的錢幣不夠（有 ${from.coins}，需要 ${b.coins}）`);
    if (b.coins) {
      addCoins(from, -b.coins, reason);
      addCoins(to, b.coins, reason);
      ledger(ch(from.id), ch(to.id), { coins: b.coins }, reason);
    }
    for (const i of items) moveItem(i, { type: 'character', id: to.id }, reason);
  };

  /** Sets assets aside: coins leave the balance, items move to the escrow holder. */
  const lock = (owner: WorldCharacter, b: Bundle, purpose: Lock['purpose'], ref: string): Lock => {
    checkBundle(b);
    const items = b.itemIds.map((id) => handable(owner, id));
    if (owner.coins < b.coins) fail('insufficient-coins', `${owner.name} 的錢幣不夠（有 ${owner.coins}，需要 ${b.coins}）`);
    const id = nextId('L');
    const l: Lock = { id, ownerId: owner.id, purpose, ref, coins: b.coins, itemIds: [...b.itemIds], status: 'held', version: 1 };
    eco.locks[id] = l;
    h.audit(ctx, 'lock', id, null, h.clone(l), `lock for ${ref}`, true);
    if (b.coins) {
      addCoins(owner, -b.coins, `lock ${id}`);
      ledger(ch(owner.id), { type: 'escrow', id }, { coins: b.coins }, `lock ${id} (${ref})`);
    }
    for (const i of items) moveItem(i, { type: 'escrow', id }, `lock ${id} (${ref})`);
    return l;
  };

  /** Ends a lock: everything in it goes to `to` (the owner on a refund, someone else when consumed). */
  const release = (lockId: string, to: string, reason: string) => {
    const l = eco.locks[lockId];
    if (!l || l.status !== 'held') fail('lock-closed', `鎖定 ${lockId} 已經結算`);
    const target = h.character(ctx, to);
    if (l.coins) {
      addCoins(target, l.coins, reason);
      ledger({ type: 'escrow', id: l.id }, ch(to), { coins: l.coins }, reason);
    }
    for (const id of l.itemIds) moveItem(h.item(ctx, id), { type: 'character', id: to }, reason);
    h.change(ctx, 'lock', l.id, l, reason, false, (t) => { t.status = to === l.ownerId ? 'released' : 'consumed'; });
  };

  const tell = (to: string[], kind: string, text: string, data: Record<string, unknown> = {}) => {
    h.privateEvent(ctx, to, kind, text, data);
    h.gmEvent(ctx, kind, text, data);
  };

  const deadlineOk = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()) || d <= ctx.now) fail('bad-deadline', '期限必須是未來的時間');
  };

  const shop = (id: string): Shop => eco.shops[id] ?? fail('unknown-shop', `找不到商店 ${id}`);
  const ownShop = (c: WorldCharacter, id: string): Shop => {
    const sh = shop(id);
    if (sh.ownerId !== c.id) fail('forbidden', '這不是你的商店');
    return sh;
  };
  const trade = (id: string): Trade => eco.trades[id] ?? fail('unknown-trade', `找不到交易 ${id}`);
  const commission = (id: string): Commission => eco.commissions[id] ?? fail('unknown-commission', `找不到委託 ${id}`);
  const contract = (id: string): Contract => eco.contracts[id] ?? fail('unknown-contract', `找不到契約 ${id}`);

  /** Template items a character holds, checked for a delivery of exactly qty items. */
  const templateItems = (c: WorldCharacter, ids: string[], template: string, qty: number) => {
    if (ids.length !== qty) fail('wrong-quantity', `需要剛好 ${qty} 件`);
    const items = ids.map((id) => handable(c, id));
    const wrong = items.find((i) => i.template !== template);
    if (wrong) fail('wrong-item', `${wrong.name} 不符合要求`);
    return items;
  };

  // ---------- contracts ----------

  const refundDeposits = (k: Contract, reason: string) => {
    for (const [party, lockId] of Object.entries(k.depositLocks)) if (eco.locks[lockId]?.status === 'held') release(lockId, party, reason);
  };

  const closeContract = (k: Contract, status: Contract['status'], basis: string, breachedBy?: string[]) => {
    h.change(ctx, 'contract', k.id, k, basis, false, (t) => { t.status = status; if (breachedBy) t.breachedBy = breachedBy; });
  };

  /** Breach: a lone breaching party forfeits their deposit to the other; if both breached, both get theirs back. */
  const breach = (k: Contract, by: string[], basis: string) => {
    if (by.length === 1) {
      const other = k.parties.find((p) => p !== by[0])!;
      const forfeit = k.depositLocks[by[0]];
      if (forfeit && eco.locks[forfeit]?.status === 'held') release(forfeit, other, `breach of ${k.id}: deposit forfeited`);
    }
    refundDeposits(k, `contract ${k.id} closed`);
    closeContract(k, 'breached', basis, by);
    tell(k.parties, 'contractBreached', `契約「${k.title}」違約：${by.map(name).join('、')}${by.length === 1 ? '的押金歸對方' : '雙方都未履行，押金各自退回'}`, { contractId: k.id, by });
  };

  const maybeFulfilled = (k: Contract) => {
    if (!k.clauses.every((c) => c.done)) return;
    refundDeposits(k, `contract ${k.id} fulfilled`);
    closeContract(k, 'fulfilled', 'all clauses done');
    tell(k.parties, 'contractFulfilled', `契約「${k.title}」所有條款都已履行，押金退回雙方`, { contractId: k.id });
  };

  switch (cmd.type) {
    case 'gmGrantCoins': {
      h.requireGm(ctx, ['main']);
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) fail('bad-amount', '金額必須是正整數');
      const c = h.character(ctx, cmd.characterId);
      addCoins(c, cmd.amount, `grant: ${cmd.reason}`);
      ledger({ type: 'mint', id: ctx.actor.userId }, ch(c.id), { coins: cmd.amount }, `grant: ${cmd.reason}`);
      tell([c.id], 'coinsGranted', `${c.name} 獲得 ${cmd.amount} 枚錢幣（${cmd.reason}）`, { amount: cmd.amount });
      return;
    }

    // ---------- shops ----------
    case 'openShop': {
      const c = h.active(ctx, cmd.characterId);
      if (eco.shops[cmd.shopId]) fail('shop-exists', '這個商店代號已經被使用');
      const sh: Shop = { id: cmd.shopId, ownerId: c.id, locationId: c.locationId, name: cmd.name, description: cmd.description, open: true, listings: [], version: 1 };
      eco.shops[sh.id] = sh;
      h.audit(ctx, 'shop', sh.id, null, h.clone(sh), 'open shop', true);
      h.emit(ctx, { kind: 'shopOpened', text: `${c.name} 在${s.locations[c.locationId].name}開了「${sh.name}」`, visibility: 'public', locationId: c.locationId, data: { shopId: sh.id } });
      return;
    }
    case 'setShopOpen': {
      const sh = ownShop(h.own(ctx, cmd.characterId), cmd.shopId);
      h.change(ctx, 'shop', sh.id, sh, cmd.open ? 'open' : 'close', true, (t) => { t.open = cmd.open; });
      h.emit(ctx, { kind: 'shopStatus', text: `「${sh.name}」${cmd.open ? '開始營業' : '暫停營業'}`, visibility: 'public', locationId: sh.locationId, data: { shopId: sh.id } });
      return;
    }
    case 'stockItem': {
      const c = h.active(ctx, cmd.characterId);
      const sh = ownShop(c, cmd.shopId);
      if (!Number.isInteger(cmd.price) || cmd.price < 1) fail('bad-price', '價格必須是正整數');
      const i = handable(c, cmd.itemId);
      moveItem(i, { type: 'shop', id: sh.id }, `stock ${sh.id}`);
      h.change(ctx, 'shop', sh.id, sh, `list ${i.id}`, true, (t) => { t.listings.push({ itemId: i.id, price: cmd.price }); });
      tell([c.id], 'stocked', `「${sh.name}」上架${i.name}，售價 ${cmd.price}`, { shopId: sh.id, itemId: i.id });
      return;
    }
    case 'unstockItem': {
      const c = h.own(ctx, cmd.characterId);
      const sh = ownShop(c, cmd.shopId);
      if (!sh.listings.some((l) => l.itemId === cmd.itemId)) fail('not-listed', '這件商品沒有上架');
      const i = h.item(ctx, cmd.itemId);
      moveItem(i, { type: 'character', id: c.id }, `unstock ${sh.id}`);
      h.change(ctx, 'shop', sh.id, sh, `unlist ${i.id}`, true, (t) => { t.listings = t.listings.filter((l) => l.itemId !== i.id); });
      tell([c.id], 'unstocked', `「${sh.name}」下架${i.name}`, { shopId: sh.id, itemId: i.id });
      return;
    }
    case 'buy': {
      const buyer = h.active(ctx, cmd.characterId);
      const sh = shop(cmd.shopId);
      if (!sh.open) fail('shop-closed', `「${sh.name}」目前沒有營業`);
      if (sh.ownerId === buyer.id) fail('own-shop', '不能買自己店裡的東西');
      if (buyer.locationId !== sh.locationId) fail('not-here', `要在${s.locations[sh.locationId].name}才能在這家店買東西`);
      const listing = sh.listings.find((l) => l.itemId === cmd.itemId) ?? fail('not-listed', '這件商品已經賣出或下架');
      const i = h.item(ctx, cmd.itemId);
      // The listing is only as good as the item it points at.
      if (i.holder.type !== 'shop' || i.holder.id !== sh.id || i.status !== 'present') fail('inconsistent-stock', '庫存與商品不一致，交易取消');
      const owner = h.character(ctx, sh.ownerId);
      addCoins(buyer, -listing.price, `buy ${i.id}`);
      addCoins(owner, listing.price, `sale ${i.id}`);
      ledger(ch(buyer.id), ch(owner.id), { coins: listing.price }, `buy ${i.name} at ${sh.id}`);
      moveItem(i, { type: 'character', id: buyer.id }, `buy ${i.name} at ${sh.id}`);
      h.change(ctx, 'shop', sh.id, sh, `sold ${i.id}`, false, (t) => { t.listings = t.listings.filter((l) => l.itemId !== i.id); });
      tell([buyer.id, owner.id], 'sale', `${buyer.name} 在「${sh.name}」以 ${listing.price} 枚錢幣買下${i.name}`, { shopId: sh.id, itemId: i.id, price: listing.price });
      return;
    }

    // ---------- direct trades ----------
    case 'proposeTrade': {
      const c = h.active(ctx, cmd.characterId);
      const to = h.character(ctx, cmd.to);
      if (to.id === c.id || to.status === 'dead') fail('bad-target', '不能和這個角色交易');
      checkBundle(cmd.want);
      const id = nextId('X');
      const l = lock(c, cmd.give, 'trade', id);
      const t: Trade = { id, from: c.id, to: to.id, give: cmd.give, want: cmd.want, lockId: l.id, status: 'pending', version: 1 };
      eco.trades[id] = t;
      h.audit(ctx, 'trade', id, null, h.clone(t), 'propose trade', true);
      tell([c.id, to.id], 'tradeProposed', `${c.name} 向 ${to.name} 提出交易（提出的東西已先鎖定）`, { tradeId: id });
      return;
    }
    case 'acceptTrade': {
      const c = h.active(ctx, cmd.characterId);
      const t = trade(cmd.tradeId);
      if (t.to !== c.id) fail('forbidden', '這份交易不是給你的');
      if (t.status !== 'pending') fail('trade-closed', '這份交易已經結束');
      const from = h.character(ctx, t.from);
      if (from.status === 'dead') fail('bad-target', `${from.name} 已經死亡`);
      if (from.locationId !== c.locationId) fail('not-here', '雙方要在同一個地點才能完成交易');
      transfer(c, from, t.want, `trade ${t.id}`);
      release(t.lockId, c.id, `trade ${t.id}`);
      h.change(ctx, 'trade', t.id, t, 'accepted', false, (x) => { x.status = 'completed'; });
      tell([t.from, t.to], 'tradeCompleted', `${from.name} 與 ${c.name} 完成交易`, { tradeId: t.id });
      return;
    }
    case 'declineTrade':
    case 'cancelTrade': {
      const c = h.own(ctx, cmd.characterId);
      const t = trade(cmd.tradeId);
      if ((cmd.type === 'declineTrade' ? t.to : t.from) !== c.id) fail('forbidden', '你不能結束這份交易');
      if (t.status !== 'pending') fail('trade-closed', '這份交易已經結束');
      release(t.lockId, t.from, `trade ${t.id} ${cmd.type === 'declineTrade' ? 'declined' : 'cancelled'}`);
      h.change(ctx, 'trade', t.id, t, cmd.type, false, (x) => { x.status = cmd.type === 'declineTrade' ? 'declined' : 'cancelled'; });
      tell([t.from, t.to], 'tradeClosed', `交易 ${t.id} ${cmd.type === 'declineTrade' ? '被拒絕' : '被取消'}，鎖定的東西退回`, { tradeId: t.id });
      return;
    }

    // ---------- commissions ----------
    case 'postCommission': {
      const c = h.active(ctx, cmd.characterId);
      if (!Number.isInteger(cmd.reward) || cmd.reward < 1) fail('bad-amount', '報酬必須是正整數');
      deadlineOk(cmd.deadline);
      const r = cmd.requirement;
      if (r.kind === 'deliver' && (!r.template || !Number.isInteger(r.qty) || r.qty < 1)) fail('bad-requirement', '交付條件要寫明物品種類與數量');
      const id = nextId('C');
      const l = lock(c, { coins: cmd.reward, itemIds: [] }, 'commission-reward', id);
      const k: Commission = { id, issuerId: c.id, title: cmd.title, requirement: r, reward: cmd.reward, deadline: cmd.deadline, rewardLockId: l.id, status: 'published', version: 1 };
      eco.commissions[id] = k;
      h.audit(ctx, 'commission', id, null, h.clone(k), 'post commission', true);
      h.emit(ctx, { kind: 'commissionPosted', text: `${c.name} 發布委託「${k.title}」，報酬 ${k.reward}（已鎖定）`, visibility: 'public', data: { commissionId: id } });
      return;
    }
    case 'acceptCommission': {
      const c = h.active(ctx, cmd.characterId);
      const k = commission(cmd.commissionId);
      if (k.status !== 'published') fail('commission-closed', '這份委託已經有人接或已經結束');
      if (k.issuerId === c.id) fail('own-commission', '不能接自己的委託');
      if (new Date(k.deadline) <= ctx.now) fail('expired', '委託已經過期');
      h.change(ctx, 'commission', k.id, k, 'accepted', true, (t) => { t.status = 'accepted'; t.contractorId = c.id; });
      tell([k.issuerId, c.id], 'commissionAccepted', `${c.name} 接下委託「${k.title}」`, { commissionId: k.id });
      return;
    }
    case 'submitCommission': {
      const c = h.active(ctx, cmd.characterId);
      const k = commission(cmd.commissionId);
      if (k.contractorId !== c.id) fail('forbidden', '這份委託不是你接的');
      if (k.status !== 'accepted') fail('bad-state', '這份委託現在不能提交');
      if (new Date(k.deadline) <= ctx.now) fail('expired', '委託已經過期');
      if (k.requirement.kind === 'deliver') templateItems(c, cmd.itemIds, k.requirement.template, k.requirement.qty);
      const delivery = lock(c, { coins: 0, itemIds: cmd.itemIds }, 'commission-delivery', k.id);
      h.change(ctx, 'commission', k.id, k, 'submitted', true, (t) => { t.status = 'submitted'; t.deliveryLockId = delivery.id; });
      if (k.requirement.kind === 'deliver') {
        // Structured requirement: the server can verify it, so it settles immediately.
        release(k.rewardLockId, c.id, `commission ${k.id} reward`);
        release(delivery.id, k.issuerId, `commission ${k.id} delivery`);
        h.change(ctx, 'commission', k.id, k, 'auto-verified', false, (t) => { t.status = 'completed'; });
        tell([k.issuerId, c.id], 'commissionCompleted', `委託「${k.title}」交付內容符合條件，自動驗收完成：${c.name} 收到 ${k.reward} 枚錢幣`, { commissionId: k.id });
      } else {
        tell([k.issuerId, c.id], 'commissionSubmitted', `${c.name} 提交了委託「${k.title}」，等待 GM 驗收`, { commissionId: k.id });
      }
      return;
    }
    case 'reviewCommission': {
      const k = commission(cmd.commissionId);
      if (k.requirement.kind !== 'gm') fail('auto-verified', '這份委託由系統自動驗收');
      h.requireGm(ctx, ['main', 'arbiter']);
      if (k.status !== 'submitted') fail('bad-state', '這份委託沒有待驗收的提交');
      if (cmd.approve) {
        release(k.rewardLockId, k.contractorId!, `commission ${k.id} reward`);
        release(k.deliveryLockId!, k.issuerId, `commission ${k.id} delivery`);
        h.change(ctx, 'commission', k.id, k, 'gm approved', false, (t) => { t.status = 'completed'; });
        tell([k.issuerId, k.contractorId!], 'commissionCompleted', `GM 驗收通過：委託「${k.title}」完成，報酬 ${k.reward} 交給 ${name(k.contractorId!)}`, { commissionId: k.id });
      } else {
        release(k.deliveryLockId!, k.contractorId!, `commission ${k.id} returned`);
        h.change(ctx, 'commission', k.id, k, 'gm returned', true, (t) => { t.status = 'accepted'; delete t.deliveryLockId; });
        tell([k.issuerId, k.contractorId!], 'commissionReturned', `GM 退回委託「${k.title}」的提交，可以重新提交`, { commissionId: k.id });
      }
      return;
    }
    case 'cancelCommission': {
      const c = h.own(ctx, cmd.characterId);
      const k = commission(cmd.commissionId);
      if (k.issuerId !== c.id) fail('forbidden', '只有發布者能取消委託');
      if (k.status !== 'published') fail('bad-state', '已經有人接的委託不能單方面取消，請提出爭議');
      release(k.rewardLockId, c.id, `commission ${k.id} cancelled`);
      h.change(ctx, 'commission', k.id, k, 'cancelled', false, (t) => { t.status = 'cancelled'; });
      h.emit(ctx, { kind: 'commissionCancelled', text: `委託「${k.title}」已取消`, visibility: 'public', data: { commissionId: k.id } });
      return;
    }

    // ---------- contracts ----------
    case 'proposeContract': {
      const c = h.active(ctx, cmd.characterId);
      const other = h.character(ctx, cmd.with);
      if (other.id === c.id || other.status === 'dead') fail('bad-target', '不能和這個角色立約');
      deadlineOk(cmd.deadline);
      const parties: [string, string] = [c.id, other.id];
      if (!cmd.clauses.length) fail('no-clauses', '契約至少要有一條條款');
      cmd.clauses.forEach((cl) => {
        if (!parties.includes(cl.from) || ('to' in cl && (!parties.includes(cl.to) || cl.to === cl.from))) fail('bad-clause', '條款的雙方必須是立約人');
        if (cl.kind === 'payCoins' && (!Number.isInteger(cl.amount) || cl.amount < 1)) fail('bad-clause', '付款金額必須是正整數');
        if (cl.kind === 'deliverTemplate' && (!Number.isInteger(cl.qty) || cl.qty < 1)) fail('bad-clause', '交付數量必須是正整數');
      });
      for (const p of parties) if (!coinsOk(cmd.deposits[p] ?? 0)) fail('bad-amount', '押金必須是 0 以上的整數');
      const id = nextId('K');
      const k: Contract = {
        id, parties, title: cmd.title, clauses: cmd.clauses.map((cl, n) => ({ ...cl, id: `${id}-${n + 1}`, done: false }) as Clause),
        deposits: { [c.id]: cmd.deposits[c.id] ?? 0, [other.id]: cmd.deposits[other.id] ?? 0 }, depositLocks: {}, signed: [c.id],
        cancelRequests: [], deadline: cmd.deadline, status: 'proposed', version: 1,
      };
      eco.contracts[id] = k;
      if (k.deposits[c.id]) k.depositLocks[c.id] = lock(c, { coins: k.deposits[c.id], itemIds: [] }, 'contract-deposit', id).id;
      h.audit(ctx, 'contract', id, null, h.clone(k), 'propose contract', true);
      tell(parties, 'contractProposed', `${c.name} 向 ${other.name} 提出契約「${k.title}」，共 ${k.clauses.length} 條條款`, { contractId: id });
      return;
    }
    case 'signContract': {
      const c = h.active(ctx, cmd.characterId);
      const k = contract(cmd.contractId);
      if (!k.parties.includes(c.id)) fail('forbidden', '你不是這份契約的立約人');
      if (k.status !== 'proposed') fail('bad-state', '這份契約不在待簽署狀態');
      if (k.signed.includes(c.id)) fail('already-signed', '你已經簽過了');
      if (new Date(k.deadline) <= ctx.now) fail('expired', '契約期限已過');
      const depositLock = k.deposits[c.id] ? lock(c, { coins: k.deposits[c.id], itemIds: [] }, 'contract-deposit', k.id).id : undefined;
      h.change(ctx, 'contract', k.id, k, 'signed', false, (t) => {
        t.signed.push(c.id);
        if (depositLock) t.depositLocks[c.id] = depositLock;
        t.status = 'active';
      });
      tell(k.parties, 'contractSigned', `契約「${k.title}」雙方都已簽署，開始生效，押金已鎖定`, { contractId: k.id });
      return;
    }
    case 'fulfillClause': {
      const c = h.active(ctx, cmd.characterId);
      const k = contract(cmd.contractId);
      if (k.status !== 'active') fail('bad-state', '這份契約目前不能履行條款');
      const cl = k.clauses.find((x) => x.id === cmd.clauseId) ?? fail('unknown-clause', '找不到這條條款');
      if (cl.from !== c.id) fail('forbidden', '這條條款不是你要履行的');
      if (cl.done) fail('already-done', '這條條款已經履行');
      if (new Date(k.deadline) <= ctx.now) fail('expired', '契約期限已過');
      // Each clause moves only what it names, and only when its own obligor performs it.
      if (cl.kind === 'gmVerified') fail('needs-gm', '這條條款要由 GM 確認');
      const to = h.character(ctx, cl.to);
      if (cl.kind === 'payCoins') transfer(c, to, { coins: cl.amount, itemIds: [] }, `contract ${k.id} clause ${cl.id}`);
      if (cl.kind === 'deliverItem') transfer(c, to, { coins: 0, itemIds: [cl.itemId] }, `contract ${k.id} clause ${cl.id}`);
      if (cl.kind === 'deliverTemplate') {
        templateItems(c, cmd.itemIds ?? [], cl.template, cl.qty);
        transfer(c, to, { coins: 0, itemIds: cmd.itemIds! }, `contract ${k.id} clause ${cl.id}`);
      }
      h.change(ctx, 'contract', k.id, k, `clause ${cl.id} done`, false, (t) => { t.clauses.find((x) => x.id === cl.id)!.done = true; });
      tell(k.parties, 'clauseDone', `${c.name} 履行了契約「${k.title}」的條款 ${cl.id}`, { contractId: k.id, clauseId: cl.id });
      maybeFulfilled(k);
      return;
    }
    case 'gmVerifyClause': {
      h.requireGm(ctx, ['main', 'arbiter']);
      const k = contract(cmd.contractId);
      if (k.status !== 'active') fail('bad-state', '這份契約目前不能履行條款');
      const cl = k.clauses.find((x) => x.id === cmd.clauseId) ?? fail('unknown-clause', '找不到這條條款');
      if (cl.kind !== 'gmVerified') fail('not-gm-clause', '這條條款由立約人自己履行');
      if (cl.done) fail('already-done', '這條條款已經履行');
      h.change(ctx, 'contract', k.id, k, `gm verified ${cl.id}`, false, (t) => { t.clauses.find((x) => x.id === cl.id)!.done = true; });
      tell(k.parties, 'clauseDone', `GM 確認契約「${k.title}」的條款 ${cl.id} 已履行`, { contractId: k.id, clauseId: cl.id });
      maybeFulfilled(k);
      return;
    }
    case 'requestCancelContract': {
      const c = h.own(ctx, cmd.characterId);
      const k = contract(cmd.contractId);
      if (!k.parties.includes(c.id)) fail('forbidden', '你不是這份契約的立約人');
      if (k.status === 'proposed') {
        refundDeposits(k, `contract ${k.id} withdrawn`);
        closeContract(k, 'cancelled', `withdrawn by ${c.id}`);
        tell(k.parties, 'contractCancelled', `契約「${k.title}」在生效前撤回`, { contractId: k.id });
        return;
      }
      if (k.status !== 'active') fail('bad-state', '這份契約已經結束');
      if (k.cancelRequests.includes(c.id)) fail('already-requested', '你已經提出解約了');
      h.change(ctx, 'contract', k.id, k, `cancel request ${c.id}`, true, (t) => { t.cancelRequests.push(c.id); });
      if (k.cancelRequests.length < 2) {
        tell(k.parties, 'contractCancelRequested', `${c.name} 提議解除契約「${k.title}」，對方同意才會解約`, { contractId: k.id });
        return;
      }
      refundDeposits(k, `contract ${k.id} cancelled by agreement`);
      closeContract(k, 'cancelled', 'mutual cancel');
      tell(k.parties, 'contractCancelled', `雙方同意解除契約「${k.title}」，押金退回；已履行的條款不會撤銷`, { contractId: k.id });
      return;
    }

    // ---------- disputes and deadlines ----------
    case 'raiseDispute': {
      const c = h.own(ctx, cmd.characterId);
      const id = nextId('P');
      if (cmd.kind === 'commission') {
        const k = commission(cmd.ref);
        if (![k.issuerId, k.contractorId].includes(c.id)) fail('forbidden', '你不是這份委託的當事人');
        if (!['accepted', 'submitted'].includes(k.status)) fail('bad-state', '這份委託現在不能提出爭議');
        h.change(ctx, 'commission', k.id, k, 'disputed', true, (t) => { t.status = 'disputed'; t.disputeId = id; });
      } else {
        const k = contract(cmd.ref);
        if (!k.parties.includes(c.id)) fail('forbidden', '你不是這份契約的立約人');
        if (k.status !== 'active') fail('bad-state', '這份契約現在不能提出爭議');
        h.change(ctx, 'contract', k.id, k, 'disputed', true, (t) => { t.status = 'disputed'; t.disputeId = id; });
      }
      const d: Dispute = { id, kind: cmd.kind, ref: cmd.ref, raisedBy: c.id, reason: cmd.reason, status: 'open', version: 1 };
      eco.disputes[id] = d;
      h.audit(ctx, 'dispute', id, null, h.clone(d), 'raise dispute', false);
      const parties = cmd.kind === 'commission'
        ? [eco.commissions[cmd.ref].issuerId, eco.commissions[cmd.ref].contractorId!]
        : [...eco.contracts[cmd.ref].parties];
      tell(parties, 'disputeRaised', `${c.name} 對${cmd.kind === 'commission' ? '委託' : '契約'} ${cmd.ref} 提出爭議：${cmd.reason}。鎖定的資產維持凍結，等 GM 裁決`, { disputeId: id });
      return;
    }
    case 'gmResolveDispute': {
      h.requireGm(ctx, ['main', 'arbiter']);
      const d = eco.disputes[cmd.disputeId] ?? fail('unknown-dispute', '找不到這個爭議');
      if (d.status !== 'open') fail('dispute-closed', '這個爭議已經裁決');
      const o = cmd.outcome;
      let summary = '';
      if (d.kind === 'commission') {
        const k = commission(d.ref);
        if (o !== 'pay' && o !== 'refund') fail('bad-outcome', '委託爭議只能裁決為付款或退款');
        const contractor = k.contractorId!;
        if (o === 'pay') {
          release(k.rewardLockId, contractor, `dispute ${d.id}: pay`);
          if (k.deliveryLockId) release(k.deliveryLockId, k.issuerId, `dispute ${d.id}: delivery`);
        } else {
          release(k.rewardLockId, k.issuerId, `dispute ${d.id}: refund`);
          if (k.deliveryLockId) release(k.deliveryLockId, contractor, `dispute ${d.id}: return delivery`);
        }
        h.change(ctx, 'commission', k.id, k, `dispute ${d.id} ${o}`, false, (t) => { t.status = o === 'pay' ? 'completed' : 'cancelled'; });
        summary = o === 'pay' ? `報酬付給 ${name(contractor)}` : `報酬退回 ${name(k.issuerId)}`;
        tell([k.issuerId, contractor], 'disputeResolved', `爭議 ${d.id} 裁決：${summary}`, { disputeId: d.id });
      } else {
        const k = contract(d.ref);
        if (o === 'fulfilled') { refundDeposits(k, `dispute ${d.id}: fulfilled`); closeContract(k, 'fulfilled', `dispute ${d.id}`); summary = '視為履行完成'; }
        else if (o === 'cancel') { refundDeposits(k, `dispute ${d.id}: cancel`); closeContract(k, 'cancelled', `dispute ${d.id}`); summary = '解除契約，押金退回'; }
        else if (typeof o === 'object' && k.parties.includes(o.breachBy)) { breach(k, [o.breachBy], `dispute ${d.id}`); summary = `${name(o.breachBy)} 違約`; }
        else fail('bad-outcome', '契約爭議的裁決不正確');
        tell([...k.parties], 'disputeResolved', `爭議 ${d.id} 裁決：${summary}`, { disputeId: d.id });
      }
      h.change(ctx, 'dispute', d.id, d, 'resolved', false, (t) => { t.status = 'resolved'; t.outcome = typeof o === 'string' ? o : `breach:${o.breachBy}`; });
      return;
    }
    case 'settleDeadlines': {
      if (ctx.actor.role !== 'system') h.requireGm(ctx, ['main']);
      for (const k of Object.values(eco.commissions)) {
        if (!['published', 'accepted'].includes(k.status) || new Date(k.deadline) > ctx.now) continue;
        release(k.rewardLockId, k.issuerId, `commission ${k.id} expired`);
        h.change(ctx, 'commission', k.id, k, 'expired', false, (t) => { t.status = 'expired'; });
        tell([k.issuerId, ...(k.contractorId ? [k.contractorId] : [])], 'commissionExpired', `委託「${k.title}」逾期未完成，報酬退回發布者`, { commissionId: k.id });
      }
      for (const k of Object.values(eco.contracts)) {
        if (new Date(k.deadline) > ctx.now) continue;
        if (k.status === 'proposed') {
          refundDeposits(k, `contract ${k.id} expired unsigned`);
          closeContract(k, 'cancelled', 'expired before signing');
          tell(k.parties, 'contractCancelled', `契約「${k.title}」到期前沒有簽署，自動作廢`, { contractId: k.id });
        } else if (k.status === 'active') {
          const owing = [...new Set(k.clauses.filter((cl) => !cl.done).map((cl) => cl.from))];
          breach(k, owing, 'deadline passed');
        }
      }
      return;
    }
  }
}
