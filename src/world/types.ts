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

export type Holder = { type: 'location' | 'character' | 'npc' | 'shop' | 'escrow' | 'team'; id: string };

export interface Item extends Versioned {
  id: string;
  name: string;
  unique: boolean;
  tradable: boolean;
  /** Commodity kind (e.g. 'herb'): commissions and contracts can ask for N items of a template. */
  template?: string;
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
  /** Checks a GM asked this character to roll. Seen only by the owner and GMs. */
  pendingChecks?: PendingCheck[];
}

/**
 * A GM's call for a check (rules v0.3 §2): attribute + skill against a TN, with the GM's situational modifier and,
 * decided before the roll, whether failure can be catastrophic. A secret check's result goes to GMs only.
 */
export interface PendingCheck {
  id: string;
  label: string;
  attribute: AttributeCode;
  /** null: a raw attribute check. */
  skill: string | null;
  tn: number;
  situational: number;
  mode: 'normal' | 'advantage' | 'disadvantage';
  highRisk: boolean;
  secret: boolean;
  requestedBy: string;
  at: string;
}

export interface Hostility {
  id: string;
  from: string;
  against: string;
  locationId: string;
  /** Scene clock of the location when it was declared. */
  at: number;
}

export interface Duel {
  id: string;
  from: string;
  to: string;
  locationId: string;
  expires: string;
  status: 'pending' | 'accepted' | 'declined';
}

export interface Ruling extends Versioned {
  id: string;
  kind: 'unique-item-theft' | 'pvp-death';
  status: 'open' | 'confirmed' | 'overturned';
  subjects: string[];
  itemId?: string;
  /** Where the item goes back to if the ruling is overturned. */
  revertTo?: Holder;
  summary: string;
  decidedBy?: string;
  /** pvp-death: whose death awaits confirmation, from which combat. */
  characterId?: string;
  combatId?: string;
  cause?: string;
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
  entity: 'location' | 'npc' | 'item' | 'character' | 'ruling' | 'world' | EconomyKind;
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
  duels: Duel[];
  rulings: Record<string, Ruling>;
  gms: Record<string, GmGrant>;
  economy: Economy;
  seq: number;
}

// ---------- Phase 4: economy ----------

export type EconomyKind = 'shop' | 'trade' | 'commission' | 'contract' | 'lock' | 'dispute' | 'team';

/** What a party puts up: coins and specific item instances. */
export interface Bundle { coins: number; itemIds: string[] }

/** Assets held aside for a trade, commission or contract. Coins leave the balance; items move to the escrow holder. */
export interface Lock extends Versioned {
  id: string;
  ownerId: string;
  purpose: 'trade' | 'commission-reward' | 'commission-delivery' | 'contract-deposit';
  ref: string;
  coins: number;
  itemIds: string[];
  status: 'held' | 'released' | 'consumed';
}

export interface Shop extends Versioned {
  id: string;
  ownerId: string;
  locationId: string;
  name: string;
  description: string;
  open: boolean;
  /** Each listing points at a real item now held by the shop; nothing is stocked by number alone. */
  listings: { itemId: string; price: number }[];
}

export interface Trade extends Versioned {
  id: string;
  from: string;
  to: string;
  give: Bundle;
  want: Bundle;
  lockId: string;
  status: 'pending' | 'completed' | 'cancelled' | 'declined';
}

export type Requirement = { kind: 'deliver'; template: string; qty: number } | { kind: 'gm'; text: string };

export interface Commission extends Versioned {
  id: string;
  issuerId: string;
  title: string;
  requirement: Requirement;
  reward: number;
  deadline: string;
  rewardLockId: string;
  contractorId?: string;
  deliveryLockId?: string;
  status: 'published' | 'accepted' | 'submitted' | 'completed' | 'cancelled' | 'expired' | 'disputed';
  disputeId?: string;
}

export type Clause =
  | { id: string; kind: 'payCoins'; from: string; to: string; amount: number; done: boolean }
  | { id: string; kind: 'deliverItem'; from: string; to: string; itemId: string; done: boolean }
  | { id: string; kind: 'deliverTemplate'; from: string; to: string; template: string; qty: number; done: boolean }
  | { id: string; kind: 'gmVerified'; from: string; text: string; done: boolean };

/** A clause as proposed, before the engine numbers it. */
export type ClauseDraft = Clause extends infer C ? (C extends Clause ? Omit<C, 'id' | 'done'> : never) : never;

