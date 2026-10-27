import { preCheck, resolveCheck } from '../rules/check';
import type { CheckInput, CheckRolls, PreCheck, RulesConfig, TierKey } from '../rules/types';

export interface Distribution {
  preCheck: PreCheck;
  /** Probability of each final tier, as exact fractions numerator / denominator. */
  tiers: Record<TierKey, number>;
  pSuccess: number;
}

function allRolls(input: CheckInput, config: RulesConfig): CheckRolls[] {
  const die = config.check.die;
  const d20Sets: number[][] = [];
  for (let a = 1; a <= die; a++) {
    if ((input.mode ?? 'normal') === 'normal') d20Sets.push([a]);
    else for (let b = 1; b <= die; b++) d20Sets.push([a, b]);
  }
  const w = config.check.wobble;
  if (!w) return d20Sets.map((d20) => ({ d20 }));
  return d20Sets.flatMap((d20) => Array.from({ length: w.die }, (_, k) => ({ d20, wobble: k + 1 })));
}

/**
 * Exact outcome distribution by enumerating every dice combination through the real
 * resolveCheck, so the simulator can never drift from the engine.
 * Auto-success counts as 100% success; impossible and skill-required count as 100% failure (no roll is made).
 */
export function distribution(input: CheckInput, config: RulesConfig): Distribution {
  const tiers = Object.fromEntries(config.tiers.map((t) => [t.key, 0])) as Record<TierKey, number>;
  const pre = preCheck(input, config);
  if (pre === 'auto') return { preCheck: pre, tiers: { ...tiers, success: 1 }, pSuccess: 1 };
  if (pre === 'impossible' || pre === 'skill-required') return { preCheck: pre, tiers: { ...tiers, failure: 1 }, pSuccess: 0 };

  const rolls = allRolls(input, config);
  const p = 1 / rolls.length;
  let pSuccess = 0;
  for (const r of rolls) {
    const res = resolveCheck(input, r, config);
    tiers[res.tier] += p;
    if (res.success) pSuccess += p;
  }
  return { preCheck: pre, tiers, pSuccess };
}
