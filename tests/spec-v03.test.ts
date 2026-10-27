// Locks in the 2026-10-27 conflict rulings so later edits cannot silently drift from them.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import examples from '../config/creation-examples.json';
import {
  CLASSES, SKILLS, attributeTotal, createCharacter, exampleBuild, maxHp, skillTierName, validateDraft,
  type CharacterDraft,
} from '../src/character/create';
import { normalize, performCheck, preCheck, resolveCheck } from '../src/rules/check';
import { DEFAULT_RULES, RULES_V02, RULES_V03, getRules } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import { distribution } from '../src/sim/enumerate';
import type { AttributeCode } from '../src/rules/types';

const C = RULES_V03;

describe('ruleset selection', () => {
  it('defaults to v0.3 and marks v0.2 historical', () => {
    expect(DEFAULT_RULES.version).toBe('0.3');
    expect(RULES_V03.status).toBe('active');
    expect(RULES_V02.status).toBe('historical');
  });

  it('refuses v0.2 for the game but allows it for comparison', () => {
    expect(() => getRules('0.2')).toThrow(/historical/);
    expect(getRules('0.2', { allowHistorical: true }).version).toBe('0.2');
    expect(() => performCheck({ attribute: 1, skill: 1, tn: 14 }, scriptedRng([10, 3]), RULES_V02)).toThrow(/historical/);
    expect(() => createCharacter(exampleBuild('scout', C), RULES_V02)).toThrow(/historical/);
  });

  it('has no D6 wobble in v0.3', () => {
    expect(C.check.wobble).toBeNull();
  });
});

describe('difficulty table', () => {
  it('is exactly TN 12/16/20/24/28/32 with the agreed names', () => {
    expect(C.difficulties.map((d) => [d.name, d.tn])).toEqual([
      ['簡單', 12], ['普通', 16], ['困難', 20], ['極難', 24], ['傳奇', 28], ['神話', 32],
    ]);
  });
});

describe('combined modifier cap (±5 on situational + equipment together)', () => {
  it.each([
    [3, 2, 5, false], [4, 3, 5, true], [5, 5, 5, true], [-4, -4, -5, true], [5, -5, 0, false], [-2, 1, -1, false],
  ])('situational %i + equipment %i → %i (capped %s)', (situational, equipment, modifier, capped) => {
    const n = normalize({ attribute: 0, skill: 0, tn: 12, situational, equipment }, C);
    expect(n.modifier).toBe(modifier);
    expect(n.modifierCapped).toBe(capped);
  });

  it('applies the capped sum to the total', () => {
    expect(resolveCheck({ attribute: 2, skill: 2, tn: 16, situational: 4, equipment: 4 }, { d20: [10] }, C).total).toBe(19);
  });

  it('uses the capped sum in the pre-check', () => {
    // 20 + 1 + 1 + 5 = 27 < 28 even though the uncapped sum would reach 31.
    expect(preCheck({ attribute: 1, skill: 1, tn: 28, situational: 5, equipment: 4 }, C)).toBe('impossible');
  });
});

describe('natural 1/20 switch', () => {
  it('is on by default in v0.3 and can be turned off', () => {
    expect(C.check.naturalRules).toBe(true);
    const off = { ...C, check: { ...C.check, naturalRules: false } };
    expect(resolveCheck({ attribute: 0, skill: 0, tn: 20 }, { d20: [20] }, off).tier).toBe('success');
    expect(resolveCheck({ attribute: 0, skill: 0, tn: 20 }, { d20: [20] }, C).tier).toBe('strong');
  });
});

describe('skill tiers', () => {
  it.each([
    [0, '未受訓練'], [1, '初學者'], [2, '初學者'], [3, '熟練者'], [4, '熟練者'], [5, '專家'], [6, '專家'],
    [7, '大師'], [9, '大師'], [10, '傳奇'], [12, '傳奇'],
  ])('level %i is %s', (level, name) => {
    expect(skillTierName(level, C)).toBe(name);
  });

  it('covers every level from min to max exactly once', () => {
    for (let lv = C.skill.min; lv <= C.skill.max; lv++) {
      expect(C.skill.tiers.filter((t) => lv >= t.min && lv <= t.max)).toHaveLength(1);
    }
    expect(() => skillTierName(13, C)).toThrow(RangeError);
  });
});

