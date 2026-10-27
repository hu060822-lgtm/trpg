export type AttributeCode =
  | 'STR' | 'AGI' | 'VIT' | 'PRE' | 'PER' | 'INT' | 'WIL' | 'CHA' | 'INS' | 'SPR';

export type RollMode = 'normal' | 'advantage' | 'disadvantage';

export type TierKey = 'catastrophe' | 'failure' | 'partial' | 'success' | 'strong' | 'exceptional';

export interface Tier {
  key: TierKey;
  name: string;
  /** Lowest margin that reaches this tier; null for the bottom tier. */
  minMargin: number | null;
}

export interface Difficulty {
  key: string;
  name: string;
  tn: number;
}

export interface RulesConfig {
  version: string;
  attribute: { min: number; max: number; creationBase: number; creationFreePoints: number; creationMax: number };
  skill: { min: number; max: number; creationPoints: number; creationMax: number; creationCoreMin: number };
  check: {
    die: number;
    /** v0.2 used { die: 6, offset: -3 }; v0.3 removed it. */
    wobble: { die: number; offset: number } | null;
    situationalCap: number;
    naturalRules: boolean;
    autoSuccess: boolean;
    catastropheRequiresHighRisk: boolean;
  };
  difficulties: Difficulty[];
  tiers: Tier[];
  hp: { base: number; perVit: number };
}

export interface CheckInput {
  attribute: number;
  skill: number;
  situational?: number;
  tn: number;
  mode?: RollMode;
  /** GM flagged the action as high-risk before the roll (v0.3 §2.4). */
  highRisk?: boolean;
}

/** Raw dice for one check. Two d20 values when rolling with advantage or disadvantage. */
export interface CheckRolls {
  d20: number[];
  wobble?: number;
}

export type PreCheck = 'auto' | 'impossible' | 'roll';
