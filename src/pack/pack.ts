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
  /** An add-on names the pack it adds to (`id@version`); importing it makes a new pack of both together. */
  extends?: string;
  /** Set on a pack made from an add-on: the pack it was laid over. */
  basedOn?: string;
}
export interface PackAttribute { id: string; name: string; abbr?: string; min: number; max: number; default: number; description?: string }
export interface PackSkill { id: string; name: string; attribute: string; description?: string }
/** A number the player types: level, armour bonus, gold. */
export interface PackInput { id: string; label: string; min: number; max: number; default: number; description?: string }
/** A number the sheet works out, e.g. `{ id: 'hp', formula: '8 + 2 * @score.body' }`. Hidden while `showIf` is 0. */
export interface PackDerived { id: string; label: string; formula: string; description?: string; showIf?: string }
/** A number a builder choice sets, e.g. a class's hit die. Read in formulas as `@id`. */
export interface PackValue { id: string; label: string; default: number; description?: string }
/** A yes/no a builder choice turns on, e.g. proficiency in Strength saves. Read in formulas as `@flag.id` (1 or 0). */
export interface PackFlag { id: string; label: string; description?: string }
/** A button on the sheet that rolls: an attack, a spell, a saving throw. Hidden while `showIf` is 0. */
export interface PackAction { id: string; label: string; roll: string; damage?: string; description?: string; showIf?: string }
/** A family of checks made once per attribute, such as saving throws: `{d20} + @mod.{attr} + @flag.save_{attr} * @prof`. */
export interface PackExtraCheck { id: string; label: string; formula: string }
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
  extra?: PackExtraCheck[];
}
/** Ways to set starting attribute scores. Scores bought here are before any bonus a builder choice gives. */
export type PackMethod =
  | { id: string; label: string; kind: 'pointbuy'; budget: number; costs: Record<string, number> }
  | { id: string; label: string; kind: 'array'; values: number[] }
  | { id: string; label: string; kind: 'free' };
export interface PackCreation {
  attributes: { budget?: number; costs?: Record<string, number>; methods?: PackMethod[] };
  skills: { maxRank: number; budget?: number };
}

/** A class feature or species trait: shown on the sheet from `level` on. */
export interface PackFeature { level: number; name: string; text: string }
/** What picking a builder option gives the character. */
export interface PackGrant {
  bonuses?: Record<string, number>;
  /** Skills raised to at least this rank (1 = proficient, 2 = expertise in 5E). */
  ranks?: Record<string, number>;
  flags?: Record<string, number>;
  values?: Record<string, number>;
  features?: PackFeature[];
}
/**
 * A choice inside an option, e.g. "pick 2 skills from this class's list".
 * - skills: choose `count` skills from `from` (or any skill); each becomes rank 1.
 * - expertise: choose `count` skills the character is already proficient in; each becomes rank 2.
 * - bonus: spread bonuses over the attributes in `from`, following one of `patterns` (e.g. [2, 1] or [1, 1, 1]).
 * - pick: choose `count` of `options` (a fighting style, a cantrip); their text goes on the sheet.
 */
