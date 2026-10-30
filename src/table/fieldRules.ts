import type { GestureKind } from '../encounter/weapons';
import type { MapObject, MapObjectKind } from './types';

/**
 * What can be done with things on the map: climb a cliff, break a cracked wall, pick a lock, disarm a trap, jump a
 * pit, swim a river, pull a lever. Shared by the server (which decides) and the browser (which offers the buttons).
 *
 * Every action but pulling a lever is a check like any other: the dice first (a d20 plus the skill), then the action's
 * own little gesture, which can add up to the pack's interaction bonus, then the DC decides.
 */

export type FieldAction = 'climb' | 'break' | 'pick' | 'disarm' | 'jump' | 'swim' | 'pull';

export const FIELD_ACTIONS: Record<FieldAction, { label: string; skill: string | null; attribute: string; gesture: GestureKind | null; verb: string }> = {
  climb: { label: '攀爬', skill: 'athletics', attribute: 'str', gesture: 'climb', verb: '爬上' },
  break: { label: '破壞', skill: 'athletics', attribute: 'str', gesture: 'smash', verb: '砸開' },
  pick: { label: '開鎖', skill: 'sleight_of_hand', attribute: 'dex', gesture: 'pick', verb: '撬開' },
  disarm: { label: '解除陷阱', skill: 'sleight_of_hand', attribute: 'dex', gesture: 'wire', verb: '拆掉' },
  jump: { label: '跳過去', skill: 'athletics', attribute: 'str', gesture: 'throw', verb: '跳過' },
  swim: { label: '游過去', skill: 'athletics', attribute: 'str', gesture: 'sweep', verb: '游過' },
  pull: { label: '拉動', skill: null, attribute: 'str', gesture: null, verb: '拉動' },
};

/** Default DCs by kind; a GM can set any object's DC by hand. 0 means it just works, no roll. */
const DEFAULTS: Partial<Record<MapObjectKind, Partial<Record<FieldAction, number>>>> = {
  wall: { climb: 15 },
  cracked_wall: { break: 12, climb: 15 },
  door: { break: 15, pick: 15 },
  gate: { break: 20, pick: 15 },
  chest: { pick: 12, break: 15 },
  cage: { pick: 13, break: 18 },
  window: { break: 10 },
  crate: { break: 8 },
  barrel: { break: 8 },
  barricade: { break: 10, climb: 10 },
  fence: { climb: 8, break: 10 },
  cliff: { climb: 15 },
  ladder: { climb: 0 },
  rope: { climb: 10 },
  tree: { climb: 12 },
  rock: { climb: 10 },
  statue: { climb: 12 },
  stalagmite: { climb: 12 },
  trap: { disarm: 15 },
  spikes: { disarm: 12 },
  pit: { jump: 12, climb: 10 },
  lava: { jump: 15 },
  water: { swim: 10, jump: 13 },
  web: { break: 10 },
  lever: { pull: 0 },
};

/** Damage when something goes wrong, unless the GM set it. */
export const DEFAULT_DAMAGE: Partial<Record<MapObjectKind, string>> = { trap: '2d6', spikes: '1d6', pit: '1d6', lava: '4d10', fire: '1d10', cliff: '1d6', wall: '1d6' };

const LOCKABLE = new Set<MapObjectKind>(['door', 'gate', 'chest', 'cage']);
export const isLockable = (k: MapObjectKind) => LOCKABLE.has(k);
export const isTrap = (k: MapObjectKind) => k === 'trap' || k === 'spikes';

/** The actions this object offers right now, with their DCs. Broken, open or disarmed things offer less. */
export function fieldActions(o: Pick<MapObject, 'kind' | 'open' | 'props'>): { action: FieldAction; dc: number }[] {
  const base = DEFAULTS[o.kind];
  if (!base) return [];
  const out: { action: FieldAction; dc: number }[] = [];
  for (const [a, dc] of Object.entries(base) as [FieldAction, number][]) {
    if (a === 'pick' && !o.props.locked) continue;
    if (a === 'break' && o.open) continue;
    if (a === 'disarm' && o.props.armed === false) continue;
    out.push({ action: a, dc: o.props.dc ?? dc });
  }
  return out;
}

export const damageOf = (o: Pick<MapObject, 'kind' | 'props'>) => o.props.damage ?? DEFAULT_DAMAGE[o.kind] ?? '1d6';

/** Squares between a token and an object's footprint (0 = on it, 1 = next to it). */
export function gapTo(t: { x: number; y: number; size: number }, o: { x: number; y: number; w: number; h: number }): number {
  const gx = Math.max(0, o.x - (t.x + t.size - 1), t.x - (o.x + o.w - 1));
  const gy = Math.max(0, o.y - (t.y + t.size - 1), t.y - (o.y + o.h - 1));
  return Math.max(gx, gy);
}
