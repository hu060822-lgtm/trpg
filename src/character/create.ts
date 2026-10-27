import attributesData from '../../config/attributes.json';
import classesData from '../../config/classes.json';
import skillsData from '../../config/skills.json';
import { assertActive } from '../rules/config';
import type { AttributeCode, RulesConfig } from '../rules/types';

export interface ClassDef {
  id: string;
  name: string;
  role: string;
  coreAttributes: AttributeCode[];
  coreSkills: string[];
  feature: string;
}

export interface SkillDef {
  id: string;
  name: string;
  category: string;
}

export const ATTRIBUTES = attributesData as { code: AttributeCode; name: string }[];
export const CLASSES = classesData as ClassDef[];
export const SKILLS = skillsData as SkillDef[];

export interface CharacterDraft {
  name: string;
  classId: string;
  attributes: Record<AttributeCode, number>;
  /** Skill id -> level; missing skills are 0. */
  skills: Record<string, number>;
}

export interface Character extends CharacterDraft {
  id: string;
  rulesVersion: string;
  maxHp: number;
  hp: number;
  createdAt: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export function attributeTotal(draft: Pick<CharacterDraft, 'attributes'>): number {
  return ATTRIBUTES.reduce((s, a) => s + (draft.attributes[a.code] ?? 0), 0);
}

export function skillTotal(draft: Pick<CharacterDraft, 'skills'>): number {
  return Object.values(draft.skills).reduce((s, v) => s + v, 0);
}

export function skillTierName(level: number, config: RulesConfig): string {
  const tier = config.skill.tiers.find((t) => level >= t.min && level <= t.max);
  if (!tier) throw new RangeError(`skill level ${level} outside ${config.skill.min}–${config.skill.max}`);
  return tier.name;
}

/** Highest value one attribute may take at creation. */
export function attributeCreationMax(config: RulesConfig): number {
  return config.attribute.creationMax ?? config.attribute.max;
}

/** Validates a new character against creation rules (rules spec v0.3 §3). */
export function validateDraft(
  draft: CharacterDraft,
  config: RulesConfig,
  classes: ClassDef[] = CLASSES,
  skills: SkillDef[] = SKILLS,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const { attribute: A, skill: S } = config;

  if (!draft.name.trim()) errors.push({ field: 'name', message: '角色名稱不可空白' });

  const cls = classes.find((c) => c.id === draft.classId);
  if (!cls) errors.push({ field: 'classId', message: `未知職業：${draft.classId}` });

  const attrMax = attributeCreationMax(config);
  for (const a of ATTRIBUTES) {
    const v = draft.attributes[a.code];
    if (!Number.isInteger(v)) {
      errors.push({ field: `attributes.${a.code}`, message: `${a.name} 必須是整數` });
    } else if (v < A.min || v > attrMax) {
      errors.push({ field: `attributes.${a.code}`, message: `${a.name} 創角時必須介於 ${A.min}–${attrMax}` });
    }
  }
  const attrSum = attributeTotal(draft);
  if (attrSum !== A.creationPoints) {
    errors.push({ field: 'attributes', message: `屬性總和必須恰好為 ${A.creationPoints}（目前 ${attrSum}）` });
  }

  const known = new Set(skills.map((s) => s.id));
  for (const [id, v] of Object.entries(draft.skills)) {
    if (!known.has(id)) errors.push({ field: `skills.${id}`, message: `未知技能：${id}` });
    else if (!Number.isInteger(v) || v < S.min || v > S.creationMax) {
      errors.push({ field: `skills.${id}`, message: `技能創角時必須介於 ${S.min}–${S.creationMax}` });
    }
  }
  const skillSum = skillTotal(draft);
  if (skillSum !== S.creationPoints) {
    errors.push({ field: 'skills', message: `技能點數必須用完 ${S.creationPoints} 點（目前 ${skillSum}）` });
  }
  if (cls) {
    const core = cls.coreSkills.reduce((s, id) => s + (draft.skills[id] ?? 0), 0);
    if (core < S.creationCoreMin) {
      errors.push({ field: 'skills', message: `職業核心技能至少需要 ${S.creationCoreMin} 點（目前 ${core}）` });
    }
  }
  return errors;
}

export function maxHp(attributes: Record<AttributeCode, number>, config: RulesConfig): number {
  return config.hp.base + config.hp.perVit * attributes.VIT;
}

export function createCharacter(
  draft: CharacterDraft,
  config: RulesConfig,
  now: Date = new Date(),
  id: string = crypto.randomUUID(),
): Character {
  assertActive(config);
  const errors = validateDraft(draft, config);
  if (errors.length) {
    const err = new Error(errors.map((e) => e.message).join('；'));
    (err as Error & { errors: ValidationError[] }).errors = errors;
    throw err;
  }
  const hp = maxHp(draft.attributes, config);
  return {
    ...draft,
    skills: Object.fromEntries(Object.entries(draft.skills).filter(([, v]) => v > 0)),
    id, rulesVersion: config.version, maxHp: hp, hp, createdAt: now.toISOString(),
  };
}

/**
 * A legal, rounded starting build: core attributes 3, every other attribute at least 1,
 * core skills at the creation max. Example only; it is not the strongest legal build.
 */
export function exampleBuild(classId: string, config: RulesConfig): CharacterDraft {
  const cls = CLASSES.find((c) => c.id === classId);
  if (!cls) throw new Error(`unknown class ${classId}`);
  const codes = ATTRIBUTES.map((a) => a.code);
  const others = codes.filter((c) => !cls.coreAttributes.includes(c));
  const attributes = Object.fromEntries(codes.map((c) => [c, 0])) as Record<AttributeCode, number>;
  let free = config.attribute.creationPoints;
  const give = (code: AttributeCode, target: number) => {
    const add = Math.max(0, Math.min(free, target - attributes[code], attributeCreationMax(config) - attributes[code]));
    attributes[code] += add;
    free -= add;
  };
  for (const c of cls.coreAttributes) give(c, 3);
  for (const c of others) give(c, 1);
  for (let target = 2; free > 0 && target <= config.attribute.max; target++) {
    for (const c of others) give(c, target);
  }
  const skills: Record<string, number> = {};
  let pts = config.skill.creationPoints;
  const skillOrder = [...cls.coreSkills, ...SKILLS.map((s) => s.id).filter((id) => !cls.coreSkills.includes(id))];
  for (const id of skillOrder) {
    if (pts <= 0) break;
    const add = Math.min(pts, config.skill.creationMax);
    skills[id] = add;
    pts -= add;
  }
  return { name: `${cls.name}範例`, classId, attributes, skills };
}
