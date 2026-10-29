import { DEFAULT_RULES } from '../encounter/rules';
import type {
  AreaShape, CombatRules, CombatSpell, CombatWeapon, Emitter, EncounterTemplate, Interaction, Monster, MonsterAttack, PackCombat, PatternDef, Tier, TierRow,
} from '../encounter/types';

/**
 * Reads a pack's combat.json: weapons, spells, a bestiary, bullet patterns and ready-made encounters, plus the
 * numbers interactive combat runs on (the Model B tiers, damage factors and gesture bonuses). Everything is data;
 * nothing in it runs as code. Problems are reported the same way as the rest of the pack.
 */
type Bad = (file: string, path: string, message: string) => void;

const ID = /^[a-z][a-z0-9_-]{0,47}$/;
const INTERACTIONS: Interaction[] = ['slash', 'thrust', 'sweep', 'draw', 'rune', 'none'];
const TIERS: Tier[] = ['minion', 'elite', 'boss'];
const EMITTERS: Emitter['kind'][] = ['fan', 'ring', 'aimed', 'rain', 'laser', 'spiral', 'wall'];
const SIDES = ['top', 'bottom', 'left', 'right', 'center'];
const AREAS: AreaShape['kind'][] = ['cone', 'sphere', 'line', 'cube'];

export const COMBAT_LIMITS = { weapons: 200, spells: 300, monsters: 500, attacks: 12, patterns: 200, emitters: 24, encounters: 100, entries: 40 };