export interface Contract extends Versioned {
  id: string;
  /** Two or more characters; every one must sign before the contract is active. */
  parties: string[];
  title: string;
  clauses: Clause[];
  deposits: Record<string, number>;
  depositLocks: Record<string, string>;
  signed: string[];
  cancelRequests: string[];
  deadline: string;
  status: 'proposed' | 'active' | 'fulfilled' | 'breached' | 'cancelled' | 'disputed';
  breachedBy?: string[];
  disputeId?: string;
}

export interface Dispute extends Versioned {
  id: string;
  kind: 'commission' | 'contract';
  ref: string;
  raisedBy: string;
  reason: string;
  status: 'open' | 'resolved';
  outcome?: string;
}

/** A change to the team that needs members' votes. */
/** What a team can do as a party, once its members vote for it; `characterId` is `team:<id>`. */
export type TeamAction = Extract<EconomyCommand, { type:
  'proposeContract' | 'signContract' | 'fulfillClause' | 'requestCancelContract' | 'raiseDispute'
  | 'postCommission' | 'acceptCommission' | 'submitCommission' | 'cancelCommission' }>;

export type TeamMotion =
  | { kind: 'withdraw'; to: string; coins: number; itemIds: string[] }
  | { kind: 'policy'; policy: Team['policy'] }
  | { kind: 'afterimage'; share: boolean }
  | { kind: 'act'; command: TeamAction }
  | { kind: 'kick'; target: string }
  | { kind: 'disband' };

export type TeamProposal = TeamMotion & {
  id: string;
  by: string;
  approvals: string[];
  rejections: string[];
  /** void: passed but could no longer be carried out (e.g. the treasury no longer holds it). */
  status: 'open' | 'passed' | 'rejected' | 'void';
};

/** A party (隊伍) with a shared treasury. Items in it are held by the team itself. */
export interface Team extends Versioned {
  id: string;
  name: string;
  leaderId: string;
  members: string[];
  invites: string[];
  coins: number;
  /** leader: the leader withdraws alone; majority: every withdrawal needs a vote. Other motions always need a vote. */
  policy: 'leader' | 'majority';
  /** Chosen by the team: when a member's afterimage expires, their share of the treasury takes the same loss. */
  afterimageShare: boolean;
  proposals: TeamProposal[];
  status: 'active' | 'disbanded';
}

export interface Economy {
  teams: Record<string, Team>;
  shops: Record<string, Shop>;
  trades: Record<string, Trade>;
  commissions: Record<string, Commission>;
  contracts: Record<string, Contract>;
  locks: Record<string, Lock>;
  disputes: Record<string, Dispute>;
}

/** `mint` creates coins (GM grants), `sink` destroys them (afterimage loss); everything else moves them. */
export type Party = { type: Holder['type'] | 'mint' | 'sink'; id: string };

/** Append-only record of every coin or item movement. Balances can be recomputed from it. */
export interface LedgerEntry {
  seq: number;
  at: string;
  tx: string;
  from: Party;
  to: Party;
  coins?: number;
  itemId?: string;
  reason: string;
}

