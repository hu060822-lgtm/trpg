import { evaluate, ExprError, parse, references, type Evaluation, type Scope } from './expr';
import type { Rng } from '../rules/dice';

/**
 * A rule pack: everything the table needs to know about one game system, as data. A pack is a zip of JSON files;
 * each file fills one part of `Pack`. The core never knows what "strength" or "armour class" mean: it reads the
 * names, limits and formulas from here.
 */
export interface PackManifest {
  id: string;
  name: string;
  version: string;
  license: string;
  author?: string;
  /** Shown wherever the pack's content appears, e.g. the notice a CC-BY licence requires. */
  attribution?: string;
  description?: string;
}
export interface PackAttribute { id: string; name: string; abbr?: string; min: number; max: number; default: number; description?: string }
export interface PackSkill { id: string; name: string; attribute: string; description?: string }
/** A number the player types: level, armour bonus, gold. */
export interface PackInput { id: string; label: string; min: number; max: number; default: number; description?: string }
/** A number the sheet works out, e.g. `{ id: 'hp', formula: '8 + 2 * @score.body' }`. */
export interface PackDerived { id: string; label: string; formula: string; description?: string }
/** A button on the sheet that rolls: an attack, a spell, a saving throw. */
export interface PackAction { id: string; label: string; roll: string; damage?: string; description?: string }
export interface PackChecks {
  /** `{d20}` becomes the plain, advantage or disadvantage die; `{attr}` and `{skill}` the ids checked. */
  attribute: string;
  skill: string;
  die: string;
  advantage?: string;
  disadvantage?: string;
  /** Natural results on the die that the log calls out. */
  critical?: number;
  fumble?: number;
  difficulties?: { label: string; value: number }[];
}
export interface PackCreation {
  attributes: { budget?: number; costs?: Record<string, number> };
  skills: { maxRank: number; budget?: number };
}
export interface PackEntry { id: string; title: string; text: string; tags?: string[] }
export interface Pack {
  manifest: PackManifest;
  attributes: PackAttribute[];
  /** Formula for an attribute's modifier; reads `@score`. */
  modifier: string;
  skills: PackSkill[];
  inputs: PackInput[];
  derived: PackDerived[];
  actions: PackAction[];
  checks: PackChecks;
  creation: PackCreation;
  /** Rules text players can search: conditions, terms, how a check works. */
  glossary: PackEntry[];
}

export interface PackProblem { file: string; path: string; message: string }
export class PackError extends Error {
  constructor(public problems: PackProblem[]) {
    super(problems.map((p) => `${p.file}${p.path ? ` ${p.path}` : ''}：${p.message}`).join('\n'));
  }
}

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const FILES = ['manifest', 'attributes', 'skills', 'sheet', 'actions', 'checks', 'creation', 'glossary'] as const;
export type PackFile = (typeof FILES)[number];

/**
 * Builds a pack from its files (already parsed JSON, keyed by file name without `.json`) and checks every rule:
 * ids, limits, that each formula parses and only reads values the sheet will have, and that derived values do not
 * depend on each other in a circle. All problems are collected, so an author fixes them in one pass.
 */