export function buildCombat(raw: unknown, attrIds: Set<string>, bad: Bad): PackCombat {
  const f = 'combat';
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const list = (v: unknown, path: string, max: number): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) { bad(f, path, '應該是陣列'); return []; }
    if (v.length > max) bad(f, path, `最多 ${max} 項`);
    return v.slice(0, max);
  };
  const text = (o: Record<string, unknown>, k: string, path: string, max = 60, required = true): string => {
    const v = o[k];
    if (v === undefined && !required) return '';
    if (typeof v !== 'string' || !v.trim()) { bad(f, `${path}.${k}`, '必填文字'); return ''; }
    if (v.length > max) bad(f, `${path}.${k}`, `太長（上限 ${max} 字）`);
    return v;
  };
  const num = (o: Record<string, unknown>, k: string, path: string, lo: number, hi: number, fallback?: number): number => {
    const v = o[k] ?? fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) { bad(f, `${path}.${k}`, `要是 ${lo} 到 ${hi} 的數字`); return Math.max(lo, Math.min(hi, Number(v) || lo)); }
    return v;
  };
  const ids = new Map<string, Set<string>>();
  const id = (o: Record<string, unknown>, path: string, group: string) => {
    const v = text(o, 'id', path, 48);
    if (v && !ID.test(v)) bad(f, `${path}.id`, `「${v}」不能當 id：小寫英文字母開頭，只含小寫英數字、底線與連字號`);
    const seen = ids.get(group) ?? new Set<string>();
    if (seen.has(v)) bad(f, `${path}.id`, `id「${v}」重複了`);
    seen.add(v);
    ids.set(group, seen);
    return v;
  };
  const oneOf = <T extends string>(o: Record<string, unknown>, k: string, path: string, allowed: readonly T[], fallback?: T): T => {
    const v = (o[k] ?? fallback) as T;
    if (!allowed.includes(v)) { bad(f, `${path}.${k}`, `只能是 ${allowed.join('、')}`); return allowed[0]; }
    return v;
  };
  const range = (v: unknown, path: string): [number, number] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length !== 2 || v.some((n) => typeof n !== 'number' || n <= 0 || n > 10000) || v[0] > v[1]) {
      bad(f, path, '要寫成 [一般射程, 最遠射程]，單位呎');
      return undefined;
    }
    return [v[0], v[1]];
  };
  const area = (v: unknown, path: string): AreaShape | undefined => {
    if (v === undefined) return undefined;
    const o = obj(v);
    return { kind: oneOf(o, 'kind', path, AREAS), size: num(o, 'size', path, 5, 500), ...(o.width !== undefined ? { width: num(o, 'width', path, 5, 100) } : {}) };
  };

  const r = obj(obj(raw).rules);
  const rules: CombatRules = {
    distance: oneOf(r, 'distance', '.rules', ['chebyshev', 'alternate'] as const, DEFAULT_RULES.distance),
    tiers: r.tiers === undefined ? DEFAULT_RULES.tiers : list(r.tiers, '.rules.tiers', 10).map((t, i): TierRow => {
      const o = obj(t), p = `.rules.tiers[${i}]`;
      return {
        id: id(o, p, 'tier'), label: text(o, 'label', p, 12), min: num(o, 'min', p, -999, 999), duration: num(o, 'duration', p, 1000, 15000),
        density: num(o, 'density', p, 0.2, 3), speed: num(o, 'speed', p, 0.7, 1.5), arena: num(o, 'arena', p, 0.6, 1.2),
      };
    }),
    factors: r.factors === undefined ? DEFAULT_RULES.factors : list(r.factors, '.rules.factors', 10).map((x, i) => num({ x }, 'x', `.rules.factors[${i}]`, 0, 3)),
    bonus: r.bonus === undefined ? DEFAULT_RULES.bonus : list(r.bonus, '.rules.bonus', 6).map((x, i): [number, number] => {
      if (!Array.isArray(x) || x.length !== 2) { bad(f, `.rules.bonus[${i}]`, '要寫成 [品質下限, 加值]'); return [1, 0]; }
      return [num({ q: x[0] }, 'q', `.rules.bonus[${i}][0]`, 0, 1), num({ b: x[1] }, 'b', `.rules.bonus[${i}][1]`, -5, 5)];
    }),
    shortDodgeMs: num(r, 'shortDodgeMs', '.rules', 1000, 10000, DEFAULT_RULES.shortDodgeMs),
  };
  if (rules.tiers.length === 0) bad(f, '.rules.tiers', '至少要有一級');
  for (let i = 1; i < rules.tiers.length; i++) if (rules.tiers[i].min >= rules.tiers[i - 1].min) bad(f, `.rules.tiers[${i}].min`, '分級要由好到壞排，min 一級比一級小');
  if (rules.factors.length === 0) bad(f, '.rules.factors', '至少要有一個倍率');
  rules.bonus.sort((a, b) => b[0] - a[0]);

  const c = obj(raw);
  const weapons = list(c.weapons, '.weapons', COMBAT_LIMITS.weapons).map((x, i): CombatWeapon => {
    const o = obj(x), p = `.weapons[${i}]`;
    const w: CombatWeapon = {
      id: id(o, p, 'weapon'), label: text(o, 'label', p, 30), ability: oneOf(o, 'ability', p, ['str', 'dex', 'finesse'] as const),
      damage: text(o, 'damage', p, 100), damageType: text(o, 'damageType', p, 20), interaction: oneOf(o, 'interaction', p, INTERACTIONS, 'slash'),
    };
    if (o.reach !== undefined) w.reach = num(o, 'reach', p, 5, 60);
    const rg = range(o.range, `${p}.range`);
    if (rg) w.range = rg;
    return w;
  });

  const spells = list(c.spells, '.spells', COMBAT_LIMITS.spells).map((x, i): CombatSpell => {
    const o = obj(x), p = `.spells[${i}]`;
    const s: CombatSpell = {
      id: id(o, p, 'spell'), label: text(o, 'label', p, 30), level: num(o, 'level', p, 0, 9, 0),
      damage: text(o, 'damage', p, 300), damageType: text(o, 'damageType', p, 20), range: num(o, 'range', p, 0, 10000),
    };
    if (o.attack) s.attack = true;
    if (o.save !== undefined) {
      s.save = text(o, 'save', p, 32);
      if (!attrIds.has(s.save)) bad(f, `${p}.save`, `沒有「${s.save}」這個屬性`);
      if (o.halfOnSave) s.halfOnSave = true;
    }
    if (!s.attack && !s.save) bad(f, p, '法術要寫 attack: true（攻擊擲骰）或 save（豁免屬性）');
    const a = area(o.area, `${p}.area`);
    if (a) s.area = a;
    const d = text(o, 'description', p, 400, false);
    if (d) s.description = d;
    return s;
  });

  const patterns = list(c.patterns, '.patterns', COMBAT_LIMITS.patterns).map((x, i): PatternDef => {
    const o = obj(x), p = `.patterns[${i}]`;
    return { id: id(o, p, 'pattern'), name: text(o, 'name', p, 30), emitters: emittersOf(o.emitters, p, bad, list) };
  });
  const patternIds = new Set(patterns.map((p) => p.id));
  const knownPattern = (pid: unknown, path: string) => {
    if (typeof pid !== 'string' || !patternIds.has(pid)) bad(f, path, `沒有「${String(pid)}」這個彈幕`);
    return String(pid);
  };

  const monsters = list(c.monsters, '.monsters', COMBAT_LIMITS.monsters).map((x, i): Monster => {
    const o = obj(x), p = `.monsters[${i}]`;
    const attackIds = new Set<string>();
    const attacks = list(o.attacks, `${p}.attacks`, COMBAT_LIMITS.attacks).map((y, j) => attackOf(obj(y), `${p}.attacks[${j}]`, attackIds));
    if (attacks.length === 0) bad(f, `${p}.attacks`, '至少要有一種攻擊');
    const m: Monster = {
      id: id(o, p, 'monster'), name: text(o, 'name', p, 30), size: num(o, 'size', p, 1, 6, 1), ac: num(o, 'ac', p, 0, 40), hp: num(o, 'hp', p, 1, 9999),
      speed: num(o, 'speed', p, 0, 300, 30), dex: num(o, 'dex', p, -10, 20, 0), tier: oneOf(o, 'tier', p, TIERS, 'minion'), attacks,
    };
    if (o.multiattack !== undefined) m.multiattack = num(o, 'multiattack', p, 1, 8);
    if (o.saves !== undefined) {
      m.saves = {};
      for (const [k, v] of Object.entries(obj(o.saves))) {
        if (!attrIds.has(k)) bad(f, `${p}.saves.${k}`, `沒有「${k}」這個屬性`);
        m.saves[k] = num({ v }, 'v', `${p}.saves.${k}`, -10, 30);
      }
    }
    if (o.patterns !== undefined) m.patterns = list(o.patterns, `${p}.patterns`, 10).map((pid, j) => knownPattern(pid, `${p}.patterns[${j}]`));
    if (o.phases !== undefined) {
      m.phases = list(o.phases, `${p}.phases`, 5).map((y, j) => {
        const q = obj(y), qp = `${p}.phases[${j}]`;
        const say = text(q, 'say', qp, 200, false);
        return { below: num(q, 'below', qp, 1, 99), patterns: list(q.patterns, `${qp}.patterns`, 10).map((pid, k) => knownPattern(pid, `${qp}.patterns[${k}]`)), ...(say ? { say } : {}) };
      });
      m.phases.sort((a, b) => b.below - a.below);
    }
    return m;
  });
  const monsterIds = new Set(monsters.map((m) => m.id));

  const encounters = list(c.encounters, '.encounters', COMBAT_LIMITS.encounters).map((x, i): EncounterTemplate => {
    const o = obj(x), p = `.encounters[${i}]`;
    return {
      id: id(o, p, 'encounter'), name: text(o, 'name', p, 40),
      entries: list(o.entries, `${p}.entries`, COMBAT_LIMITS.entries).map((y, j) => {
        const q = obj(y), qp = `${p}.entries[${j}]`;
        const monsterId = text(q, 'monsterId', qp, 48);
        if (!monsterIds.has(monsterId)) bad(f, `${qp}.monsterId`, `沒有「${monsterId}」這種怪物`);
        return {
          monsterId, dx: num(q, 'dx', qp, -50, 50, 0), dy: num(q, 'dy', qp, -50, 50, 0),
          ...(q.name !== undefined ? { name: text(q, 'name', qp, 24) } : {}), ...(q.hidden ? { hidden: true } : {}),
          ...(q.tier !== undefined ? { tier: oneOf(q, 'tier', qp, TIERS) } : {}),
        };
      }),
    };
  });

  return { rules, weapons, spells, monsters, patterns, encounters };

  function attackOf(o: Record<string, unknown>, p: string, seen: Set<string>): MonsterAttack {
    const v = text(o, 'id', p, 48);
    if (seen.has(v)) bad(f, `${p}.id`, `id「${v}」重複了`);
    seen.add(v);
    const a: MonsterAttack = { id: v, label: text(o, 'label', p, 30), damage: text(o, 'damage', p, 100), damageType: text(o, 'damageType', p, 20) };
    if (o.bonus !== undefined) a.bonus = num(o, 'bonus', p, -10, 30);
    if (o.save !== undefined) {
      const s = obj(o.save);
      const attr = text(s, 'attr', `${p}.save`, 32);
      if (!attrIds.has(attr)) bad(f, `${p}.save.attr`, `沒有「${attr}」這個屬性`);
      a.save = { attr, dc: num(s, 'dc', `${p}.save`, 1, 40), half: !!s.half };
    }
    if (a.bonus === undefined && !a.save) bad(f, p, '攻擊要寫 bonus（攻擊加值）或 save（豁免）');
    if (o.reach !== undefined) a.reach = num(o, 'reach', p, 5, 60);
    const rg = range(o.range, `${p}.range`);
    if (rg) a.range = rg;
    const ar = area(o.area, `${p}.area`);
    if (ar) a.area = ar;
    if (o.pattern !== undefined) a.pattern = knownPattern(o.pattern, `${p}.pattern`);
    return a;
  }
}

