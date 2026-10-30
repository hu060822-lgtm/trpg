import type { CharacterData, CheckMode, CheckTarget, PackFeature, SheetValue } from '../pack/pack';

/** The rooms API's shapes, shared by the server and the web client (so this file imports nothing from Node). */
export type Role = 'gm' | 'player';
export interface PackSummary { key: string; id: string; version: string; name: string; builtin: boolean; license: string; attribution?: string; description?: string }
export interface Room { id: string; name: string; packKey: string; code: string; createdBy: string; createdAt: string; activeMapId: string | null }
export interface Member { userId: string; name: string; role: Role }
export interface Character { id: string; ownerUserId: string; name: string; data: CharacterData; version: number }
export interface CharacterView extends Character {
  sheet: Record<string, SheetValue>;
  /** Class features, species traits and picks, up to the character's level. */
  features: (PackFeature & { from: string })[];
  /** Actions this character cannot use (their `showIf` is 0), e.g. spell attacks for a fighter. */
  hiddenActions: string[];
}

export interface RollBody {
  label: string;
  /** The formula with each die's faces and each value's name written in. */
  text: string;
  total: number;
  natural?: 'critical' | 'fumble' | null;
  characterId?: string;
  /** Rolled with the attack when the pack gives the action a damage formula. */
  damage?: { text: string; total: number };
  /** Seen only by the GMs and whoever rolled. */
  secret?: boolean;
}
export type LogEntry =
  | { seq: number; at: string; userId: string; author: string; kind: 'chat'; body: { text: string } }
  | { seq: number; at: string; userId: string; author: string; kind: 'roll'; body: RollBody }
  | { seq: number; at: string; userId: string; author: string; kind: 'system'; body: { text: string } };

/** What a roll request asks for: a free formula, a check on a character, or one of the character's actions. */
export type RollRequest =
  | { formula: string; label?: string; characterId?: string; secret?: boolean }
  | { characterId: string; check: CheckTarget; mode?: CheckMode; secret?: boolean }
  | { characterId: string; action: string; secret?: boolean };

/** A battle map: a grid of `cols` × `rows` squares, optionally over an uploaded picture. */
export interface MapInfo {
  id: string;
  name: string;
  cols: number;
  rows: number;
  /** How far one square is, e.g. 5 (feet) or 1.5 (metres), and the word for it. */
  cellDistance: number;
  unit: string;
  showGrid: boolean;
  fogEnabled: boolean;
  /** One character per square, row by row: '1' is covered by fog. */
  fog: string;
  /** Bumps whenever the picture changes, so browsers fetch the new one; 0 means no picture. */
  imageVersion: number;
  version: number;
}
export interface Token {
  id: string;
  mapId: string;
  name: string;
  color: string;
  /** The top-left square the token stands on, and how many squares wide it is. */
  x: number;
  y: number;
  size: number;
  characterId: string | null;
  ownerUserId: string;
  /** Seen by GMs only. */
  hidden: boolean;
  /** Height above the ground, in the map's unit (flying, on a ledge). */
  elevation: number;
  /** 0 when the token has no picture; goes up each time a new one is set. */
  imageVersion: number;
}
/** Scenery the GM lays out on a map: walls, doors, furniture, traps. The client draws each kind. */
export const MAP_OBJECT_KINDS = [
  'wall', 'door', 'window', 'pillar', 'stairs', 'rubble',
  'table', 'chair', 'bed', 'chest', 'barrel', 'crate', 'bookshelf', 'altar', 'statue',
  'tree', 'bush', 'rock', 'water', 'fire',
  'trap', 'label',
  // Round three: more building parts, furniture, terrain and contraptions.
  'cracked_wall', 'gate', 'fence', 'cliff', 'ladder', 'bridge', 'pit', 'tent', 'well',
  'throne', 'cage', 'cart', 'brazier', 'anvil', 'weapon_rack', 'sack', 'treasure',
  'log', 'stalagmite', 'crystal', 'mushroom', 'mud', 'ice', 'lava', 'tall_grass', 'web',
  'lever', 'rope', 'spikes', 'rune_circle', 'barricade',
] as const;
export type MapObjectKind = (typeof MAP_OBJECT_KINDS)[number];
/** `w` × `h` squares from (`x`, `y`); `rotation` (0, 90, 180, 270) only turns the picture. */
export interface MapObject {
  id: string;
  mapId: string;
  kind: MapObjectKind;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  hidden: boolean;
  /** Doors and windows: open ones let sight and movement through. */
  open: boolean;
  /** Feet tall, when the GM changed it from the kind's default. */
  height: number | null;
  /** The GM's settings for what can be done with it (see ObjectProps). */
  props: ObjectProps;
}

/**
 * What the table can do with an object. Every field is optional; a missing one falls back to the kind's default
 * (see FIELD in src/table/field.ts). Players never receive `note`, nor the DC of a hidden trap.
 */
export interface ObjectProps {
  /** Difficulty of climbing, breaking, picking, disarming, jumping over it. */
  dc?: number;
  /** Doors, gates, chests, cages: shut with a lock until picked or broken. */
  locked?: boolean;
  /** Traps and spikes: still dangerous. */
  armed?: boolean;
  /** What it does to whoever sets it off or falls in (a dice formula, e.g. "2d6"). */
  damage?: string;
  /** Overrides whether walking through it costs double. */
  difficult?: boolean;
  /** For the GM only. */
  note?: string;
}

export interface MapView { map: MapInfo; tokens: Token[]; objects: MapObject[] }
export interface MapSummary { id: string; name: string; cols: number; rows: number; imageVersion: number }