export function buildPack(files: Partial<Record<PackFile, unknown>>): Pack {
  const problems: PackProblem[] = [];
  const bad = (file: string, path: string, message: string) => { problems.push({ file: `${file}.json`, path, message }); };
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const arr = (v: unknown, file: string, path: string): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) { bad(file, path, '應該是陣列'); return []; }
    return v;
  };
  const str = (o: Record<string, unknown>, k: string, file: string, path: string, required = true, max = 200): string => {
    const v = o[k];
    if (v === undefined && !required) return '';
    if (typeof v !== 'string' || !v.trim()) { bad(file, `${path}.${k}`, '必填文字'); return ''; }
    if (v.length > max) bad(file, `${path}.${k}`, `太長（上限 ${max} 字）`);
    return v;
  };
  const num = (o: Record<string, unknown>, k: string, file: string, path: string, fallback?: number): number => {
    const v = o[k] ?? fallback;
    if (typeof v !== 'number' || !Number.isFinite(v)) { bad(file, `${path}.${k}`, '必填數字'); return 0; }
    return v;
  };
  const id = (o: Record<string, unknown>, file: string, path: string, seen: Set<string>): string => {
    const v = str(o, 'id', file, path);
    if (v && !ID.test(v)) bad(file, `${path}.id`, `「${v}」不能當 id：用小寫英文字母開頭，只含小寫英數字與底線，最多 32 字`);
    if (seen.has(v)) bad(file, `${path}.id`, `id「${v}」重複了`);
    seen.add(v);
    return v;
  };
  const opt = (o: Record<string, unknown>, k: string, file: string, path: string, max = 2000) => {
    const v = str(o, k, file, path, false, max);
    return v ? { [k]: v } : {};
  };
  for (const name of Object.keys(files)) if (!(FILES as readonly string[]).includes(name)) bad(name, '', `不認識的檔案（可用：${FILES.map((f) => `${f}.json`).join('、')}）`);

  const m = obj(files.manifest);
  if (!files.manifest) bad('manifest', '', '規則包一定要有 manifest.json');
  const manifest: PackManifest = {
    id: str(m, 'id', 'manifest', ''), name: str(m, 'name', 'manifest', '', true, 60), version: str(m, 'version', 'manifest', '', true, 20),
    license: str(m, 'license', 'manifest', '', true, 60),
    ...opt(m, 'author', 'manifest', ''), ...opt(m, 'attribution', 'manifest', ''), ...opt(m, 'description', 'manifest', ''),
  };
  if (manifest.id && !/^[a-z0-9][a-z0-9-]{1,47}$/.test(manifest.id)) bad('manifest', '.id', '只能用小寫英數字與連字號，2 到 48 字');
  if (manifest.version && !/^\d+\.\d+(\.\d+)?$/.test(manifest.version)) bad('manifest', '.version', '版本寫成 1.0 或 1.0.0');

  const a = obj(files.attributes);
  const attrIds = new Set<string>();
  const attributes = arr(a.list, 'attributes', '.list').map((raw, i): PackAttribute => {
    const o = obj(raw), p = `.list[${i}]`;
    const attr = {
      id: id(o, 'attributes', p, attrIds), name: str(o, 'name', 'attributes', p, true, 30),
      min: num(o, 'min', 'attributes', p), max: num(o, 'max', 'attributes', p), default: num(o, 'default', 'attributes', p, num(o, 'min', 'attributes', p)),
      ...opt(o, 'abbr', 'attributes', p, 8), ...opt(o, 'description', 'attributes', p),
    };
    if (attr.min > attr.max || attr.default < attr.min || attr.default > attr.max) bad('attributes', p, '要符合 min ≤ default ≤ max');
    return attr;
  });
  if (files.attributes && attributes.length === 0) bad('attributes', '.list', '至少要有一個屬性');
  const modifier = typeof a.modifier === 'string' ? a.modifier : '@score';

  const skillIds = new Set<string>();
  const skills = arr(obj(files.skills).list, 'skills', '.list').map((raw, i): PackSkill => {
    const o = obj(raw), p = `.list[${i}]`;
    const s = { id: id(o, 'skills', p, skillIds), name: str(o, 'name', 'skills', p, true, 30), attribute: str(o, 'attribute', 'skills', p), ...opt(o, 'description', 'skills', p) };
    if (s.attribute && !attrIds.has(s.attribute)) bad('skills', `${p}.attribute`, `沒有「${s.attribute}」這個屬性`);
    return s;
  });

  const sheet = obj(files.sheet);
  const sheetIds = new Set<string>();
  const inputs = arr(sheet.inputs, 'sheet', '.inputs').map((raw, i): PackInput => {
    const o = obj(raw), p = `.inputs[${i}]`;
    const v = { id: id(o, 'sheet', p, sheetIds), label: str(o, 'label', 'sheet', p, true, 30), min: num(o, 'min', 'sheet', p), max: num(o, 'max', 'sheet', p),
      default: num(o, 'default', 'sheet', p, num(o, 'min', 'sheet', p)), ...opt(o, 'description', 'sheet', p) };
    if (v.min > v.max || v.default < v.min || v.default > v.max) bad('sheet', p, '要符合 min ≤ default ≤ max');
    return v;
  });
  const derived = arr(sheet.derived, 'sheet', '.derived').map((raw, i): PackDerived => {
    const o = obj(raw), p = `.derived[${i}]`;
    return { id: id(o, 'sheet', p, sheetIds), label: str(o, 'label', 'sheet', p, true, 30), formula: str(o, 'formula', 'sheet', p, true, 500), ...opt(o, 'description', 'sheet', p) };
  });

  const actionIds = new Set<string>();
  const actions = arr(obj(files.actions).list, 'actions', '.list').map((raw, i): PackAction => {
    const o = obj(raw), p = `.list[${i}]`;
    return { id: id(o, 'actions', p, actionIds), label: str(o, 'label', 'actions', p, true, 40), roll: str(o, 'roll', 'actions', p, true, 500),
      ...opt(o, 'damage', 'actions', p, 500), ...opt(o, 'description', 'actions', p) };
  });

  const c = obj(files.checks);
  if (!files.checks) bad('checks', '', '規則包一定要有 checks.json');
  const checks: PackChecks = {
    attribute: str(c, 'attribute', 'checks', '', true, 500), skill: skills.length ? str(c, 'skill', 'checks', '', true, 500) : String(c.skill ?? ''),
    die: str(c, 'die', 'checks', '', true, 40),
    ...opt(c, 'advantage', 'checks', '', 40), ...opt(c, 'disadvantage', 'checks', '', 40),
    ...(c.critical !== undefined ? { critical: num(c, 'critical', 'checks', '') } : {}),
    ...(c.fumble !== undefined ? { fumble: num(c, 'fumble', 'checks', '') } : {}),
    ...(c.difficulties !== undefined ? {
      difficulties: arr(c.difficulties, 'checks', '.difficulties').map((raw, i) => {
        const o = obj(raw);
        return { label: str(o, 'label', 'checks', `.difficulties[${i}]`, true, 20), value: num(o, 'value', 'checks', `.difficulties[${i}]`) };
      }),
    } : {}),
  };

  const cr = obj(files.creation), ca = obj(cr.attributes), cs = obj(cr.skills);
  const creation: PackCreation = {
    attributes: {
      ...(ca.budget !== undefined ? { budget: num(ca, 'budget', 'creation', '.attributes') } : {}),
      ...(ca.costs !== undefined ? { costs: Object.fromEntries(Object.entries(obj(ca.costs)).map(([k, v]) => [k, typeof v === 'number' ? v : (bad('creation', `.attributes.costs.${k}`, '應該是數字'), 0)])) } : {}),
    },
    skills: { maxRank: num(cs, 'maxRank', 'creation', '.skills', skills.length ? undefined : 0), ...(cs.budget !== undefined ? { budget: num(cs, 'budget', 'creation', '.skills') } : {}) },
  };
  if (creation.attributes.costs && creation.attributes.budget === undefined) bad('creation', '.attributes', '有 costs 時要寫 budget');

  const entryIds = new Set<string>();
  const glossary = arr(obj(files.glossary).list, 'glossary', '.list').map((raw, i): PackEntry => {
    const o = obj(raw), p = `.list[${i}]`;
    const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string').slice(0, 10) : undefined;
    return { id: id(o, 'glossary', p, entryIds), title: str(o, 'title', 'glossary', p, true, 60), text: str(o, 'text', 'glossary', p, true, 4000), ...(tags ? { tags } : {}) };
  });

  const pack: Pack = { manifest, attributes, modifier, skills, inputs, derived, actions, checks, creation, glossary };
  if (problems.length === 0) checkFormulas(pack, bad);
  if (problems.length) throw new PackError(problems);
  return pack;
}

