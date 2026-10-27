import { describe, expect, it } from 'vitest';
import { performCheck, preCheck, resolveCheck } from '../src/rules/check';
import { RULES_V02, RULES_V03 } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';

const C = RULES_V03;
const base = { attribute: 3, skill: 4, tn: 16 }; // bonus 7

describe('resolveCheck (v0.3)', () => {
  it('adds d20 + attribute + skill + situational', () => {
    const r = resolveCheck({ ...base, situational: 2 }, { d20: [10] }, C);
    expect(r.total).toBe(19);
    expect(r.margin).toBe(3);
    expect(r.tier).toBe('strong');
  });

  it.each([
    [15, 'exceptional'], [12, 'strong'], [9, 'success'], [6, 'partial'], [2, 'failure'],
  ])('d20 %i → %s', (d20, tier) => {
    expect(resolveCheck(base, { d20: [d20] }, C).tier).toBe(tier);
  });

  it('caps margin ≤ −8 at failure unless the action was flagged high-risk', () => {
    const hard = { attribute: 0, skill: 0, tn: 16 };
    expect(resolveCheck(hard, { d20: [5] }, C).tier).toBe('failure');
    expect(resolveCheck({ ...hard, highRisk: true }, { d20: [5] }, C).tier).toBe('catastrophe');
  });

  it('natural 1 still drops a failure to catastrophe without a high-risk flag', () => {
    const r = resolveCheck({ attribute: 0, skill: 0, tn: 12 }, { d20: [1] }, C);
    expect(r.rawTier).toBe('failure');
    expect(r.tier).toBe('catastrophe');
  });

  it('natural 20 upgrades a success but never rescues a failure', () => {
    expect(resolveCheck({ attribute: 0, skill: 0, tn: 20 }, { d20: [20] }, C).tier).toBe('strong');
    const miss = resolveCheck({ attribute: 0, skill: 0, situational: -2, tn: 20 }, { d20: [20] }, C);
    expect(miss.tier).toBe('partial');
    expect(miss.success).toBe(false);
  });

  it('natural 1 never turns a success into a failure', () => {
    const r = resolveCheck({ attribute: 6, skill: 12, tn: 16 }, { d20: [1] }, C);
    expect(r.success).toBe(true);
  });

  it('advantage takes the higher d20, disadvantage the lower', () => {
    expect(resolveCheck({ ...base, mode: 'advantage' }, { d20: [3, 17] }, C).d20).toBe(17);
    expect(resolveCheck({ ...base, mode: 'disadvantage' }, { d20: [3, 17] }, C).d20).toBe(3);
  });

  it('rejects the wrong number of dice and out-of-cap modifiers', () => {
    expect(() => resolveCheck({ ...base, mode: 'advantage' }, { d20: [3] }, C)).toThrow();
    expect(() => resolveCheck({ ...base, situational: 6 }, { d20: [3] }, C)).toThrow(RangeError);
  });

  it('is deterministic for the same input and dice', () => {
    const a = resolveCheck(base, { d20: [11] }, C);
    const b = resolveCheck(base, { d20: [11] }, C);
    expect(a).toEqual(b);
  });
});

describe('preCheck and performCheck (v0.3 §2.6)', () => {
  it('auto-succeeds when the lowest possible total meets the TN', () => {
    expect(preCheck({ attribute: 6, skill: 10, tn: 16 }, C)).toBe('auto');
    expect(preCheck({ attribute: 6, skill: 8, tn: 16 }, C)).toBe('roll');
  });

  it('reports impossible when the highest possible total misses the TN', () => {
    expect(preCheck({ attribute: 3, skill: 4, tn: 28 }, C)).toBe('impossible');
    expect(preCheck({ attribute: 3, skill: 4, situational: 1, tn: 28 }, C)).toBe('roll');
  });

  it('does not consume dice for auto or impossible checks', () => {
    const rng = scriptedRng([]);
    expect(performCheck({ attribute: 6, skill: 12, tn: 12 }, rng, C).kind).toBe('auto');
    expect(performCheck({ attribute: 0, skill: 0, tn: 32 }, rng, C).kind).toBe('impossible');
  });

  it('rolls two d20 with advantage', () => {
    const out = performCheck({ ...base, mode: 'advantage' }, scriptedRng([4, 18]), C);
    expect(out.kind).toBe('rolled');
    if (out.kind === 'rolled') expect(out.result.d20).toBe(18);
  });
});

describe('v0.2 ruleset stays reproducible', () => {
  it('applies the D6−3 wobble', () => {
    const r = resolveCheck({ attribute: 3, skill: 4, tn: 18 }, { d20: [10], wobble: 6 }, RULES_V02);
    expect(r.total).toBe(20);
  });
  it('allows catastrophe without a high-risk flag', () => {
    const r = resolveCheck({ attribute: 0, skill: 0, tn: 18 }, { d20: [5], wobble: 3 }, RULES_V02);
    expect(r.tier).toBe('catastrophe');
  });
});