export interface PackChoice {
  id: string;
  label: string;
  kind: 'skills' | 'expertise' | 'bonus' | 'pick';
  count?: number;
  from?: string[];
  patterns?: number[][];
  options?: { id: string; name: string; text: string }[];
  description?: string;
}
export interface PackOption { id: string; name: string; description?: string; grants?: PackGrant; choices?: PackChoice[]; tags?: string[] }
/** One page of the character builder: species, class, background… The player picks one option. */
export interface PackStep { id: string; label: string; description?: string; options: PackOption[] }
export interface PackEntry { id: string; title: string; text: string; tags?: string[] }
export interface Pack {
  manifest: PackManifest;
  attributes: PackAttribute[];
  /** Formula for an attribute's modifier; reads `@score`. */
  modifier: string;
  skills: PackSkill[];
  inputs: PackInput[];
  derived: PackDerived[];
  values: PackValue[];
  flags: PackFlag[];
  actions: PackAction[];
  checks: PackChecks;
  creation: PackCreation;
  /** The character builder's steps, in order. Packs without it get a single page of attributes and skills. */
  builder: PackStep[];
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
const FILES = ['manifest', 'attributes', 'skills', 'sheet', 'actions', 'checks', 'creation', 'builder', 'glossary'] as const;
export type PackFile = (typeof FILES)[number];
export type PackFiles = Partial<Record<PackFile, unknown>>;

/**
 * Builds a pack from its files (already parsed JSON, keyed by file name without `.json`) and checks every rule:
 * ids, limits, that each formula parses and only reads values the sheet will have, and that derived values do not
 * depend on each other in a circle. All problems are collected, so an author fixes them in one pass.
 */
export function buildPack(files: PackFiles): Pack {
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
  const numbers = (v: unknown, file: string, path: string): Record<string, number> => Object.fromEntries(Object.entries(obj(v)).map(([k, n]) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) bad(file, `${path}.${k}`, '應該是數字');
    return [k, Number(n) || 0];
  }));
  for (const name of Object.keys(files)) if (!(FILES as readonly string[]).includes(name)) bad(name, '', `不認識的檔案（可用：${FILES.map((f) => `${f}.json`).join('、')}）`);

  const m = obj(files.manifest);
  if (!files.manifest) bad('manifest', '', '規則包一定要有 manifest.json');
  const manifest: PackManifest = {
    id: str(m, 'id', 'manifest', ''), name: str(m, 'name', 'manifest', '', true, 60), version: str(m, 'version', 'manifest', '', true, 20),
    license: str(m, 'license', 'manifest', '', true, 60),
    ...opt(m, 'author', 'manifest', ''), ...opt(m, 'attribution', 'manifest', ''), ...opt(m, 'description', 'manifest', ''),
    ...opt(m, 'basedOn', 'manifest', '', 80),
  };
  if (manifest.id && !/^[a-z0-9][a-z0-9-]{1,47}$/.test(manifest.id)) bad('manifest', '.id', '只能用小寫英數字與連字號，2 到 48 字');
  if (manifest.version && !/^\d+\.\d+(\.\d+)?$/.test(manifest.version)) bad('manifest', '.version', '版本寫成 1.0 或 1.0.0');
  if (m.extends !== undefined) bad('manifest', '.extends', '擴充包要透過匯入疊到原規則包上，不能單獨建立');

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
  const values = arr(sheet.values, 'sheet', '.values').map((raw, i): PackValue => {
    const o = obj(raw), p = `.values[${i}]`;
    return { id: id(o, 'sheet', p, sheetIds), label: str(o, 'label', 'sheet', p, true, 30), default: num(o, 'default', 'sheet', p, 0), ...opt(o, 'description', 'sheet', p) };
  });
  const flagIds = new Set<string>();
  const flags = arr(sheet.flags, 'sheet', '.flags').map((raw, i): PackFlag => {
    const o = obj(raw), p = `.flags[${i}]`;
    return { id: id(o, 'sheet', p, flagIds), label: str(o, 'label', 'sheet', p, true, 30), ...opt(o, 'description', 'sheet', p) };
  });
  const derived = arr(sheet.derived, 'sheet', '.derived').map((raw, i): PackDerived => {
    const o = obj(raw), p = `.derived[${i}]`;
    return { id: id(o, 'sheet', p, sheetIds), label: str(o, 'label', 'sheet', p, true, 30), formula: str(o, 'formula', 'sheet', p, true, 500),
      ...opt(o, 'description', 'sheet', p), ...opt(o, 'showIf', 'sheet', p, 500) };
  });

  const actionIds = new Set<string>();
  const actions = arr(obj(files.actions).list, 'actions', '.list').map((raw, i): PackAction => {
    const o = obj(raw), p = `.list[${i}]`;
    return { id: id(o, 'actions', p, actionIds), label: str(o, 'label', 'actions', p, true, 40), roll: str(o, 'roll', 'actions', p, true, 500),
      ...opt(o, 'damage', 'actions', p, 500), ...opt(o, 'description', 'actions', p), ...opt(o, 'showIf', 'actions', p, 500) };
  });

  const c = obj(files.checks);
  if (!files.checks) bad('checks', '', '規則包一定要有 checks.json');
  const extraIds = new Set<string>();
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
    ...(c.extra !== undefined ? {
      extra: arr(c.extra, 'checks', '.extra').map((raw, i) => {
        const o = obj(raw), p = `.extra[${i}]`;
        return { id: id(o, 'checks', p, extraIds), label: str(o, 'label', 'checks', p, true, 20), formula: str(o, 'formula', 'checks', p, true, 500) };
      }),
    } : {}),
  };

  const cr = obj(files.creation), ca = obj(cr.attributes), cs = obj(cr.skills);
  const methodIds = new Set<string>();
  const creation: PackCreation = {
    attributes: {
      ...(ca.budget !== undefined ? { budget: num(ca, 'budget', 'creation', '.attributes') } : {}),
      ...(ca.costs !== undefined ? { costs: numbers(ca.costs, 'creation', '.attributes.costs') } : {}),
      ...(ca.methods !== undefined ? {
        methods: arr(ca.methods, 'creation', '.attributes.methods').map((raw, i): PackMethod => {
          const o = obj(raw), p = `.attributes.methods[${i}]`;
          const base = { id: id(o, 'creation', p, methodIds), label: str(o, 'label', 'creation', p, true, 30) };
          if (o.kind === 'pointbuy') return { ...base, kind: 'pointbuy', budget: num(o, 'budget', 'creation', p), costs: numbers(o.costs, 'creation', `${p}.costs`) };
          if (o.kind === 'array') {
            const vals = arr(o.values, 'creation', `${p}.values`).map(Number);
            if (vals.length !== attributes.length || vals.some((v) => !Number.isFinite(v))) bad('creation', `${p}.values`, `要剛好 ${attributes.length} 個數字，一個屬性一個`);
            return { ...base, kind: 'array', values: vals };
          }
          if (o.kind !== 'free') bad('creation', `${p}.kind`, 'kind 只能是 pointbuy、array 或 free');
          return { ...base, kind: 'free' };
        }),
      } : {}),
    },
    skills: { maxRank: num(cs, 'maxRank', 'creation', '.skills', skills.length ? undefined : 0), ...(cs.budget !== undefined ? { budget: num(cs, 'budget', 'creation', '.skills') } : {}) },
  };
  if (creation.attributes.costs && creation.attributes.budget === undefined) bad('creation', '.attributes', '有 costs 時要寫 budget');

  // ---------- builder ----------
  const valueIds = new Set(values.map((v) => v.id));
  const grantOf = (raw: unknown, p: string): PackGrant => {
    const g = obj(raw);
    const out: PackGrant = {};
    const keyed = (k: 'bonuses' | 'ranks' | 'flags' | 'values', ids: Set<string>, what: string) => {
      if (g[k] === undefined) return;
      const v = numbers(g[k], 'builder', `${p}.${k}`);
      for (const key of Object.keys(v)) if (!ids.has(key)) bad('builder', `${p}.${k}.${key}`, `沒有「${key}」這個${what}`);
      out[k] = v;
    };
    keyed('bonuses', attrIds, '屬性');
    keyed('ranks', skillIds, '技能');
    keyed('flags', flagIds, '旗標（在 sheet.json 的 flags 宣告）');
    keyed('values', valueIds, '數值（在 sheet.json 的 values 宣告）');
    if (g.features !== undefined) {
      out.features = arr(g.features, 'builder', `${p}.features`).map((f, i) => {
        const o = obj(f), fp = `${p}.features[${i}]`;
        return { level: num(o, 'level', 'builder', fp, 1), name: str(o, 'name', 'builder', fp, true, 60), text: str(o, 'text', 'builder', fp, true, 4000) };
      });
    }
    return out;
  };
  const choiceOf = (raw: unknown, p: string, seen: Set<string>): PackChoice => {
    const o = obj(raw);
    const kind = o.kind as PackChoice['kind'];
    if (!['skills', 'expertise', 'bonus', 'pick'].includes(kind)) bad('builder', `${p}.kind`, 'kind 只能是 skills、expertise、bonus 或 pick');
    const ch: PackChoice = { id: id(o, 'builder', p, seen), label: str(o, 'label', 'builder', p, true, 40), kind, ...opt(o, 'description', 'builder', p) };
    if (o.count !== undefined) ch.count = num(o, 'count', 'builder', p);
    if (o.from !== undefined) {
      ch.from = arr(o.from, 'builder', `${p}.from`).map(String);
      const ids = kind === 'bonus' ? attrIds : skillIds;
      for (const f of ch.from) if (!ids.has(f)) bad('builder', `${p}.from`, `沒有「${f}」這個${kind === 'bonus' ? '屬性' : '技能'}`);
    }
    if (kind === 'bonus') {
      ch.patterns = arr(o.patterns, 'builder', `${p}.patterns`).map((x) => (Array.isArray(x) ? x.map(Number) : []));
      if (!ch.patterns.length || ch.patterns.some((x) => !x.length || x.some((n) => !Number.isFinite(n)) || x.length > (ch.from?.length ?? attributes.length))) {
        bad('builder', `${p}.patterns`, '要寫至少一種分法，例如 [[2, 1], [1, 1, 1]]，而且不能比 from 的屬性多');
      }
    }
    if (kind === 'pick') {
      const ids = new Set<string>();
      ch.options = arr(o.options, 'builder', `${p}.options`).map((x, i) => {
        const q = obj(x), qp = `${p}.options[${i}]`;
        return { id: id(q, 'builder', qp, ids), name: str(q, 'name', 'builder', qp, true, 60), text: str(q, 'text', 'builder', qp, true, 4000) };
      });
      if (!ch.options.length) bad('builder', `${p}.options`, 'pick 至少要有一個選項');
    }
    if ((kind === 'skills' || kind === 'expertise' || kind === 'pick') && (!Number.isInteger(ch.count) || ch.count! < 1)) bad('builder', `${p}.count`, '要選幾個？寫一個正整數');
    return ch;
  };
  const stepIds = new Set<string>();
  const builder = arr(obj(files.builder).steps, 'builder', '.steps').map((raw, i): PackStep => {
    const o = obj(raw), p = `.steps[${i}]`;
    const optionIds = new Set<string>();
    const step: PackStep = {
      id: id(o, 'builder', p, stepIds), label: str(o, 'label', 'builder', p, true, 30), ...opt(o, 'description', 'builder', p),
      options: arr(o.options, 'builder', `${p}.options`).map((x, j): PackOption => {
        const q = obj(x), qp = `${p}.options[${j}]`;
        const choiceIds = new Set<string>();
        const tags = Array.isArray(q.tags) ? q.tags.filter((t): t is string => typeof t === 'string').slice(0, 10) : undefined;
        return {
          id: id(q, 'builder', qp, optionIds), name: str(q, 'name', 'builder', qp, true, 40), ...opt(q, 'description', 'builder', qp, 4000),
          ...(q.grants !== undefined ? { grants: grantOf(q.grants, `${qp}.grants`) } : {}),
          ...(q.choices !== undefined ? { choices: arr(q.choices, 'builder', `${qp}.choices`).map((ch, k) => choiceOf(ch, `${qp}.choices[${k}]`, choiceIds)) } : {}),
          ...(tags ? { tags } : {}),
        };
      }),
    };
    if (!step.options.length) bad('builder', `${p}.options`, '每一步至少要有一個選項');
    return step;
  });

  const entryIds = new Set<string>();
  const glossary = arr(obj(files.glossary).list, 'glossary', '.list').map((raw, i): PackEntry => {
    const o = obj(raw), p = `.list[${i}]`;
    const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string').slice(0, 10) : undefined;
    return { id: id(o, 'glossary', p, entryIds), title: str(o, 'title', 'glossary', p, true, 60), text: str(o, 'text', 'glossary', p, true, 4000), ...(tags ? { tags } : {}) };
  });

  const pack: Pack = { manifest, attributes, modifier, skills, inputs, derived, values, flags, actions, checks, creation, builder, glossary };
  if (problems.length === 0) checkFormulas(pack, bad);
  if (problems.length) throw new PackError(problems);
  return pack;
}

