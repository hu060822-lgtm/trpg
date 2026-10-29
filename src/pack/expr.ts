import type { Rng } from '../rules/dice';

/**
 * The formula and dice language rule packs are written in. It is deliberately small so a pack from a stranger is
 * safe to load: numbers, + - * /, comparisons, a few functions, references to sheet values (`@mod.DEX`) and dice
 * (`2d6+3`, `4d6kh3`, `2d20kl1`, `roll(@level, 6)`). No loops, no strings, no access to anything but the values
 * passed in. The server and the browser run this same code; real rolls are only ever made on the server.
 *
 *   expr    := compare
 *   compare := sum (('<' | '<=' | '>' | '>=' | '==' | '!=') sum)?
 *   sum     := product (('+' | '-') product)*
 *   product := unary (('*' | '/') unary)*
 *   unary   := '-' unary | atom
 *   atom    := number | dice | ref | name '(' expr (',' expr)* ')' | '(' expr ')'
 *   dice    := [count] 'd' (sides | '%') [('kh' | 'kl') n]
 */
export class ExprError extends Error {
  constructor(message: string, public at = -1) {
    super(message);
  }
}

export type Node =
  | { k: 'num'; v: number }
  | { k: 'dice'; count: number; sides: number; keep?: { high: boolean; n: number }; text: string }
  | { k: 'ref'; path: string }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

export const LIMITS = { length: 500, nodes: 400, dice: 100, sides: 1000, depth: 40 };
const FUNCTIONS: Record<string, number | [number, number]> = { floor: 1, ceil: 1, round: 1, abs: 1, min: [1, 20], max: [1, 20], if: 3, roll: 2 };

type Tok = { t: 'num' | 'dice' | 'ref' | 'name' | 'op'; v: string; at: number };