/** Every value a sheet formula may read: the names a pack author writes after `@`. */
function scopeNames(pack: Pack): Set<string> {
  return new Set([
    ...pack.attributes.flatMap((a) => [`score.${a.id}`, `mod.${a.id}`]),
    ...pack.skills.map((s) => `rank.${s.id}`),
    ...pack.inputs.map((i) => i.id),
    ...pack.derived.map((d) => d.id),
  ]);
}

function checkFormulas(pack: Pack, bad: (file: string, path: string, message: string) => void) {
  const names = scopeNames(pack);
  const check = (file: string, path: string, src: string, extra: string[] = []) => {
    try {
      for (const r of references(src)) if (!names.has(r) && !extra.includes(r)) bad(file, path, `「@${r}」不存在（可用：${[...names].slice(0, 12).map((n) => `@${n}`).join('、')}…）`);
    } catch (e) {
      bad(file, path, e instanceof ExprError ? `公式錯誤：${e.message}` : String(e));
    }
  };
  check('attributes', '.modifier', pack.modifier.replace(/@score\b/g, '0'));
  pack.derived.forEach((d, i) => check('sheet', `.derived[${i}].formula`, d.formula));
  pack.actions.forEach((a, i) => {
    check('actions', `.list[${i}].roll`, a.roll, ['target']);
    if (a.damage) check('actions', `.list[${i}].damage`, a.damage);
  });
  const sampleAttr = pack.attributes[0]?.id ?? 'x', sampleSkill = pack.skills[0];
  check('checks', '.die', pack.checks.die);
  if (pack.checks.advantage) check('checks', '.advantage', pack.checks.advantage);
  if (pack.checks.disadvantage) check('checks', '.disadvantage', pack.checks.disadvantage);
  check('checks', '.attribute', fill(pack.checks.attribute, pack.checks.die, sampleAttr));
  if (sampleSkill) check('checks', '.skill', fill(pack.checks.skill, pack.checks.die, sampleSkill.attribute, sampleSkill.id));
  // Derived values may read each other, but never in a circle.
  const deps = new Map(pack.derived.map((d) => [d.id, safeRefs(d.formula).filter((r) => pack.derived.some((x) => x.id === r))]));
  const state = new Map<string, 1 | 2>();
  const visit = (n: string, trail: string[]) => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) { bad('sheet', '.derived', `計算繞成一圈：${[...trail, n].join(' → ')}`); return; }
    state.set(n, 1);
    for (const d of deps.get(n) ?? []) visit(d, [...trail, n]);
    state.set(n, 2);
  };
  for (const d of pack.derived) visit(d.id, []);
}

