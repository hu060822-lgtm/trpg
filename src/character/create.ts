import attributesData from '../../config/attributes.json';
import classesData from '../../config/classes.json';
import skillsData from '../../config/skills.json';
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
  provisional?: boolean;
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

/** Validates a new character against creation rules (plan v0.3 §2.3–2.4). */
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

  for (const a of ATTRIBUTES) {
    const v = draft.attributes[a.code];
    if (!Number.isInteger(v)) {
      errors.push({ field: `attributes.${a.code}`, message: `${a.name} 必須是整數` });
    } else if (v < A.min || v > A.creationMax) {
      errors.push({ field: `attributes.${a.code}`, message: `${a.name} 創角時必須介於 ${A.min}–${A.creationMax}` });
    }
  }
  const expectedAttr = A.creationBase * ATTRIBUTES.length + A.creationFreePoints;
  const attrSum = attributeTotal(draft);
  if (attrSum !== expectedAttr) {
    errors.push({ field: 'attributes', message: `屬性總和必須為 ${expectedAttr}（目前 ${attrSum}）` });
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

/** A legal starting build that maxes the class core: core attributes 3, core skills 4. */
export function exampleBuild(classId: string, config: RulesConfig): CharacterDraft {
  const cls = CLASSES.find((c) => c.id === classId);
  if (!cls) throw new Error(`unknown class ${classId}`);
  const attributes = Object.fromEntries(ATTRIBUTES.map((a) => [a.code, config.attribute.creationBase])) as Record<AttributeCode, number>;
  let free = config.attribute.creationFreePoints;
  const order = [...cls.coreAttributes, ...ATTRIBUTES.map((a) => a.code).filter((c) => !cls.coreAttributes.includes(c))];
  for (const code of order) {
    const add = Math.min(free, config.attribute.creationMax - attributes[code]);
    attributes[code] += add;
    free -= add;
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
