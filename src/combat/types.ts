import type { AttributeCode, TierKey } from '../rules/types';

export type Condition = 'healthy' | 'wounded' | 'severe' | 'dying' | 'stable' | 'dead' | 'escaped';

/** Who is sending a command. GMs may act for combatants controlled by 'gm'. */
export interface Actor {
  userId: string;
  role: 'player' | 'gm';
}

export interface CombatantSetup {
  id: string;
  name: string;
  side: string;
  /** userId of the controlling player, or 'gm' for NPCs. */
  controller: string;
  characterId?: string;
  attributes: Record<AttributeCode, number>;
  skills: Record<string, number>;
  maxHp: number;
  hp?: number;
  band: number;
  weaponId: string;
  armorId: string;
  potions?: number;
  medkits?: number;
  /** Offline PvP protection: reaching 0 HP stabilizes instead of risking death. */
  deathProtected?: boolean;
  /** PvP: a death is not final until a GM confirms it; the combatant is held unconscious meanwhile. */
  deathNeedsRuling?: boolean;
}

export interface Combatant extends Required<Omit<CombatantSetup, 'characterId'>> {
  characterId?: string;
  condition: Condition;
  dying: { successes: number; failures: number };
  defending: boolean;
  initiative: number;
  /** Set when a death awaits GM confirmation; the combatant is out of the fight and ignores further harm. */
  pendingDeath?: string;
}

export interface CombatEvent {
  seq: number;
  round: number;
  at: string;
  kind: string;
  combatantId?: string;
  data: Record<string, unknown>;
}

export interface TurnState {
  combatantId: string;
  /** 'deathSave': a dying player-controlled combatant whose only legal action is to roll the death save. */
  kind?: 'act' | 'deathSave';
  ap: number;
  attacks: number;
  startedAt: string;
  deadline: string;
}

export interface CombatState {
  id: string;
  status: 'active' | 'ended';
  round: number;
  order: string[];
  combatants: Record<string, Combatant>;
  turn: TurnState | null;
  /** actionId → seq of the event that recorded it; makes resubmission a no-op. */
  processed: Record<string, number>;
  events: CombatEvent[];
  winner: string | null;
  seq: number;
  /** Keep the combat open until no one is dying (PvP), so every downed combatant's fate is rolled. */
  resolveDying?: boolean;
}

export type CombatAction =
  | { type: 'move'; to: number }
  | { type: 'attack'; targetId: string; attribute?: AttributeCode }
  | { type: 'defend' }
  | { type: 'usePotion'; targetId?: string }
  | { type: 'rescue'; targetId: string; useMedkit?: boolean }
  | { type: 'escape' }
  | { type: 'deathSave' }
  | { type: 'endTurn' };

export interface Submission {
  /** Client-generated id; the same id submitted twice is applied once. */
  actionId: string;
  actor: Actor;
  combatantId: string;
  /** Round the client saw; stale submissions are rejected. */
  round: number;
  action: CombatAction;
}

export interface CombatConfig {
  version: string;
  status: string;
  apPerTurn: number;
  maxAttacksPerTurn: number;
  actionCosts: Record<'move' | 'attack' | 'defend' | 'useItem' | 'rescue' | 'escape', number>;
  initiative: { attributes: AttributeCode[] };
  bands: { count: number; names: string[] };
  defense: { base: number; attribute: AttributeCode; skill: string; defendBonus: number };
  damageByTier: Record<TierKey, { multiplier: number; bonus: number }>;
  wounds: { woundedAtOrBelow: number; severeAtOrBelow: number };
  dying: { attribute: AttributeCode; tn: number; successesToStabilize: number; failuresToDie: number; stabilizedHp: number; playerRolls: boolean };
  rescue: { tn: number; attributes: AttributeCode[]; skills: string[]; strongHealRatio: number };
  escape: { tn: number; attribute: AttributeCode; skill: string };
  potionHeal: number;
  turnDeadlineHours: number;
}

export interface WeaponDef { id: string; name: string; kind: 'weapon'; damage: number; range: number; attributes: AttributeCode[]; skill: string }
export interface ArmorDef { id: string; name: string; kind: 'armor'; defense: number; reduction: number }
export type ItemDef = WeaponDef | ArmorDef;