function tokenize(src: string): Tok[] {
  if (src.length > LIMITS.length) throw new ExprError(`公式太長（上限 ${LIMITS.length} 字）`);
  const out: Tok[] = [];
  const re = /\s*(?:(\d*d(?:\d+|%)(?:k[hl]\d+)?)(?![\w.])|(\d+(?:\.\d+)?)|(@[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)|([A-Za-z_]\w*)|(<=|>=|==|!=|[-+*/(),<>]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s+$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new ExprError(`看不懂「${src.slice(i).trim().slice(0, 12)}」`, i);
    const at = m.index + m[0].length - (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]).length;
    if (m[1]) out.push({ t: 'dice', v: m[1], at });
    else if (m[2]) out.push({ t: 'num', v: m[2], at });
    else if (m[3]) out.push({ t: 'ref', v: m[3].slice(1), at });
    else if (m[4]) out.push({ t: 'name', v: m[4], at });
    else out.push({ t: 'op', v: m[5], at });
    i = re.lastIndex;
  }
  return out;
}

export function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0, nodes = 0;
  const peek = () => toks[p];
  const isOp = (...ops: string[]) => peek()?.t === 'op' && ops.includes(peek().v);
  const node = <T extends Node>(n: T): T => {
    if (++nodes > LIMITS.nodes) throw new ExprError('公式太複雜');
    return n;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(peek() ? `這裡應該是「${v}」` : `公式不完整，缺少「${v}」`, peek()?.at ?? src.length);
    p++;
  };
  const expr = (depth: number): Node => {
    if (depth > LIMITS.depth) throw new ExprError('括號太多層');
    let a = sum(depth);
    if (isOp('<', '<=', '>', '>=', '==', '!=')) {
      const op = toks[p++].v;
      a = node({ k: 'bin', op, a, b: sum(depth) });
    }
    return a;
  };
  const sum = (depth: number): Node => {
    let a = product(depth);
    while (isOp('+', '-')) {
      const op = toks[p++].v;
      a = node({ k: 'bin', op, a, b: product(depth) });
    }
    return a;
  };
  const product = (depth: number): Node => {
    let a = unary(depth);
    while (isOp('*', '/')) {
      const op = toks[p++].v;
      a = node({ k: 'bin', op, a, b: unary(depth) });
    }
    return a;
  };
  const unary = (depth: number): Node => {
    if (isOp('-')) { p++; return node({ k: 'neg', a: unary(depth + 1) }); }
    return atom(depth);
  };
  const atom = (depth: number): Node => {
    const t = toks[p++];
    if (!t) throw new ExprError('公式不完整', src.length);
    if (t.t === 'num') return node({ k: 'num', v: Number(t.v) });
    if (t.t === 'ref') return node({ k: 'ref', path: t.v });
    if (t.t === 'dice') return node(dice(t));
    if (t.t === 'name') {
      const arity = Object.hasOwn(FUNCTIONS, t.v) ? FUNCTIONS[t.v] : undefined;
      if (arity === undefined) throw new ExprError(`沒有「${t.v}」這個函式（可用：${Object.keys(FUNCTIONS).join('、')}）`, t.at);
      expect('(');
      const args = [expr(depth + 1)];
      while (isOp(',')) { p++; args.push(expr(depth + 1)); }
      expect(')');
      const [lo, hi] = typeof arity === 'number' ? [arity, arity] : arity;
      if (args.length < lo || args.length > hi) throw new ExprError(`${t.v} 要 ${lo === hi ? lo : `${lo} 到 ${hi}`} 個參數`, t.at);
      return node({ k: 'call', name: t.v, args });
    }
    if (t.v === '(') {
      const inner = expr(depth + 1);
      expect(')');
      return inner;
    }
    throw new ExprError(`這裡不該出現「${t.v}」`, t.at);
  };
  const dice = (t: Tok): Node => {
    const m = /^(\d*)d(\d+|%)(?:k([hl])(\d+))?$/.exec(t.v)!;
    const count = m[1] ? Number(m[1]) : 1, sides = m[2] === '%' ? 100 : Number(m[2]);
    checkDice(count, sides, t.at);
    const keep = m[3] ? { high: m[3] === 'h', n: Number(m[4]) } : undefined;
    if (keep && (keep.n < 1 || keep.n > count)) throw new ExprError(`${t.v}：保留的骰子數要在 1 到 ${count} 之間`, t.at);
    return { k: 'dice', count, sides, keep, text: t.v };
  };
  const out = expr(0);
  if (p < toks.length) throw new ExprError(`多出了「${toks[p].v}」`, toks[p].at);
  return out;
}

function checkDice(count: number, sides: number, at = -1) {
  if (!Number.isInteger(count) || count < 1 || count > LIMITS.dice) throw new ExprError(`骰子數量要在 1 到 ${LIMITS.dice} 之間`, at);
  if (!Number.isInteger(sides) || sides < 2 || sides > LIMITS.sides) throw new ExprError(`骰子面數要在 2 到 ${LIMITS.sides} 之間`, at);
}

/** One group of dice as rolled: every face, and which ones counted. */
export interface DiceRoll { text: string; sides: number; rolls: number[]; kept: boolean[]; total: number }
export interface Evaluation { total: number; dice: DiceRoll[]; text: string }

/** Values a formula may reference, e.g. `mod.DEX`. Unknown names are errors, so a typo never silently reads 0. */
export type Scope = (path: string) => number | undefined;

/**
 * Evaluates a formula. Without an rng, dice count as their average so sheets can preview a value (rounded down,
 * as many games print it: 1d8 → 4.5 shown, used as 4.5). `text` is the formula with each die's faces written in,
 * and each reference named by `label` when one is given (`防禦 12`).
 */
