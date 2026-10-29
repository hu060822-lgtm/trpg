/**
 * Shapes for interactive combat, shared by the server and the web client (no Node imports).
 *
 * The rule of the whole module: the rules decide first (range, sight, cost, the dice), then what the player does
 * adjusts the result inside a small, pack-set range, and animations never change state. Every interaction comes
 * after its dice: the attack roll before the weapon gesture, the attack and damage rolls before the dodge.
 */

export type Interaction = 'slash' | 'thrust' | 'sweep' | 'draw' | 'rune' | 'none';
export type Tier = 'minion' | 'elite' | 'boss';
export type Side = 'party' | 'ally' | 'foe';
export type Mode = 'full' | 'quick' | 'custom';
export type AreaKind = 'cone' | 'sphere' | 'line' | 'cube';

/** An area in feet: a cone or line from the caster, a sphere or cube at a point. */
export interface AreaShape { kind: AreaKind; size: number; width?: number }

export interface CombatWeapon {
  id: string;
  label: string;
  /** Which modifier the attack and damage use; finesse takes the better of STR and DEX. */
  ability: 'str' | 'dex' | 'finesse';
  /** Damage dice before the modifier, e.g. `1d8`. */
  damage: string;
  damageType: string;
  /** Melee reach in feet (5 unless the weapon says otherwise). */
  reach?: number;
  /** Ranged weapons: normal and long range in feet. */
  range?: [number, number];
  interaction: Interaction;
}

export interface CombatSpell {
  id: string;
  label: string;
  level: number;
  /** A spell attack roll against AC… */
  attack?: boolean;
  /** …or a saving throw against the caster's DC, on this attribute. */
  save?: string;
  halfOnSave?: boolean;
  /** Damage formula; may read the caster's sheet, e.g. `roll(1 + (@level >= 5), 10)`. */
  damage: string;
  damageType: string;
  range: number;
  area?: AreaShape;
  description?: string;
}

export interface MonsterAttack {
  id: string;
  label: string;
  /** Attack bonus, for attacks rolled against AC. */
  bonus?: number;
  /** Or a save the targets roll. */
  save?: { attr: string; dc: number; half: boolean };
  damage: string;
  damageType: string;
  reach?: number;
  range?: [number, number];
  area?: AreaShape;
  /** The bullet pattern a player dodges when this attack hits them. */
  pattern?: string;
}

export interface Monster {
  id: string;
  name: string;
  size: number;
  ac: number;
  hp: number;
  speed: number;
  /** Initiative and DEX saves. */
  dex: number;
  /** Saving throw bonuses by attribute id; missing ones count as +0. */
  saves?: Record<string, number>;
  tier: Tier;
  /** Attacks per Attack action. */
  multiattack?: number;
  attacks: MonsterAttack[];
  /** Bullet patterns used when an attack names none. */
  patterns?: string[];
  /** Boss phases: when HP falls to `below` percent, these patterns take over. */
  phases?: { below: number; patterns: string[]; say?: string }[];
}

/** One emitter on a pattern's timeline. Arena units: the box is 1000 × 1000. Times in ms, speeds in units per second. */
export interface Emitter {
  at: number;
  kind: 'fan' | 'ring' | 'aimed' | 'rain' | 'laser' | 'spiral' | 'wall';
  count: number;
  speed: number;
  /** Fan spread, in table angles (256 = full turn). */
  spread?: number;
  /** Where bullets come from. */
  side?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  /** Fire again this many more times, `every` ms apart. */
  repeat?: number;
  every?: number;
  /** Bullet radius in arena units. */
  size?: number;
  /** Width of the opening in a wall, or of a laser. */
  gap?: number;
}
export interface PatternDef { id: string; name: string; emitters: Emitter[] }

/** Model B: how the dodge feels depends on the margin m (positive favours the defender). */
export interface TierRow { id: string; label: string; min: number; duration: number; density: number; speed: number; arena: number }