function safeRefs(src: string) {
  try { return references(src); } catch { return []; }
}

function fill(template: string, die: string, attr: string, skill = '') {
  return template.replaceAll('{d20}', `(${die})`).replaceAll('{attr}', attr).replaceAll('{skill}', skill);
}

/** What a player has chosen for one character; everything else on the sheet is worked out from it. */
export interface CharacterData { scores: Record<string, number>; ranks: Record<string, number>; inputs: Record<string, number> }

export interface SheetValue { value: number; text: string }

/** The words a player sees for a value a formula reads: `score.body` → 體魄. */
export function labeller(pack: Pack): (path: string) => string | undefined {
  const names = new Map<string, string>();
  for (const a of pack.attributes) { names.set(`score.${a.id}`, a.name); names.set(`mod.${a.id}`, `${a.name}調整值`); }
  for (const s of pack.skills) names.set(`rank.${s.id}`, s.name);
  for (const i of pack.inputs) names.set(i.id, i.label);
  for (const d of pack.derived) names.set(d.id, d.label);
  names.set('target', '目標');
  return (p) => names.get(p);
}
export interface Sheet { values: Map<string, number>; shown: Record<string, SheetValue> }

/** Works out every number on a character sheet, with the sum behind each one (dice shown as their average). */
export function computeSheet(pack: Pack, data: CharacterData): Sheet {
  const values = new Map<string, number>();
  const shown: Record<string, SheetValue> = {};
  const label = labeller(pack);
  for (const a of pack.attributes) {
    const score = data.scores[a.id] ?? a.default;
    values.set(`score.${a.id}`, score);
    const mod = evaluate(pack.modifier, (p) => (p === 'score' ? score : undefined));
    values.set(`mod.${a.id}`, mod.total);
    shown[`mod.${a.id}`] = { value: mod.total, text: mod.text };
  }
  for (const s of pack.skills) values.set(`rank.${s.id}`, data.ranks[s.id] ?? 0);
  for (const i of pack.inputs) values.set(i.id, data.inputs[i.id] ?? i.default);
  const pending = new Map(pack.derived.map((d) => [d.id, d]));
  const scope: Scope = (p) => {
    if (values.has(p)) return values.get(p);
    const d = pending.get(p);
    if (!d) return undefined;
    pending.delete(p);
    const r = evaluate(d.formula, scope, undefined, label);
    values.set(d.id, r.total);
    shown[d.id] = { value: r.total, text: r.text };
    return r.total;
  };
  for (const d of pack.derived) scope(d.id);
  return { values, shown };
}

