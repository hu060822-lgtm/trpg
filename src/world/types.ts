import type { AttributeCode } from '../rules/types';

export type Zone = 'safe' | 'controlled' | 'wild';

/** Who sends a command. GM powers come from WorldState.gms, never from the request itself. */
export interface WorldActor {
  userId: string;
  role: 'player' | 'gm' | 'system';
}

export type GmRole = 'main' | 'scene' | 'arbiter';
export interface GmGrant {
  role: GmRole;
  /** Scene GMs act only on these locations (and the NPCs and items in them). */
  locations?: string[];
}

interface Versioned {
  /** Bumped on every change; stored rows are written with a version check. */
  version: number;
}

export interface Location extends Versioned {
  id: string;
  name: string;
  zone: Zone;
  /** A registered outpost: logging off here is as safe as in a safe zone. */
  outpost: boolean;
  description: string;
  /** GM-private; never sent to players. */
  gmNotes: string;
  links: { to: string; minutes: number }[];
  /** Scene clock in game minutes. Advanced by actions taken here. */
  clock: number;
  state: Record<string, string | number | boolean>;
}

export interface Npc extends Versioned {
  id: string;
  name: string;
  locationId: string;
  status: 'alive' | 'dead';
  /** Public NPCs' deaths are public news; others are known only to those present. */
  public: boolean;
}

export type Holder = { type: 'location' | 'character' | 'npc'; id: string };

export interface Item extends Versioned {
  id: string;
  name: string;
  unique: boolean;
  tradable: boolean;
  holder: Holder;
  status: 'present' | 'destroyed' | 'sealed';
  /** Non-tradable items bind to the first character who takes them. */
  boundTo?: string;
  /** Hidden until found with a search check against this TN. */
  hidden?: { tn: number };
  discoveredBy: string[];
  /** An open ruling freezes the item: it cannot move until the ruling is closed. */
  lockedBy?: string;
}

export interface WorldCharacter extends Versioned {
  id: string;
  ownerUserId: string;
  name: string;
  attributes: Record<AttributeCode, number>;
  skills: Record<string, number>;
  locationId: string;
  status: 'alive' | 'dead';
  /** Mirrors the combat condition; only healthy/wounded/severe characters can act. */
  condition: string;
  online: boolean;
  /** Offline outside a safe zone: until this time PvP can down the character but not kill them. */
  afterimageUntil?: string;
  lethalPvpOptIn: boolean;
  coins: number;
  crimes: { locationId: string; kind: string; day: number }[];
}

export interface Hostility {
  id: string;
  from: string;
  against: string;
  locationId: string;
  /** Scene clock of the location when it was declared. */
  at: number;
}

export interface Ruling extends Versioned {
  id: string;
  kind: 'unique-item-theft';
  status: 'open' | 'confirmed' | 'overturned';
  subjects: string[];
  itemId?: string;
  /** Where the item goes back to if the ruling is overturned. */
  revertTo?: Holder;
  summary: string;
  decidedBy?: string;
}

export type Visibility = 'public' | 'scene' | 'private' | 'gm';

/** A history entry. Each audience gets its own entry, so no entry needs field-level redaction. */
export interface WorldEvent {
  seq: number;
  at: string;
  day: number;
  kind: string;
  actor: WorldActor;
  text: string;
  visibility: Visibility;
  locationId?: string;
  /** scene: characters present when it happened. private: the characters it is addressed to. */
  audience: string[];
  data: Record<string, unknown>;
}

/** Audit record (GM-only): every entity change with its before/after state (plan §8.3). */
export interface Change {
  seq: number;
  at: string;
  actor: WorldActor;
  entity: 'location' | 'npc' | 'item' | 'character' | 'ruling' | 'world';
  entityId: string;
  before: unknown;
  after: unknown;
  basis: string;
  reversible: boolean;
}

export interface WorldState {
  id: string;
  name: string;
  day: number;
  locations: Record<string, Location>;
  npcs: Record<string, Npc>;
  items: Record<string, Item>;
  characters: Record<string, WorldCharacter>;
  hostilities: Hostility[];
  rulings: Record<string, Ruling>;
  gms: Record<string, GmGrant>;
  seq: number;
}

export type WorldCommand =
  | { type: 'move'; characterId: string; to: string }
  | { type: 'setOnline'; characterId: string; online: boolean }
  | { type: 'take'; characterId: string; itemId: string }
  | { type: 'drop'; characterId: string; itemId: string }
  | { type: 'give'; characterId: string; itemId: string; to: string }
  | { type: 'search'; characterId: string }
  | { type: 'wait'; characterId: string; minutes: number }
  | { type: 'setLethalOptIn'; characterId: string; optIn: boolean }
  | { type: 'declareHostility'; characterId: string; targetId: string }
  | { type: 'attack'; characterId: string; targetId: string }
  | { type: 'steal'; characterId: string; targetId: string; itemId: string }
  | { type: 'gmSetLocationState'; locationId: string; key: string; value: string | number | boolean; visibility?: 'public' | 'scene' }
  | { type: 'gmSetZone'; locationId: string; zone: Zone }
  | { type: 'gmSetNpcStatus'; npcId: string; status: 'alive' | 'dead'; basis: string }
  | { type: 'gmItemStatus'; itemId: string; status: Item['status']; basis: string }
  | { type: 'gmPublish'; title: string; body: string }
  | { type: 'gmRuling'; rulingId: string; decision: 'confirm' | 'overturn' }
  | { type: 'advanceDay' }
  | { type: 'expireAfterimages' };

export interface WorldSubmission {
  actor: WorldActor;
  command: WorldCommand;
  /** Versions of the entities the client saw; a mismatch means the client acted on a stale view. */
  expected?: Record<string, number>;
}

export interface WorldConfig {
  version: string;
  status: string;
  zones: Record<Zone, { name: string; pvp: boolean; theft: boolean; consequences: boolean }>;
  hostilityLeadMinutes: number;
  afterimage: { hours: number; coinLossRatio: number };
  awareness: { base: number; attribute: AttributeCode; skill: string };
  theft: {
    approach: { attribute: AttributeCode; skill: string };
    grab: { attribute: AttributeCode; skill: string; tn: number };
    notice: { attribute: AttributeCode; skill: string };
    concealment: { base: number; attribute: AttributeCode; skill: string };
    evidence: { attribute: AttributeCode; skill: string; tn: number };
    guards: { attribute: number; skill: number };
    minutes: number;
  };
  search: { attribute: AttributeCode; skill: string; minutes: number };
  rulings: { uniqueItemTheft: boolean };
}

/** What a PvP attack would be, before anyone rolls. */
export interface PvpLegality {
  allowed: boolean;
  reason: string;
  /** False: the target can be downed but not killed (offline, afterimage, or no lethal opt-in). */
  lethal: boolean;
  /** Controlled zone: the attack is a recorded crime. */
  crime: boolean;
}