export interface CombatRules {
  distance: 'chebyshev' | 'alternate';
  /** Model B rows, best first; a row applies when m ≥ min. */
  tiers: TierRow[];
  /** Damage factor by number of hits taken in the dodge; the last entry covers everything above. */
  factors: number[];
  /** Attack bonus from interaction quality: [quality at least, bonus], highest first. */
  bonus: [number, number][];
  /** A minor enemy's attack only gets this long a dodge. */
  shortDodgeMs: number;
}

export interface EncounterTemplateEntry { monsterId: string; dx: number; dy: number; name?: string; hidden?: boolean; tier?: Tier }
export interface EncounterTemplate { id: string; name: string; entries: EncounterTemplateEntry[] }

export interface PackCombat {
  rules: CombatRules;
  weapons: CombatWeapon[];
  spells: CombatSpell[];
  monsters: Monster[];
  patterns: PatternDef[];
  encounters: EncounterTemplate[];
}

// ---------- encounter state ----------

export const CONDITIONS = ['prone', 'unconscious', 'poisoned', 'blinded', 'restrained', 'frightened', 'dodging'] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_LABEL: Record<Condition, string> = {
  prone: '倒地', unconscious: '昏迷', poisoned: '中毒', blinded: '目盲', restrained: '束縛', frightened: '恐懼', dodging: '閃避動作',
};

export interface Combatant {
  id: string;
  tokenId: string;
  name: string;
  side: Side;
  /** A user id, or 'gm' for creatures the GMs run. */
  controller: string;
  characterId?: string;
  monsterId?: string;
  tier: Tier;
  initiative: number | null;
  /** Seen by GMs only, until revealed. */
  hidden: boolean;
  hp: number;
  maxHp: number;
  tempHp: number;
  ac: number;
  speed: number;
  dex: number;
  conditions: Condition[];
  dying?: { successes: number; failures: number };
  stable?: boolean;
  dead?: boolean;
  defeated?: boolean;
  /** Custom mode: how much interaction this creature gets. */
  interaction: 'auto' | 'full' | 'quick';
  /** Boss phase reached (0 = first). */
  phase: number;
  /** Patterns the GM gave this creature; override the monster's. */
  patterns?: string[];
  /** A creature the GM described by hand instead of picking from the bestiary. */
  custom?: { attacks: MonsterAttack[]; multiattack?: number; saves?: Record<string, number> };
}

export interface Turn {
  combatantId: string;
  movementUsed: number;
  dashed: boolean;
  actionUsed: boolean;
  attacksLeft: number;
  /** The GMs handed this turn to the autopilot. */
  auto?: boolean;
}

/** What is being attacked with. */
export type AttackSource =
  | { kind: 'weapon'; id: string }
  | { kind: 'spell'; id: string }
  | { kind: 'monster'; id: string };

export interface TargetResult {
  combatantId: string;
  /** Attack rolls: hit or miss, and whether it was a critical. */
  hit?: boolean;
  critical?: boolean;
  /** Save attacks: the target's save. */
  save?: { total: number; text: string; success: boolean };
  damage?: { total: number; text: string };
  /** Model B margin and the row it picked. */
  margin?: number;
  tier?: string;
  dodge?: { hits: number; factor: number; skipped?: string };
  applied?: number;
}

/** One attack, start to finish. Steps walk through it; every number in it came from the server. */
export interface AttackFlow {
  id: string;
  attackerId: string;
  source: AttackSource;
  label: string;
  interaction: Interaction;
  targets: string[];
  /** Where an area is centred, in squares. */
  point?: { x: number; y: number };
  mode: 'normal' | 'advantage' | 'disadvantage';
  roll?: { total: number; text: string; natural: number };
  quality?: number;
  bonus?: number;
  dc?: number;
  results: TargetResult[];
}

export type StepKind = 'initiative' | 'attackRoll' | 'attackInteract' | 'saveRoll' | 'dodge' | 'deathSave' | 'npcPending';

export interface Step {
  id: string;
  kind: StepKind;
  /** Whose input the step waits for (user ids); empty once nobody is left. */
  awaiting: string[];
  /** The combatant acting in it (attacker, defender, the dying one). */
  combatantId?: string;
  seed: number;
  startsAt: string;
  deadline: string;
  /** Dodge: who pressed start (a started dodge cannot be restarted by reconnecting). */
  begunAt?: string;
  /** Dodge parameters, worked out before the step starts so every screen shows the same thing. */
  dodge?: DodgeSetup;
  /** Initiative: who has rolled. */
  rolled?: Record<string, number>;
}