export function evaluate(src: string | Node, scope: Scope, rng?: Rng, label?: (path: string) => string | undefined): Evaluation {
  const ast = typeof src === 'string' ? parse(src) : src;
  const dice: DiceRoll[] = [];
  let budget = LIMITS.dice * 4;
  const show = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
  const run = (n: Node): [number, string] => {
    switch (n.k) {
      case 'num': return [n.v, show(n.v)];
      case 'ref': {
        const v = scope(n.path);
        if (v === undefined || !Number.isFinite(v)) throw new ExprError(`找不到 @${n.path}`);
        const name = label?.(n.path);
        return [v, name ? `${name} ${show(v)}` : show(v)];
      }
      case 'neg': { const [v, t] = run(n.a); return [-v, `-${t}`]; }
      case 'dice': return roll(n.count, n.sides, n.keep, n.text);
      case 'bin': {
        const [a, ta] = run(n.a), [b, tb] = run(n.b);
        const v = n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b
          : n.op === '/' ? (b === 0 ? fail('不能除以 0') : a / b)
            : Number(n.op === '<' ? a < b : n.op === '<=' ? a <= b : n.op === '>' ? a > b : n.op === '>=' ? a >= b : n.op === '==' ? a === b : a !== b);
        return [v, `${ta} ${n.op} ${tb}`];
      }
      case 'call': {
        if (n.name === 'if') {
          const [c] = run(n.args[0]);
          const [v, t] = run(n.args[c ? 1 : 2]);
          return [v, t];
        }
        const vals = n.args.map(run);
        const xs = vals.map(([v]) => v);
        if (n.name === 'roll') {
          const count = Math.floor(xs[0]), sides = Math.floor(xs[1]);
          if (count === 0) return [0, '0'];
          checkDice(count, sides);
          return roll(count, sides, undefined, `${count}d${sides}`);
        }
        const v = n.name === 'floor' ? Math.floor(xs[0]) : n.name === 'ceil' ? Math.ceil(xs[0]) : n.name === 'round' ? Math.round(xs[0])
          : n.name === 'abs' ? Math.abs(xs[0]) : n.name === 'min' ? Math.min(...xs) : Math.max(...xs);
        return [v, `${n.name}(${vals.map(([, t]) => t).join(', ')})`];
      }
    }
  };
  const roll = (count: number, sides: number, keep: { high: boolean; n: number } | undefined, text: string): [number, string] => {
    if ((budget -= count) < 0) throw new ExprError('一次擲的骰子太多');
    if (!rng) {
      const per = (sides + 1) / 2;
      return [(keep ? keep.n : count) * per, text];
    }
    const rolls = Array.from({ length: count }, () => rng(sides));
    const kept = rolls.map(() => !keep);
    if (keep) {
      const order = rolls.map((v, i) => [v, i] as const).sort((x, y) => (keep.high ? y[0] - x[0] : x[0] - y[0]) || x[1] - y[1]);
      for (const [, i] of order.slice(0, keep.n)) kept[i] = true;
    }
    const total = rolls.reduce((s, v, i) => s + (kept[i] ? v : 0), 0);
    dice.push({ text, sides, rolls, kept, total });
    return [total, `${text}[${rolls.map((v, i) => (kept[i] ? v : `~${v}~`)).join(',')}]`];
  };
  const [total, text] = run(ast);
  return { total, dice, text };
}

function fail(msg: string): never {
  throw new ExprError(msg);
}

/** Every `@ref` a formula reads, for validating a pack before anyone plays it. */
export function references(src: string | Node): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.k === 'ref') out.add(n.path);
    else if (n.k === 'neg') walk(n.a);
    else if (n.k === 'bin') { walk(n.a); walk(n.b); }
    else if (n.k === 'call') n.args.forEach(walk);
  };
  walk(typeof src === 'string' ? parse(src) : src);
  return [...out];
}

/** True when a formula rolls dice (directly or through roll()). */
export function hasDice(src: string | Node): boolean {
  const walk = (n: Node): boolean => n.k === 'dice' || (n.k === 'call' && (n.name === 'roll' || n.args.some(walk)))
    || (n.k === 'neg' && walk(n.a)) || (n.k === 'bin' && (walk(n.a) || walk(n.b)));
  return walk(typeof src === 'string' ? parse(src) : src);
}
