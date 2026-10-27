import { gmGrant, itemLocation } from './engine';
import type { Change, LedgerEntry, Lock, WorldActor, WorldEvent, WorldState } from './types';

/** Characters this user plays in the world. */
const mine = (s: WorldState, userId: string) => Object.values(s.characters).filter((c) => c.ownerUserId === userId).map((c) => c.id);

/**
 * Which history entries a viewer may read (plan §7.4 visibility levels).
 * Main GM: everything. Scene GM: public + entries at their locations. Arbiter: public + ruling and economy-dispute entries.
 * Players: public, scene entries they witnessed, and private entries addressed to their characters.
 */
export function canSee(s: WorldState, viewer: WorldActor, e: WorldEvent): boolean {
  if (e.visibility === 'public') return true;
  const g = gmGrant(s, viewer);
  if (g) {
    if (g.role === 'main') return true;
    if (g.role === 'scene') return !!e.locationId && !!g.locations?.includes(e.locationId);
    // An arbiter sees what they may be asked to rule on: rulings and the economy's disputes, commissions and contracts.
    return ['ruling', 'dispute', 'commission', 'contract', 'clause'].some((k) => e.kind.startsWith(k));
  }
  if (e.visibility === 'gm') return false;
  const ids = mine(s, viewer.userId);
  return e.audience.some((id) => ids.includes(id));
}

export function historyFor(s: WorldState, viewer: WorldActor, events: WorldEvent[]): WorldEvent[] {
  return events.filter((e) => canSee(s, viewer, e));
}

/** The before/after audit trail is GM-only. */
export function auditFor(s: WorldState, viewer: WorldActor, changes: Change[]): Change[] {
  return gmGrant(s, viewer)?.role === 'main' ? changes : [];
}

/** Locks a viewer may see: their own, and those behind a trade, commission or contract they are party to. */
function visibleLocks(s: WorldState, ids: string[]): Set<string> {
  const e = s.economy;
  const mineToo = (...xs: (string | undefined)[]) => xs.some((x) => !!x && ids.includes(x));
  const party = (l: Lock) => {
    if (ids.includes(l.ownerId)) return true;
    const t = e.trades[l.ref];
    if (t) return mineToo(t.from, t.to);
    const k = e.commissions[l.ref];
    if (k) return mineToo(k.issuerId, k.contractorId);
    const c = e.contracts[l.ref];
    return !!c && mineToo(...c.parties);
  };
  return new Set(Object.values(e.locks).filter(party).map((l) => l.id));
}

/**
 * Ledger entries a viewer may read. Main GM and arbiter: everything. Players: entries where their characters,
 * a lock they can see, or a shop on the market (sales are public listings) is on either side.
 */
export function ledgerFor(s: WorldState, viewer: WorldActor, entries: LedgerEntry[]): LedgerEntry[] {
  const g = gmGrant(s, viewer);
  if (g?.role === 'main' || g?.role === 'arbiter') return entries;
  const ids = mine(s, viewer.userId);
  const locks = visibleLocks(s, ids);
  const sees = (p: LedgerEntry['from']) => (p.type === 'character' && ids.includes(p.id)) || (p.type === 'escrow' && locks.has(p.id));
  return entries.filter((e) => sees(e.from) || sees(e.to));
}

/**
 * The world as one viewer may see it: GM notes, undiscovered hidden items, other players' inventories,
 * coins, crimes and opt-in settings are removed for players. A hidden field in the UI is not protection,
 * so this is what any player-facing API must return.
 */
export function viewFor(s: WorldState, viewer: WorldActor): WorldState {
  const grant = gmGrant(s, viewer);
  if (grant?.role === 'main') return structuredClone(s);
  const v = structuredClone(s);
  const ids = mine(s, viewer.userId);
  const here = new Set(ids.map((id) => s.characters[id].locationId));
  const locks = visibleLocks(s, ids);
  for (const l of Object.values(v.locations)) l.gmNotes = '';
  for (const [id, i] of Object.entries(v.items)) {
    const visibleHidden = !i.hidden || i.discoveredBy.some((c) => ids.includes(c));
    const heldByMe = i.holder.type === 'character' && ids.includes(i.holder.id);
    // Items on the ground are seen where you stand; items carried by others are not listed at all.
    const onGround = i.holder.type === 'location' && here.has(itemLocation(s, i)!);
    const publicFate = i.unique && i.status !== 'present';
    // Shop stock is on public display; escrowed items are seen by the parties to that lock.
    const onSale = i.holder.type === 'shop' && !!s.economy.shops[i.holder.id]?.open;
    const inMyEscrow = i.holder.type === 'escrow' && locks.has(i.holder.id);
    if (!(heldByMe || (onGround && visibleHidden) || publicFate || onSale || inMyEscrow || grant?.role === 'arbiter')) delete v.items[id];
    else { i.discoveredBy = i.discoveredBy.filter((c) => ids.includes(c)); }
  }
  for (const c of Object.values(v.characters)) {
    if (ids.includes(c.id)) continue;
    if (!here.has(c.locationId)) c.locationId = ''; // where other players are is not public
    c.coins = 0;
    c.lethalPvpOptIn = false;
    c.skills = {};
    c.attributes = Object.fromEntries(Object.keys(c.attributes).map((k) => [k, 0])) as typeof c.attributes;
    delete c.afterimageUntil;
  }
  for (const [id, n] of Object.entries(v.npcs)) if (!n.public && !here.has(n.locationId)) delete v.npcs[id];
  v.hostilities = v.hostilities.filter((h) => ids.includes(h.from) || ids.includes(h.against));
  v.rulings = Object.fromEntries(Object.entries(v.rulings).filter(([, r]) => r.subjects.some((x) => ids.includes(x))));
  v.gms = {};
  // Shops and the commission board are public; trades, contracts, locks and disputes only to their parties.
  // An arbiter rules on disputes, so they see the whole economy.
  if (grant?.role !== 'arbiter') {
    const e = v.economy;
    const involves = (...xs: (string | undefined)[]) => xs.some((x) => !!x && ids.includes(x));
    for (const sh of Object.values(e.shops)) if (!sh.open && !involves(sh.ownerId)) sh.listings = [];
    e.trades = Object.fromEntries(Object.entries(e.trades).filter(([, t]) => involves(t.from, t.to)));
    e.contracts = Object.fromEntries(Object.entries(e.contracts).filter(([, c]) => involves(...c.parties)));
    e.locks = Object.fromEntries(Object.entries(e.locks).filter(([id]) => locks.has(id)));
    e.disputes = Object.fromEntries(Object.entries(e.disputes).filter(([, d]) => {
      const k = d.kind === 'commission' ? s.economy.commissions[d.ref] : undefined;
      const c = d.kind === 'contract' ? s.economy.contracts[d.ref] : undefined;
      return involves(k?.issuerId, k?.contractorId, ...(c?.parties ?? []));
    }));
  }
  return v;
}