describe('skill list', () => {
  const names = SKILLS.map((s) => s.name);

  it('has 生存 and no longer has 求生 or 野外生存', () => {
    expect(names).toContain('生存');
    expect(names).not.toContain('求生');
    expect(names).not.toContain('野外生存');
    expect(SKILLS.map((s) => s.id)).not.toContain('wilderness');
  });

  it('formally includes 防護 and 意志抵抗', () => {
    expect(names).toContain('防護');
    expect(names).toContain('意志抵抗');
    for (const s of SKILLS) expect(Object.keys(s).sort()).toEqual(['category', 'id', 'name']);
  });

  it('has unique ids and names', () => {
    expect(new Set(SKILLS.map((s) => s.id)).size).toBe(SKILLS.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every class core skill exists in the skill list', () => {
    const ids = new Set(SKILLS.map((s) => s.id));
    for (const c of CLASSES) for (const s of c.coreSkills) expect(ids.has(s), `${c.name} → ${s}`).toBe(true);
    expect(CLASSES.find((c) => c.id === 'survivor')!.coreSkills).toContain('survival');
  });

  it('leaves no old skill names anywhere in config, source, tests or web', () => {
    const roots = ['config', 'src', 'web'];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (f === 'dist' || f === 'node_modules') continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/野外生存|求生(?!者)|wilderness/.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    roots.forEach(walk);
    expect(hits).toEqual([]);
  });
});

describe('character creation: 15 attribute points', () => {
  const blank = (): Record<AttributeCode, number> =>
    ({ STR: 0, AGI: 0, VIT: 0, PRE: 0, PER: 0, INT: 0, WIL: 0, CHA: 0, INS: 0, SPR: 0 });
  const withAttrs = (attributes: Record<AttributeCode, number>): CharacterDraft =>
    ({ ...exampleBuild('arcanist', C), attributes });

  it('requires the total to be exactly 15', () => {
    expect(C.attribute.creationPoints).toBe(15);
    const a = blank(); a.INT = 6; a.SPR = 6; a.WIL = 2;
    expect(validateDraft(withAttrs(a), C).map((e) => e.field)).toContain('attributes');
    a.WIL = 3;
    expect(validateDraft(withAttrs(a), C)).toEqual([]);
  });

  it('allows 0 and has no per-attribute cap at creation beyond the overall max 6', () => {
    expect(C.attribute.creationMax).toBeNull();
    const a = blank(); a.INT = 6; a.SPR = 5; a.WIL = 4;
    expect(validateDraft(withAttrs(a), C)).toEqual([]);
    a.INT = 7; a.WIL = 3;
    expect(validateDraft(withAttrs(a), C).map((e) => e.field)).toContain('attributes.INT');
  });

  it('rejects negative and non-integer values', () => {
    const a = blank(); a.INT = 6; a.SPR = 6; a.WIL = 4; a.STR = -1;
    expect(validateDraft(withAttrs(a), C).map((e) => e.field)).toContain('attributes.STR');
    const b = blank(); b.INT = 6; b.SPR = 6; b.WIL = 2.5; b.CHA = 0.5;
    expect(validateDraft(withAttrs(b), C).map((e) => e.field)).toContain('attributes.WIL');
  });

  it.each(examples.map((e) => [e.name, e.attributes] as const))('documented example %s sums to 15 and is legal', (_n, attrs) => {
    const a = attrs as Record<AttributeCode, number>;
    expect(attributeTotal({ attributes: a })).toBe(15);
    expect(validateDraft(withAttrs(a), C)).toEqual([]);
  });

  it.each(CLASSES.map((c) => c.id))('example build for %s sums to 15', (id) => {
    expect(attributeTotal(exampleBuild(id, C))).toBe(15);
  });

  it('keeps HP = 10 + 2 × VIT as the provisional formula', () => {
    const a = blank(); a.VIT = 4;
    expect(maxHp(a, C)).toBe(18);
  });
});

describe('skill 0 and minimum skill requirements', () => {
  it('lets an untrained character attempt ordinary actions', () => {
    expect(preCheck({ attribute: 2, skill: 0, tn: 16 }, C)).toBe('roll');
    const out = performCheck({ attribute: 2, skill: 0, tn: 16 }, scriptedRng([15]), C);
    expect(out.kind).toBe('rolled');
    expect(distribution({ attribute: 2, skill: 0, tn: 16 }, C).pSuccess).toBeCloseTo(0.35, 12);
  });

  it('blocks the action only when a rule sets a minimum skill', () => {
    expect(preCheck({ attribute: 6, skill: 0, tn: 12, minSkill: 1 }, C)).toBe('skill-required');
    expect(performCheck({ attribute: 6, skill: 0, tn: 12, minSkill: 1 }, scriptedRng([]), C).kind).toBe('skill-required');
    expect(preCheck({ attribute: 2, skill: 1, tn: 16, minSkill: 1 }, C)).toBe('roll');
  });
});
