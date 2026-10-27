import { describe, expect, it } from 'vitest';
import { CLASSES, createCharacter, exampleBuild, validateDraft } from '../src/character/create';
import { RULES_V03 } from '../src/rules/config';

const C = RULES_V03;

describe('character creation', () => {
  it.each(CLASSES.map((c) => c.id))('example build for %s is legal', (id) => {
    expect(validateDraft(exampleBuild(id, C), C)).toEqual([]);
  });

  it('creates a character with a stable id and HP = 10 + 2×VIT', () => {
    const ch = createCharacter(exampleBuild('guardian', C), C, new Date('2026-10-27T00:00:00Z'), 'fixed-id');
    expect(ch.id).toBe('fixed-id');
    expect(ch.attributes.VIT).toBe(3);
    expect(ch.maxHp).toBe(16);
  });

  it('rejects attribute totals other than 15', () => {
    const d = exampleBuild('scout', C);
    d.attributes.CHA -= 1;
    expect(validateDraft(d, C).map((e) => e.field)).toContain('attributes');
  });

  it('rejects an attribute above the overall max of 6', () => {
    const d = exampleBuild('scout', C);
    d.attributes.AGI = 7;
    d.attributes.STR = 0;
    d.attributes.VIT = 0;
    d.attributes.PRE = 0;
    d.attributes.INT = 0;
    expect(validateDraft(d, C).map((e) => e.field)).toContain('attributes.AGI');
  });

  it('rejects a skill above the creation max and unspent skill points', () => {
    const d = exampleBuild('ranger', C);
    d.skills.ranged = C.skill.creationMax + 2;
    const fields = validateDraft(d, C).map((e) => e.field);
    expect(fields).toContain('skills.ranged');
    expect(fields).toContain('skills');
  });

  it('requires at least 4 points in class core skills', () => {
    const d = exampleBuild('medic', C);
    const moved = d.skills.medicine + d.skills.firstAid;
    delete d.skills.medicine;
    delete d.skills.firstAid;
    d.skills.history = 3;
    d.skills.nature = moved - 3;
    expect(validateDraft(d, C).some((e) => e.message.includes('核心技能'))).toBe(true);
  });

  it('createCharacter throws with all validation errors', () => {
    const d = exampleBuild('duelist', C);
    d.name = ' ';
    expect(() => createCharacter(d, C)).toThrow(/名稱/);
  });
});
