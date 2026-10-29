import type { CombatRules, PatternDef, TierRow } from './types';

/** Model B: the first row (best first) whose minimum the margin reaches; a critical hit always takes the worst row. */
export function tierFor(rules: CombatRules, margin: number, critical = false): TierRow {
  const rows = rules.tiers;
  if (critical) return rows[rows.length - 1];
  return rows.find((r) => margin >= r.min) ?? rows[rows.length - 1];
}

/** The damage factor for taking `hits` in a dodge. */
export function factorFor(rules: CombatRules, hits: number): number {
  return rules.factors[Math.min(hits, rules.factors.length - 1)];
}

/** The attack bonus a gesture of this quality earns. */
export function bonusFor(rules: CombatRules, quality: number): number {
  for (const [atLeast, bonus] of rules.bonus) if (quality >= atLeast) return bonus;
  return 0;
}

/** Damage after a dodge: rounded down, as 5E rounds, but a hit that did damage still does at least 1. */
export function scaledDamage(damage: number, factor: number): number {
  if (damage <= 0) return 0;
  return Math.max(1, Math.floor(damage * factor));
}

/** Words for how hurt a creature looks, for players who do not see enemy numbers. */
export function healthWords(hp: number, max: number, defeated: boolean): string {
  if (defeated || hp <= 0) return '倒下';
  const p = hp / Math.max(1, max);
  if (p >= 1) return '毫髮無傷';
  if (p > 0.5) return '輕傷';
  if (p > 0.25) return '重傷';
  return '奄奄一息';
}

export const DEFAULT_RULES: CombatRules = {
  distance: 'chebyshev',
  tiers: [
    { id: 'overwhelm', label: '壓制', min: 5, duration: 3000, density: 0.6, speed: 1.1, arena: 1.2 },
    { id: 'advantage', label: '優勢', min: 1, duration: 4000, density: 0.8, speed: 1.0, arena: 1.0 },
    { id: 'even', label: '均勢', min: -2, duration: 5000, density: 1.0, speed: 1.0, arena: 1.0 },
    { id: 'disadvantage', label: '劣勢', min: -6, duration: 5000, density: 1.25, speed: 0.85, arena: 0.9 },
    { id: 'desperate', label: '危急', min: -999, duration: 6000, density: 1.5, speed: 0.7, arena: 0.75 },
  ],
  factors: [0.5, 0.75, 1, 1.1, 1.25],
  bonus: [[0.9, 2], [0.6, 1]],
  shortDodgeMs: 3000,
};

/** Patterns for packs that bring none of their own. */
export const BASIC_PATTERNS: PatternDef[] = [
  { id: 'basic-rain', name: '針雨', emitters: [{ at: 300, kind: 'rain', count: 5, speed: 260, repeat: 10, every: 520, size: 7 }] },
  { id: 'basic-fan', name: '扇形', emitters: [{ at: 400, kind: 'fan', count: 5, speed: 300, spread: 56, side: 'top', repeat: 6, every: 800 }] },
  { id: 'basic-ring', name: '環形', emitters: [{ at: 500, kind: 'ring', count: 10, speed: 220, side: 'center', repeat: 4, every: 1100 }] },
];