/**
 * Lays an add-on over the files of the pack it extends. Lists of things with ids merge by id (an add-on can add a
 * class, or add options to an existing builder step); anything else in the add-on replaces what was there.
 */
export function mergePackFiles(base: PackFiles, addon: PackFiles, baseKey: string): PackFiles {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const byId = (v: unknown): v is { id: string }[] => Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === 'string');
  const merge = (a: unknown, b: unknown): unknown => {
    if (byId(a) && byId(b)) {
      const out = a.map((x) => ({ ...x }));
      for (const item of b) {
        const i = out.findIndex((x) => x.id === item.id);
        if (i >= 0) out[i] = merge(out[i], item) as { id: string };
        else out.push(item);
      }
      return out;
    }
    if (isObj(a) && isObj(b)) {
      const out: Record<string, unknown> = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = k in a ? merge(a[k], v) : v;
      return out;
    }
    return b;
  };
  const out: PackFiles = { ...base };
  for (const [name, content] of Object.entries(addon) as [PackFile, unknown][]) {
    if (name === 'manifest') continue;
    out[name] = name in base ? merge(base[name], content) : content;
  }
  const bm = (isObj(base.manifest) ? base.manifest : {}) as Record<string, unknown>;
  const am = (isObj(addon.manifest) ? addon.manifest : {}) as Record<string, unknown>;
  const { extends: _, ...rest } = am;
  out.manifest = {
    ...rest,
    basedOn: baseKey,
    attribution: [bm.attribution, am.attribution].filter((x) => typeof x === 'string' && x).join('\n') || undefined,
  };
  return out;
}