export type CheckMode = 'normal' | 'advantage' | 'disadvantage';

/** The concrete formula for an attribute or skill check, e.g. `(1d20) + @mod.dex + @rank.stealth`. */
export function checkFormula(pack: Pack, target: { attribute: string } | { skill: string }, mode: CheckMode = 'normal'): string {
  const die = mode === 'advantage' && pack.checks.advantage ? pack.checks.advantage
    : mode === 'disadvantage' && pack.checks.disadvantage ? pack.checks.disadvantage : pack.checks.die;
  if ('skill' in target) {
    const s = pack.skills.find((x) => x.id === target.skill);
    if (!s) throw new ExprError(`沒有「${target.skill}」這個技能`);
    return fill(pack.checks.skill, die, s.attribute, s.id);
  }
  if (!pack.attributes.some((a) => a.id === target.attribute)) throw new ExprError(`沒有「${target.attribute}」這個屬性`);
  return fill(pack.checks.attribute, die, target.attribute);
}

/** Rolls a formula against a character sheet. `extra` adds values such as `target.ac` for one roll. */
export function rollOnSheet(pack: Pack, sheet: Sheet, formula: string, rng: Rng, extra: Record<string, number> = {}): Evaluation {
  return evaluate(parse(formula), (p) => (Object.hasOwn(extra, p) ? extra[p] : sheet.values.get(p)), rng, labeller(pack));
}

/** The natural result of the check die (the first die group), when the pack calls out criticals or fumbles. */
export function natural(pack: Pack, r: Evaluation): 'critical' | 'fumble' | null {
  const first = r.dice[0];
  if (!first) return null;
  const kept = first.rolls.filter((_, i) => first.kept[i]);
  if (kept.length !== 1) return null;
  if (pack.checks.critical !== undefined && kept[0] === pack.checks.critical) return 'critical';
  if (pack.checks.fumble !== undefined && kept[0] === pack.checks.fumble) return 'fumble';
  return null;
}

/** Checks a player's choices against the pack's limits and creation budget. Returns problems in plain words. */
export function validateCharacter(pack: Pack, data: CharacterData, atCreation: boolean): string[] {
  const out: string[] = [];
  const known = (o: Record<string, unknown>, ids: Set<string>, what: string) => {
    for (const k of Object.keys(o)) if (!ids.has(k)) out.push(`沒有「${k}」這個${what}`);
  };
  known(data.scores, new Set(pack.attributes.map((a) => a.id)), '屬性');
  known(data.ranks, new Set(pack.skills.map((s) => s.id)), '技能');
  known(data.inputs, new Set(pack.inputs.map((i) => i.id)), '欄位');
  for (const a of pack.attributes) {
    const v = data.scores[a.id] ?? a.default;
    if (!Number.isInteger(v) || v < a.min || v > a.max) out.push(`${a.name}要在 ${a.min} 到 ${a.max} 之間`);
  }
  for (const i of pack.inputs) {
    const v = data.inputs[i.id] ?? i.default;
    if (!Number.isFinite(v) || v < i.min || v > i.max) out.push(`${i.label}要在 ${i.min} 到 ${i.max} 之間`);
  }
  for (const s of pack.skills) {
    const v = data.ranks[s.id] ?? 0;
    if (!Number.isInteger(v) || v < 0 || (atCreation && v > pack.creation.skills.maxRank)) out.push(`${s.name}的等級要在 0 到 ${pack.creation.skills.maxRank} 之間`);
  }
  if (atCreation) {
    const { budget, costs } = pack.creation.attributes;
    if (budget !== undefined) {
      let spent = 0;
      for (const a of pack.attributes) {
        const v = data.scores[a.id] ?? a.default;
        if (costs) {
          if (!Object.hasOwn(costs, String(v))) out.push(`${a.name} ${v} 不能用點數購買`);
          else spent += costs[String(v)];
        } else spent += v;
      }
      if (spent > budget) out.push(`屬性點數用了 ${spent}，上限 ${budget}`);
    }
    const sb = pack.creation.skills.budget;
    if (sb !== undefined) {
      const spent = pack.skills.reduce((s, x) => s + (data.ranks[x.id] ?? 0), 0);
      if (spent > sb) out.push(`技能點數用了 ${spent}，上限 ${sb}`);
    }
  }
  return out;
}