export interface DodgeSetup {
  tier: TierRow;
  duration: number;
  pattern: PatternDef;
  /** Accessibility setting of the defender: 'reduced' slows the bullets. */
  reduced: boolean;
  damage: number;
}

export interface Trigger {
  id: string;
  when: { kind: 'hpBelow'; combatantId: string; percent: number } | { kind: 'round'; round: number } | { kind: 'enter'; x: number; y: number; w: number; h: number };
  then: { kind: 'say'; text: string } | { kind: 'reveal'; combatantId: string } | { kind: 'patterns'; combatantId: string; patterns: string[] } | { kind: 'tier'; combatantId: string; tier: Tier };
  fired?: boolean;
}

export interface EncounterState {
  id: string;
  roomId: string;
  mapId: string;
  status: 'initiative' | 'active' | 'paused' | 'ended';
  round: number;
  order: string[];
  turnIndex: number;
  mode: Mode;
  combatants: Record<string, Combatant>;
  turn: Turn | null;
  step: Step | null;
  flow: AttackFlow | null;
  triggers: Trigger[];
  /** NPC turns resolve themselves after a short pause unless a GM steps in. */
  autoNpc: boolean;
  /** Players see exact enemy HP instead of words. */
  showFoeHp: boolean;
  seq: number;
  /** While paused: what it was doing and since when (deadlines move by the pause). */
  pausedFrom?: 'initiative' | 'active';
  pausedAt?: string;
}

/** What a player may see: hidden creatures dropped, enemy numbers blurred. */
export interface CombatantView extends Omit<Combatant, 'hp' | 'maxHp' | 'ac'> {
  hp: number | null;
  maxHp: number | null;
  ac: number | null;
  /** Words for an enemy's wounds when numbers are hidden. */
  health: string;
}
export interface EncounterView extends Omit<EncounterState, 'combatants' | 'triggers'> {
  combatants: Record<string, CombatantView>;
  triggers: Trigger[];
  you: { userId: string; gm: boolean; prefs: CombatPrefs };
}

export interface CombatPrefs {
  interaction: 'full' | 'reduced' | 'off';
  skipAnimations: boolean;
  watchReplays: boolean;
  highContrast: boolean;
  /** Use one key instead of drawing for weapon gestures. */
  oneKey: boolean;
}
export const DEFAULT_PREFS: CombatPrefs = { interaction: 'full', skipAnimations: false, watchReplays: true, highContrast: false, oneKey: false };

export interface EncounterEvent {
  seq: number;
  at: string;
  kind: string;
  text: string;
  gmOnly: boolean;
  data?: unknown;
}

/** Input from a weapon gesture: pointer samples in a 1000 × 1000 box, or key presses for the one-key mode. */
export interface InputSample { t: number; x: number; y: number; d: 0 | 1 }
export type GestureInput = { kind: 'pointer'; samples: InputSample[] } | { kind: 'keys'; presses: { t: number; key: string; up?: boolean }[] };
/** Input from a dodge: one direction per 1/60 s tick (0 still, 1–8 clockwise from up). */
export interface DodgeInput { moves: string }

/** One token joining a fight: a character comes from its sheet, anything else from the bestiary or by hand. */
export interface SetupEntry {
  tokenId: string;
  side?: Side;
  monsterId?: string;
  tier?: Tier;
  name?: string;
  ac?: number;
  hp?: number;
  speed?: number;
  dex?: number;
  attacks?: MonsterAttack[];
  multiattack?: number;
  hidden?: boolean;
  /** A character's HP carried over from the last fight. */
  hpNow?: number;
}

export interface StartInput {
  entries?: SetupEntry[];
  /** Places a ready-made group from the pack around a square and adds it. */
  template?: { id: string; x: number; y: number };
  mode?: Mode;
  autoNpc?: boolean;
  showFoeHp?: boolean;
}
