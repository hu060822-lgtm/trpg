import { gmGrant, itemLocation } from './engine';
import type { Change, WorldActor, WorldEvent, WorldState } from './types';

/** Characters this user plays in the world. */
const mine = (s: WorldState, userId: string) => Object.values(s.characters).filter((c) => c.ownerUserId === userId).map((c) => c.id);

/**
 * Which history entries a viewer may read (plan §7.4 visibility levels).
 * Main GM: everything. Scene GM: public + entries at their locations. Arbiter: public + ruling entries.
 * Players: public, scene entries they witnessed, and private entries addressed to their characters.
 */
export function canSee(s: WorldState, viewer: WorldActor, e: WorldEvent): boolean {
  if (e.visibility === 'public') return true;
  const g = gmGrant(s, viewer);
  if (g) {
    if (g.role === 'main') return true;
    if (g.role === 'scene') return !!e.locationId && !!g.locations?.includes(e.locationId);
    return e.kind.startsWith('ruling');
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

/**
 * The world as one viewer may see it: GM notes, undiscovered hidden items, other players' inventories,
 * coins, crimes and opt-in settings are removed for players. A hidden field in the UI is not protection,
 * so this is what any player-facing API must return.
 */
export function viewFor(s: WorldState, viewer: WorldActor): WorldState {
  if (gmGrant(s, viewer)?.role === 'main') return structuredClone(s);
  const v = structuredClone(s);
  const ids = mine(s, viewer.userId);
  const here = new Set(ids.map((id) => s.characters[id].locationId));
  for (const l of Object.values(v.locations)) l.gmNotes = '';
  for (const [id, i] of Object.entries(v.items)) {
    const visibleHidden = !i.hidden || i.discoveredBy.some((c) => ids.includes(c));
    const heldByMe = i.holder.type === 'character' && ids.includes(i.holder.id);
    // Items on the ground are seen where you stand; items carried by others are not listed at all.
    const onGround = i.holder.type === 'location' && here.has(itemLocation(s, i)!);
    const publicFate = i.unique && i.status !== 'present';
    if (!(heldByMe || (onGround && visibleHidden) || publicFate)) delete v.items[id];
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
  return v;
}