export type EconomyCommand =
  | { type: 'gmGrantCoins'; characterId: string; amount: number; reason: string }
  | { type: 'openShop'; characterId: string; shopId: string; name: string; description: string }
  | { type: 'setShopOpen'; characterId: string; shopId: string; open: boolean }
  | { type: 'stockItem'; characterId: string; shopId: string; itemId: string; price: number }
  | { type: 'unstockItem'; characterId: string; shopId: string; itemId: string }
  | { type: 'buy'; characterId: string; shopId: string; itemId: string }
  | { type: 'proposeTrade'; characterId: string; to: string; give: Bundle; want: Bundle }
  | { type: 'acceptTrade'; characterId: string; tradeId: string }
  | { type: 'declineTrade'; characterId: string; tradeId: string }
  | { type: 'cancelTrade'; characterId: string; tradeId: string }
  | { type: 'postCommission'; characterId: string; title: string; requirement: Requirement; reward: number; deadline: string }
  | { type: 'acceptCommission'; characterId: string; commissionId: string }
  | { type: 'submitCommission'; characterId: string; commissionId: string; itemIds: string[] }
  | { type: 'reviewCommission'; characterId: string; commissionId: string; approve: boolean }
  | { type: 'cancelCommission'; characterId: string; commissionId: string }
  | { type: 'proposeContract'; characterId: string; with: string[]; title: string; clauses: ClauseDraft[]; deposits: Record<string, number>; deadline: string }
  | { type: 'signContract'; characterId: string; contractId: string }
  | { type: 'fulfillClause'; characterId: string; contractId: string; clauseId: string; itemIds?: string[] }
  | { type: 'requestCancelContract'; characterId: string; contractId: string }
  | { type: 'raiseDispute'; characterId: string; kind: 'commission' | 'contract'; ref: string; reason: string }
  | { type: 'gmVerifyClause'; contractId: string; clauseId: string }
  | { type: 'gmResolveDispute'; disputeId: string; outcome: 'pay' | 'refund' | 'fulfilled' | 'cancel' | { breachBy: string[] } }
  | { type: 'settleDeadlines' }
  | { type: 'createTeam'; characterId: string; teamId: string; name: string; policy: Team['policy'] }
  | { type: 'inviteToTeam'; characterId: string; teamId: string; targetId: string }
  | { type: 'respondTeamInvite'; characterId: string; teamId: string; accept: boolean }
  | { type: 'leaveTeam'; characterId: string; teamId: string }
  | { type: 'depositToTeam'; characterId: string; teamId: string; coins: number; itemIds: string[] }
  | { type: 'proposeTeam'; characterId: string; teamId: string; motion: TeamMotion }
  | { type: 'voteTeam'; characterId: string; teamId: string; proposalId: string; approve: boolean };

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
  | { type: 'inviteDuel'; characterId: string; targetId: string }
  | { type: 'respondDuel'; characterId: string; duelId: string; accept: boolean }
  | { type: 'openDeathRuling'; characterId: string; attackerId: string; combatId: string; cause: string }
  | { type: 'steal'; characterId: string; targetId: string; itemId: string }
  | { type: 'gmSetLocationState'; locationId: string; key: string; value: string | number | boolean; visibility?: 'public' | 'scene' }
  | { type: 'gmSetZone'; locationId: string; zone: Zone }
  | { type: 'gmSetNpcStatus'; npcId: string; status: 'alive' | 'dead'; basis: string }
  | { type: 'gmItemStatus'; itemId: string; status: Item['status']; basis: string }
  | { type: 'gmPublish'; title: string; body: string }
  | { type: 'say'; characterId: string; text: string; mode: 'say' | 'act' | 'ooc' }
  | { type: 'whisper'; characterId: string; to: string; text: string }
  | { type: 'gmNarrate'; locationId: string; text: string; to?: string[] }
  | {
    type: 'gmRequestCheck'; characterId: string; label: string; attribute: AttributeCode; skill: string | null; tn: number;
    situational?: number; mode?: PendingCheck['mode']; highRisk?: boolean; secret?: boolean;
  }
  | { type: 'rollCheck'; characterId: string; checkId: string }
  | { type: 'gmCancelCheck'; characterId: string; checkId: string }
  | { type: 'gmRuling'; rulingId: string; decision: 'confirm' | 'overturn' }
  | { type: 'advanceDay' }
  | { type: 'expireAfterimages' }
  | EconomyCommand;

export interface WorldSubmission {
  actor: WorldActor;
  command: WorldCommand;
  /** Client-generated id; the store applies a given request id once (economy requests must carry one). */
  requestId?: string;
  /** Versions of the entities the client saw; a mismatch means the client acted on a stale view. */
  expected?: Record<string, number>;
}

export interface WorldConfig {
  version: string;
  status: string;
  zones: Record<Zone, { name: string; pvp: boolean; theft: boolean; consequences: boolean }>;
  hostilityLeadMinutes: number;
  duel: { inviteHours: number };
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
  economy: {
    /** When every party to a contract breached, each gets back this share of their deposit; the rest is destroyed. */
    allBreachRefundRatio: number;
    contractMaxParties: number;
    teamMaxMembers: number;
  };
}

/** What a PvP attack would be, before anyone rolls. */
export interface PvpLegality {
  allowed: boolean;
  reason: string;
  /** False: the target can be downed but not killed. Lethal needs an accepted duel or the target's opt-in. */
  lethal: boolean;
  duel?: boolean;
  /** Controlled zone: the attack is a recorded crime. */
  crime: boolean;
}
