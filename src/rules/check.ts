import type { CheckInput, CheckRolls, PreCheck, RulesConfig, Tier, TierKey } from './types';
import type { Rng } from './dice';

export interface CheckResult {
  input: Required<CheckInput>;
  rolls: CheckRolls;
  /** The d20 value actually used after advantage/disadvantage. */
  d20: number;
  total: number;
  margin: number;
  rawTier: TierKey;
  tier: TierKey;
  tierName: string;
  success: boolean;
  natural: 1 | 20 | null;
  auto: boolean;
}

function normalize(input: CheckInput, config: RulesConfig): Required<CheckInput> {
  const cap = config.check.situationalCap;
  const situational = input.situational ?? 0;
  if (Math.abs(situational) > cap) {
    throw new RangeError(`situational modifier ${situational} exceeds cap ±${cap}`);
  }
  return { situational, mode: 'normal', highRisk: false, ...input };
}

function wobbleRange(config: RulesConfig): [number, number] {
  const w = config.check.wobble;
  return w ? [1 + w.offset, w.die + w.offset] : [0, 0];
}

/** v0.3 §2.6: decide whether a roll is needed at all. */
export function preCheck(input: CheckInput, config: RulesConfig): PreCheck {
  const i = normalize(input, config);
  const base = i.attribute + i.skill + i.situational;
  const [wMin, wMax] = wobbleRange(config);
  if (config.check.autoSuccess && 1 + base + wMin >= i.tn) return 'auto';
  if (config.check.die + base + wMax < i.tn) return 'impossible';
  return 'roll';
}

export function tierIndexForMargin(margin: number, tiers: Tier[]): number {
  for (let t = tiers.length - 1; t > 0; t--) {
    if (margin >= (tiers[t].minMargin as number)) return t;
  }
  return 0;
}

const SUCCESS_INDEX = 3; // 'success' in the tier ladder

/** Pure resolution: same input and same dice always give the same result. */
export function resolveCheck(input: CheckInput, rolls: CheckRolls, config: RulesConfig): CheckResult {
  const i = normalize(input, config);
  const expected = i.mode === 'normal' ? 1 : 2;
  if (rolls.d20.length !== expected) {
    throw new Error(`mode ${i.mode} needs ${expected} d20 value(s), got ${rolls.d20.length}`);
  }
  const d20 = i.mode === 'advantage' ? Math.max(...rolls.d20)
    : i.mode === 'disadvantage' ? Math.min(...rolls.d20)
    : rolls.d20[0];
  const wobble = config.check.wobble ? (rolls.wobble ?? NaN) + config.check.wobble.offset : 0;
  if (Number.isNaN(wobble)) throw new Error('wobble die required by this ruleset');

  const total = d20 + i.attribute + i.skill + i.situational + wobble;
  const margin = total - i.tn;
  const tiers = config.tiers;

  let raw = tierIndexForMargin(margin, tiers);
  // v0.3 §2.4: without a pre-roll high-risk flag, the floor is plain failure.
  if (raw === 0 && config.check.catastropheRequiresHighRisk && !i.highRisk) raw = 1;

  let t = raw;
  const natural = d20 === 20 ? 20 : d20 === 1 ? 1 : null;
  if (config.check.naturalRules) {
    // Naturals shift the tier but never cross the success line (v0.3 §2.5).
    if (natural === 20 && t >= SUCCESS_INDEX) t = Math.min(tiers.length - 1, t + 1);
    if (natural === 1 && t < SUCCESS_INDEX) t = Math.max(0, t - 1);
  }

  return {
    input: i, rolls, d20, total, margin,
    rawTier: tiers[raw].key, tier: tiers[t].key, tierName: tiers[t].name,
    success: t >= SUCCESS_INDEX, natural, auto: false,
  };
}

export type PerformedCheck =
  | { kind: 'auto'; result: CheckResult }
  | { kind: 'impossible'; input: Required<CheckInput> }
  | { kind: 'rolled'; result: CheckResult };

/** Runs the pre-check, then rolls with the supplied RNG if a roll is needed. */
export function performCheck(input: CheckInput, rng: Rng, config: RulesConfig): PerformedCheck {
  const i = normalize(input, config);
  const pre = preCheck(i, config);
  if (pre === 'impossible') return { kind: 'impossible', input: i };
  if (pre === 'auto') {
    const tiers = config.tiers;
    return {
      kind: 'auto',
      result: {
        input: i, rolls: { d20: [] }, d20: 0, total: NaN, margin: NaN,
        rawTier: 'success', tier: 'success', tierName: tiers[SUCCESS_INDEX].name,
        success: true, natural: null, auto: true,
      },
    };
  }
  const n = i.mode === 'normal' ? 1 : 2;
  const rolls: CheckRolls = { d20: Array.from({ length: n }, () => rng(config.check.die)) };
  if (config.check.wobble) rolls.wobble = rng(config.check.wobble.die);
  return { kind: 'rolled', result: resolveCheck(i, rolls, config) };
}
