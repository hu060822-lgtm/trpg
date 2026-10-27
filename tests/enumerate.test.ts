import { describe, expect, it } from 'vitest';
import { RULES_V02, RULES_V03 } from '../src/rules/config';
import { distribution } from '../src/sim/enumerate';
import type { RulesConfig } from '../src/rules/types';

const pct = (x: number) => Number((x * 100).toFixed(2));

describe('exact enumeration', () => {
  // Reference values from the independent Python enumeration in the Chapter 11 report.
  it.each([
    [7, 16, 'normal', 60], [7, 20, 'normal', 40], [18, 32, 'normal', 35],
    [13, 24, 'advantage', 75], [13, 24, 'disadvantage', 25], [18, 32, 'advantage', 57.75],
  ] as const)('v0.3 bonus %i vs TN %i (%s) = %f%%', (bonus, tn, mode, expected) => {
    expect(pct(distribution({ attribute: 0, skill: bonus, tn, mode }, RULES_V03).pSuccess)).toBe(expected);
  });

  it.each([[7, 18, 52.5], [18, 38, 8.33], [2, 14, 47.5]])('v0.2 bonus %i vs TN %i = %f%%', (bonus, tn, expected) => {
    expect(pct(distribution({ attribute: 0, skill: bonus, tn }, RULES_V02).pSuccess)).toBe(expected);
  });

  it('tier probabilities sum to 1', () => {
    const d = distribution({ attribute: 2, skill: 3, tn: 20, mode: 'advantage', highRisk: true }, RULES_V03);
    expect(Object.values(d.tiers).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('natural rules never change the success rate', () => {
    const off: RulesConfig = { ...RULES_V03, check: { ...RULES_V03.check, naturalRules: false } };
    for (let b = 0; b <= 18; b++) {
      for (const d of RULES_V03.difficulties) {
        for (const mode of ['normal', 'advantage', 'disadvantage'] as const) {
          const input = { attribute: 0, skill: b, tn: d.tn, mode };
          expect(distribution(input, RULES_V03).pSuccess).toBeCloseTo(distribution(input, off).pSuccess, 12);
        }
      }
    }
  });

  it('unflagged catastrophe comes only from natural 1 (≤ 5%)', () => {
    const d = distribution({ attribute: 0, skill: 0, tn: 28 }, RULES_V03);
    expect(d.preCheck).toBe('impossible');
    const e = distribution({ attribute: 0, skill: 2, tn: 20 }, RULES_V03);
    expect(e.tiers.catastrophe).toBeCloseTo(0.05, 12);
  });
});