/** Checks a list of emitters; used for pack patterns and for patterns a GM builds in the editor. */
export function emittersOf(raw: unknown, p: string, bad: Bad, list?: (v: unknown, path: string, max: number) => unknown[]): Emitter[] {
  const f = 'combat';
  const items = list ? list(raw, `${p}.emitters`, COMBAT_LIMITS.emitters) : Array.isArray(raw) ? raw.slice(0, COMBAT_LIMITS.emitters) : [];
  if (!list && !Array.isArray(raw)) bad(f, `${p}.emitters`, '應該是陣列');
  if (items.length === 0) bad(f, `${p}.emitters`, '至少要有一個發射器');
  return items.map((x, i) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>, q = `${p}.emitters[${i}]`;
    const n = (k: string, lo: number, hi: number, fallback?: number) => {
      const v = o[k] ?? fallback;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) { bad(f, `${q}.${k}`, `要是 ${lo} 到 ${hi} 的數字`); return lo; }
      return v;
    };
    const kind = o.kind as Emitter['kind'];
    if (!EMITTERS.includes(kind)) bad(f, `${q}.kind`, `只能是 ${EMITTERS.join('、')}`);
    const e: Emitter = { at: n('at', 0, 15000, 0), kind: EMITTERS.includes(kind) ? kind : 'aimed', count: n('count', 1, 40, 1), speed: n('speed', 0, 900, 250) };
    if (o.side !== undefined) {
      if (!SIDES.includes(o.side as string)) bad(f, `${q}.side`, `只能是 ${SIDES.join('、')}`);
      else e.side = o.side as Emitter['side'];
    }
    if (o.spread !== undefined) e.spread = n('spread', 0, 256);
    if (o.repeat !== undefined) e.repeat = n('repeat', 0, 40);
    if (o.every !== undefined) e.every = n('every', 100, 10000);
    if (o.size !== undefined) e.size = n('size', 3, 40);
    if (o.gap !== undefined) e.gap = n('gap', 10, 600);
    return e;
  });
}
