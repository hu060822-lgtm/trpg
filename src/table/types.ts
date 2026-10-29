import type { CharacterData, CheckMode, SheetValue } from '../pack/pack';

/** The rooms API's shapes, shared by the server and the web client (so this file imports nothing from Node). */
export type Role = 'gm' | 'player';
export interface PackSummary { key: string; id: string; version: string; name: string; builtin: boolean; license: string; attribution?: string; description?: string }
export interface Room { id: string; name: string; packKey: string; code: string; createdBy: string; createdAt: string; activeMapId: string | null }
export interface Member { userId: string; name: string; role: Role }
export interface Character { id: string; ownerUserId: string; name: string; data: CharacterData; version: number }
export interface CharacterView extends Character { sheet: Record<string, SheetValue> }

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
  | { characterId: string; check: { attribute: string } | { skill: string }; mode?: CheckMode; secret?: boolean }
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
}
export interface MapView { map: MapInfo; tokens: Token[] }
export interface MapSummary { id: string; name: string; cols: number; rows: number; imageVersion: number }