/** Every value a sheet formula may read: the names a pack author writes after `@`. */
function scopeNames(pack: Pack): Set<string> {
  return new Set([
    ...pack.attributes.flatMap((a) => [`score.${a.id}`, `mod.${a.id}`]),
    ...pack.skills.map((s) => `rank.${s.id}`),
    ...pack.inputs.map((i) => i.id),
    ...pack.values.map((v) => v.id),
    ...pack.flags.map((f) => `flag.${f.id}`),
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
  pack.derived.forEach((d, i) => {
    check('sheet', `.derived[${i}].formula`, d.formula);
    if (d.showIf) check('sheet', `.derived[${i}].showIf`, d.showIf);
  });
  pack.actions.forEach((a, i) => {
    check('actions', `.list[${i}].roll`, a.roll);
    if (a.damage) check('actions', `.list[${i}].damage`, a.damage);
    if (a.showIf) check('actions', `.list[${i}].showIf`, a.showIf);
  });
  const sampleAttr = pack.attributes[0]?.id ?? 'x', sampleSkill = pack.skills[0];
  check('checks', '.die', pack.checks.die);
  if (pack.checks.advantage) check('checks', '.advantage', pack.checks.advantage);
  if (pack.checks.disadvantage) check('checks', '.disadvantage', pack.checks.disadvantage);
  check('checks', '.attribute', fill(pack.checks.attribute, pack.checks.die, sampleAttr));
  if (sampleSkill) check('checks', '.skill', fill(pack.checks.skill, pack.checks.die, sampleSkill.attribute, sampleSkill.id));
  // An extra check is made for every attribute, so every attribute must give a formula that reads real values.
  pack.checks.extra?.forEach((x, i) => { for (const at of pack.attributes) check('checks', `.extra[${i}].formula`, fill(x.formula, pack.checks.die, at.id)); });
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

/**
 * What a player has chosen for one character; everything else on the sheet is worked out from it.
 * `scores` are the scores before builder bonuses. `choices` maps a builder step to the option picked, and `picks`
 * maps `step.choice` to what was picked inside that option: skill ids, pick ids, or bonuses by attribute.
 */
export interface CharacterData {
  scores: Record<string, number>;
  ranks: Record<string, number>;
  inputs: Record<string, number>;
  method?: string;
  choices?: Record<string, string>;
  picks?: Record<string, string[] | Record<string, number>>;
}

export interface SheetValue { value: number; text: string; hidden?: boolean }

/** The words a player sees for a value a formula reads: `score.body` → 體魄. */
export function labeller(pack: Pack): (path: string) => string | undefined {
  const names = new Map<string, string>();
  for (const a of pack.attributes) { names.set(`score.${a.id}`, a.name); names.set(`mod.${a.id}`, `${a.name}調整值`); }
  for (const s of pack.skills) names.set(`rank.${s.id}`, s.name);
  for (const i of pack.inputs) names.set(i.id, i.label);
  for (const v of pack.values) names.set(v.id, v.label);
  for (const f of pack.flags) names.set(`flag.${f.id}`, f.label);
  for (const d of pack.derived) names.set(d.id, d.label);
  return (p) => names.get(p);
}

/** Everything a character's builder choices add up to. */
export interface Granted {
  bonuses: Record<string, number>;
  ranks: Record<string, number>;
  flags: Record<string, number>;
  values: Record<string, number>;
  features: (PackFeature & { from: string })[];
}

export function granted(pack: Pack, data: CharacterData): Granted {
  const g: Granted = { bonuses: {}, ranks: {}, flags: {}, values: {}, features: [] };
  const atLeast = (to: Record<string, number>, k: string, v: number) => { to[k] = Math.max(to[k] ?? 0, v); };
  const expertise: string[] = [];
  for (const step of pack.builder) {
    const option = step.options.find((o) => o.id === data.choices?.[step.id]);
    if (!option) continue;
    const gr = option.grants ?? {};
    for (const [k, v] of Object.entries(gr.bonuses ?? {})) g.bonuses[k] = (g.bonuses[k] ?? 0) + v;
    for (const [k, v] of Object.entries(gr.ranks ?? {})) atLeast(g.ranks, k, v);
    for (const [k, v] of Object.entries(gr.flags ?? {})) atLeast(g.flags, k, v);
    Object.assign(g.values, gr.values ?? {});
    for (const f of gr.features ?? []) g.features.push({ ...f, from: option.name });
    for (const ch of option.choices ?? []) {
      const picked = data.picks?.[`${step.id}.${ch.id}`];
      if (ch.kind === 'bonus' && picked && !Array.isArray(picked)) {
        for (const [k, v] of Object.entries(picked)) g.bonuses[k] = (g.bonuses[k] ?? 0) + v;
      } else if (Array.isArray(picked)) {
        if (ch.kind === 'skills') for (const s of picked) atLeast(g.ranks, s, 1);
        if (ch.kind === 'expertise') expertise.push(...picked);
        if (ch.kind === 'pick') for (const id of picked) {
          const o = ch.options?.find((x) => x.id === id);
          if (o) g.features.push({ level: 1, name: `${ch.label}：${o.name}`, text: o.text, from: option.name });
        }
      }
    }
  }
  for (const s of expertise) atLeast(g.ranks, s, 2);
  return g;
}

export interface Sheet { values: Map<string, number>; shown: Record<string, SheetValue>; features: Granted['features']; hiddenActions: string[] }

/** Works out every number on a character sheet, with the sum behind each one (dice shown as their average). */
export function computeSheet(pack: Pack, data: CharacterData): Sheet {
  const values = new Map<string, number>();
  const shown: Record<string, SheetValue> = {};
  const label = labeller(pack);
  const g = granted(pack, data);
  for (const a of pack.attributes) {
    const base = data.scores[a.id] ?? a.default;
    const score = Math.min(a.max, base + (g.bonuses[a.id] ?? 0));
    values.set(`score.${a.id}`, score);
    if (g.bonuses[a.id]) shown[`score.${a.id}`] = { value: score, text: `${base} + ${g.bonuses[a.id]}${score < base + g.bonuses[a.id] ? `（上限 ${a.max}）` : ''}` };
    const mod = evaluate(pack.modifier, (p) => (p === 'score' ? score : undefined));
    values.set(`mod.${a.id}`, mod.total);
    shown[`mod.${a.id}`] = { value: mod.total, text: mod.text };
  }
  for (const s of pack.skills) values.set(`rank.${s.id}`, Math.max(data.ranks[s.id] ?? 0, g.ranks[s.id] ?? 0));
  for (const i of pack.inputs) values.set(i.id, data.inputs[i.id] ?? i.default);
  for (const v of pack.values) values.set(v.id, g.values[v.id] ?? v.default);
  for (const f of pack.flags) values.set(`flag.${f.id}`, g.flags[f.id] ?? 0);
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
  for (const d of pack.derived) if (d.showIf && !evaluate(d.showIf, scope).total) shown[d.id] = { ...shown[d.id], hidden: true };
  const hiddenActions = pack.actions.filter((a) => a.showIf && !evaluate(a.showIf, scope).total).map((a) => a.id);
  const level = values.get('level') ?? Infinity;
  return { values, shown, features: g.features.filter((f) => f.level <= level), hiddenActions };
}

export type CheckMode = 'normal' | 'advantage' | 'disadvantage';
export type CheckTarget = { attribute: string; extra?: string } | { skill: string };

/** The concrete formula for an attribute, skill or extra (saving throw) check, e.g. `(1d20) + @mod.dex + @rank.stealth`. */
export function checkFormula(pack: Pack, target: CheckTarget, mode: CheckMode = 'normal'): string {
  const die = mode === 'advantage' && pack.checks.advantage ? pack.checks.advantage
    : mode === 'disadvantage' && pack.checks.disadvantage ? pack.checks.disadvantage : pack.checks.die;
  if ('skill' in target) {
    const s = pack.skills.find((x) => x.id === target.skill);
    if (!s) throw new ExprError(`沒有「${target.skill}」這個技能`);
    return fill(pack.checks.skill, die, s.attribute, s.id);
  }
  if (!pack.attributes.some((a) => a.id === target.attribute)) throw new ExprError(`沒有「${target.attribute}」這個屬性`);
  if (target.extra) {
    const x = pack.checks.extra?.find((e) => e.id === target.extra);
    if (!x) throw new ExprError(`沒有「${target.extra}」這種檢定`);
    return fill(x.formula, die, target.attribute);
  }
  return fill(pack.checks.attribute, die, target.attribute);
}

/** What a check adds to the die, e.g. +5 for a proficient Stealth check: the number a sheet prints next to it. */
export function checkBonus(pack: Pack, sheet: Sheet, target: CheckTarget): number {
  const f = checkFormula(pack, target).replaceAll(`(${pack.checks.die})`, '(0)');
  return evaluate(parse(f), (p) => sheet.values.get(p)).total;
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

/** The ways this pack offers to set starting scores; older packs with a single budget get one point-buy method. */
export function methodsOf(pack: Pack): PackMethod[] {
  const { methods, budget, costs } = pack.creation.attributes;
  if (methods?.length) return methods;
  if (budget !== undefined) return [costs ? { id: 'pointbuy', label: '購點', kind: 'pointbuy', budget, costs } : { id: 'sum', label: '分配點數', kind: 'pointbuy', budget, costs: {} }];
  return [{ id: 'free', label: '自由設定', kind: 'free' }];
}

/** Points a point-buy method has spent on these base scores. An empty cost table means each point costs one. */
export function pointsSpent(pack: Pack, method: Extract<PackMethod, { kind: 'pointbuy' }>, scores: Record<string, number>): number {
  const flat = Object.keys(method.costs).length === 0;
  return pack.attributes.reduce((s, a) => {
    const v = scores[a.id] ?? a.default;
    return s + (flat ? v : method.costs[String(v)] ?? 0);
  }, 0);
}

/** Checks a player's choices against the pack's limits, builder rules and creation budget. Returns problems in plain words. */
export function validateCharacter(pack: Pack, data: CharacterData, atCreation: boolean): string[] {
  const out: string[] = [];
  const known = (o: Record<string, unknown>, ids: Set<string>, what: string) => {
    for (const k of Object.keys(o)) if (!ids.has(k)) out.push(`沒有「${k}」這個${what}`);
  };
  known(data.scores, new Set(pack.attributes.map((a) => a.id)), '屬性');
  known(data.ranks, new Set(pack.skills.map((s) => s.id)), '技能');
  known(data.inputs, new Set(pack.inputs.map((i) => i.id)), '欄位');
  const g = granted(pack, data);
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

  // Builder: one option per step, and every choice inside it made in full.
  const skillName = (id: string) => pack.skills.find((s) => s.id === id)?.name ?? id;
  const attrName = (id: string) => pack.attributes.find((a) => a.id === id)?.name ?? id;
  known(data.choices ?? {}, new Set(pack.builder.map((s) => s.id)), '建立步驟');
  const expected = new Set<string>();
  for (const step of pack.builder) {
    const picked = data.choices?.[step.id];
    const option = step.options.find((o) => o.id === picked);
    if (!option) {
      if (picked !== undefined) out.push(`${step.label}沒有「${picked}」這個選項`);
      else if (atCreation) out.push(`還沒選${step.label}`);
      continue;
    }
    for (const ch of option.choices ?? []) {
      const key = `${step.id}.${ch.id}`;
      expected.add(key);
      const p = data.picks?.[key];
      const where = `${option.name}的「${ch.label}」`;
      if (p === undefined) { if (atCreation) out.push(`還沒選${where}`); continue; }
      if (ch.kind === 'bonus') {
        if (Array.isArray(p)) { out.push(`${where}格式錯誤`); continue; }
        const from = ch.from ?? pack.attributes.map((a) => a.id);
        const bad = Object.keys(p).filter((k) => !from.includes(k));
        if (bad.length) { out.push(`${where}只能加在${from.map(attrName).join('、')}`); continue; }
        const given = Object.values(p).filter((v) => v !== 0).sort((x, y) => y - x).join(',');
        if (!ch.patterns!.some((pat) => [...pat].sort((x, y) => y - x).join(',') === given)) {
          out.push(`${where}要照這幾種分法之一：${ch.patterns!.map((pat) => pat.map((n) => `+${n}`).join('／')).join('，或 ')}`);
        }
        continue;
      }
      if (!Array.isArray(p)) { out.push(`${where}格式錯誤`); continue; }
      if (new Set(p).size !== p.length) out.push(`${where}選了重複的項目`);
      if (p.length !== ch.count) out.push(`${where}要選 ${ch.count} 個（現在 ${p.length} 個）`);
      if (ch.kind === 'pick') {
        for (const x of p) if (!ch.options?.some((o) => o.id === x)) out.push(`${where}沒有「${x}」這個選項`);
      } else {
        const pool = ch.from ?? pack.skills.map((s) => s.id);
        for (const s of p) if (!pool.includes(s)) out.push(`${where}不能選${skillName(s)}`);
        if (ch.kind === 'expertise') {
          // Expertise only deepens a proficiency the character already has from somewhere else.
          const without = granted(pack, { ...data, picks: { ...data.picks, [key]: [] } });
          for (const s of p) if (Math.max(data.ranks[s] ?? 0, without.ranks[s] ?? 0) < 1) out.push(`${where}只能選已經熟練的技能，${skillName(s)}還不熟練`);
        }
      }
    }
  }
  // Two sources giving the same skill would waste a pick; 5E lets the player choose another, so ask them to.
  for (const step of pack.builder) {
    const option = step.options.find((o) => o.id === data.choices?.[step.id]);
    for (const ch of option?.choices ?? []) {
      const p = data.picks?.[`${step.id}.${ch.id}`];
      if (ch.kind !== 'skills' || !Array.isArray(p)) continue;
      // Expertise is left out: it deepens these very skills rather than giving them a second time.
      const without: Record<string, string[]> = { [`${step.id}.${ch.id}`]: [] };
      for (const st of pack.builder) for (const c of st.options.find((o) => o.id === data.choices?.[st.id])?.choices ?? []) if (c.kind === 'expertise') without[`${st.id}.${c.id}`] = [];
      const others = granted(pack, { ...data, picks: { ...data.picks, ...without } });
      for (const s of p) if ((others.ranks[s] ?? 0) >= 1) out.push(`${skillName(s)}已經從別的地方熟練了，${option!.name}的「${ch.label}」請改選別的技能`);
    }
  }
  known(data.picks ?? {}, expected, '選擇');
  for (const a of pack.attributes) {
    const total = (data.scores[a.id] ?? a.default) + (g.bonuses[a.id] ?? 0);
    if (total > a.max) out.push(`${a.name}加上加值後是 ${total}，上限 ${a.max}`);
  }

  if (atCreation) {
    const methods = methodsOf(pack);
    const method = methods.find((x) => x.id === data.method) ?? (methods.length === 1 ? methods[0] : undefined);
    if (!method) out.push(`請選擇屬性的決定方式（${methods.map((x) => x.label).join('、')}）`);
    else if (method.kind === 'pointbuy') {
      const flat = Object.keys(method.costs).length === 0;
      for (const a of pack.attributes) {
        const v = data.scores[a.id] ?? a.default;
        if (!flat && !Object.hasOwn(method.costs, String(v))) out.push(`${a.name} ${v} 不能用點數購買`);
      }
      const spent = pointsSpent(pack, method, data.scores);
      if (spent > method.budget) out.push(`屬性點數用了 ${spent}，上限 ${method.budget}`);
    } else if (method.kind === 'array') {
      const have = pack.attributes.map((a) => data.scores[a.id] ?? a.default).sort((x, y) => x - y).join(',');
      if (have !== [...method.values].sort((x, y) => x - y).join(',')) out.push(`${method.label}要把 ${method.values.join('、')} 各用一次`);
    }
    const sb = pack.creation.skills.budget;
    if (sb !== undefined) {
      const spent = pack.skills.reduce((s, x) => s + (data.ranks[x.id] ?? 0), 0);
      if (spent > sb) out.push(`技能點數用了 ${spent}，上限 ${sb}`);
    }
  }
  return out;
}
