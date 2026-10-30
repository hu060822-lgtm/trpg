import { icos, isin, seeded } from './rng';
import type { GestureInput, InputSample, Interaction } from './types';

/**
 * Weapon gestures. Each one comes after the attack roll and only produces a quality from 0 to 1, which the pack
 * turns into a small bonus. Range, cost and the dice are settled before a gesture starts, so a gesture can never
 * reach further, cost less or roll better than the rules allow.
 *
 * `challenge` builds what the player sees from a seed; `score` works out the quality from what they did. Both run
 * in the browser (to draw and to preview) and on the server (whose answer counts). Coordinates are a 1000 × 1000 box,
 * times are milliseconds from when the gesture panel opened. Every gesture also has a one-key form (space bar or a
 * single tap) for players who cannot draw.
 */

export interface Point { x: number; y: number }
export type Challenge =
  /** Blades and axes: draw the slash trail along the glowing weak-point line, in one quick stroke. */
  | { kind: 'slash'; a: Point; b: Point; window: [number, number]; beat: number }
  /** Daggers, spears, rapiers: stab — a short, straight, fast line from the guard ring into the target. */
  | { kind: 'thrust'; from: Point; to: Point; window: [number, number]; beat: number }
  /** Heavy two-handers: drag along the arc in one sweep. */
  | { kind: 'sweep'; c: Point; r: number; from: number; to: number; window: [number, number]; beat: number }
  /** Maces and hammers: lift above the line, then slam down onto the target. */
  | { kind: 'smash'; start: Point; target: Point; raise: number; window: [number, number]; beat: number }
  /** Whips and chains: follow the wave from end to end. */
  | { kind: 'lash'; points: Point[]; window: [number, number]; beat: number }
  /** Bows: grab the string, pull back away from the target, aim, let go. Held too long, the aim shakes. */
  | { kind: 'draw'; bow: Point; target: Point; full: number; sway: number[]; beat: number }
  /** Crossbows and blowguns: drag the sight onto the target against the sway, release to shoot. */
  | { kind: 'aim'; sight: Point; target: Point; sway: number[]; beat: number }
  /** Thrown weapons: flick from the hand toward the target — straight and quick. */
  | { kind: 'throw'; hand: Point; target: Point; window: [number, number]; beat: number }
  /** Spells: trace the magic circle, then join the sigil points in their numbered order. */
  | { kind: 'rune'; centre: Point; r: number; points: Point[]; limit: number; beat: number };

/** How long a gesture panel stays open before it counts as not done. */
export const GESTURE_LIMIT_MS = 8000;

export function challengeFor(kind: Interaction, seed: number, runes = 4): Challenge | null {
  const r = seeded(seed);
  // The one-key form: a marker sweeps across a bar and comes back; the best moment to press is `beat` ms in.
  const beat = 900 + r.int(900);
  const along = (o: Point, angle: number, len: number): Point => ({ x: o.x + Math.trunc((icos(angle) * len) / 16384), y: o.y + Math.trunc((isin(angle) * len) / 16384) });
  switch (kind) {
    case 'slash': {
      const angle = r.int(256), len = 300 + r.int(120);
      const cx = 400 + r.int(200), cy = 400 + r.int(200);
      const dx = Math.trunc((icos(angle) * len) / 16384), dy = Math.trunc((isin(angle) * len) / 16384);
      return { kind, a: { x: cx - dx, y: cy - dy }, b: { x: cx + dx, y: cy + dy }, window: [150, 700], beat };
    }
    case 'thrust': {
      const to = { x: 380 + r.int(240), y: 300 + r.int(200) };
      // The guard ring sits below the target, a little to one side.
      return { kind, from: along(to, 48 + r.int(32), 330 + r.int(90)), to, window: [60, 380], beat };
    }
    case 'sweep': {
      const from = 140 + r.int(20), span = 90 + r.int(30);
      return { kind, c: { x: 500, y: 900 }, r: 420 + r.int(80), from, to: from + span, window: [250, 1000], beat };
    }
    case 'smash': {
      const target = { x: 300 + r.int(400), y: 760 + r.int(80) };
      return { kind, start: { x: target.x, y: target.y - 60 }, target, raise: 220 + r.int(80), window: [60, 350], beat };
    }
    case 'lash': {
      const amp = 150 + r.int(80), phase = r.int(256), y0 = 420 + r.int(160), waves = 2 + r.int(2);
      const points: Point[] = [];
      for (let i = 0; i <= 24; i++) points.push({ x: 110 + Math.round((780 * i) / 24), y: y0 + Math.trunc((isin(phase + Math.floor((i * 128 * waves) / 24)) * amp) / 16384) });
      return { kind, points, window: [350, 1300], beat };
    }
    case 'draw':
      return { kind, bow: { x: 500, y: 760 }, target: { x: 300 + r.int(400), y: 170 + r.int(60) }, full: 230 + r.int(60), sway: [r.int(256), r.int(256), 3 + r.int(3), 5 + r.int(3)], beat };
    case 'aim':
      return { kind, sight: { x: 500, y: 820 }, target: { x: 250 + r.int(500), y: 200 + r.int(250) }, sway: [r.int(256), r.int(256), 4 + r.int(3), 6 + r.int(3)], beat };
    case 'throw':
      return { kind, hand: { x: 500, y: 840 }, target: { x: 220 + r.int(560), y: 150 + r.int(160) }, window: [50, 260], beat };
    case 'rune': {
      const n = Math.max(3, Math.min(7, runes));
      const centre = { x: 500, y: 500 }, rr = 300 + r.int(60), phase = r.int(256);
      const ring = Array.from({ length: n }, (_, i) => along(centre, phase + Math.floor((i * 256) / n), rr));
      // A star where the count allows one (5 → pentagram, 7 → heptagram), the polygon otherwise.
      const step = n === 5 ? 2 : n === 7 ? 3 : 1;
      const points = Array.from({ length: n }, (_, i) => ring[(i * step) % n]);
      return { kind, centre, r: rr, points, limit: 4000 + n * 700, beat };
    }
    default:
      return null;
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** 1 inside [lo, hi], falling to `floor` at 0 ms and at 2 × hi. */
function timing(ms: number, [lo, hi]: [number, number], floor = 0.5) {
  if (ms >= lo && ms <= hi) return 1;
  if (ms < lo) return floor + (1 - floor) * (ms / lo);
  return Math.max(floor, 1 - ((1 - floor) * (ms - hi)) / hi);
}
const dist2 = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const dist = (a: Point, b: Point) => Math.sqrt(dist2(a, b));
/** Squared distance from p to the segment ab. */
function segDist2(p: Point, a: Point, b: Point) {
  const vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy;
  if (len2 === 0) return dist2(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  return dist2(p, { x: a.x + t * vx, y: a.y + t * vy });
}
/** The first continuous press: the samples from the first touch until the pointer lifts. */
function firstStroke(samples: InputSample[]): InputSample[] {
  return strokes(samples)[0] ?? [];
}
/** Every press, each from touch to lift. */
function strokes(samples: InputSample[]): InputSample[][] {
  const out: InputSample[][] = [];
  let cur: InputSample[] | null = null;
  for (const s of samples) {
    if (s.d === 1) (cur ??= []).push(s);
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}
/** Share of `points` within `reach` of the stroke. */
function coverage(points: Point[], stroke: Point[], reach: number) {
  if (stroke.length === 0) return 0;
  let near = 0;
  for (const p of points) {
    let ok = stroke.length === 1 ? dist2(p, stroke[0]) <= reach * reach : false;
    for (let i = 1; i < stroke.length && !ok; i++) ok = segDist2(p, stroke[i - 1], stroke[i]) <= reach * reach;
    if (ok) near++;
  }
  return near / points.length;
}
/** 1 when `p` is on `at`, falling to 0 at `reach`. */
const near = (p: Point, at: Point, reach: number) => clamp01(1 - dist(p, at) / reach);
/** 1 for a straight stroke, falling as it wanders off the line from its first to its last point. */
function straightness(s: Point[], slack: number) {
  const a = s[0], b = s.at(-1)!;
  let worst = 0;
  for (const p of s) worst = Math.max(worst, Math.sqrt(segDist2(p, a, b)));
  return clamp01(1 - worst / slack);
}
/** Where a shot along `dir` from `from` crosses the height `y`; null when it flies the wrong way. */
function crossAt(from: Point, dir: Point, y: number): Point | null {
  if (dir.y >= -1e-6) return null;
  return { x: from.x + (dir.x * (y - from.y)) / dir.y, y };
}

/** The one-key form: a single press, scored by how close it is to the beat. */
function oneKey(c: Challenge, input: Extract<GestureInput, { kind: 'keys' }>): number {
  const downs = input.presses.filter((p) => !p.up);
  if (c.kind === 'rune') {
    // Runes in one-key form: press the numbers in order (1, 2, 3…).
    const keys = downs.filter((p) => p.t <= c.limit).map((p) => p.key);
    let right = 0;
    while (right < keys.length && right < c.points.length && keys[right] === String(right + 1)) right++;
    return right / c.points.length;
  }
  const first = downs[0];
  if (!first) return 0;
  return clamp01(1 - Math.abs(first.t - c.beat) / 450);
}

/**
 * Aim sway: how far off the aim is `t` ms into a hold, in box units. A small wobble from the start (`base`), steady
 * otherwise for half a second, then shaking wider the longer it is held.
 */
export function swayAt(c: { sway: number[] }, t: number, base = 30): Point {
  const [p1, p2, f1, f2] = c.sway;
  const amp = base + Math.min(240, Math.max(0, t - 500) / 6);
  const a1 = p1 + Math.floor((t * f1) / 40), a2 = p2 + Math.floor((t * f2) / 40);
  return { x: Math.trunc((icos(a1) * amp) / 16384), y: Math.trunc((isin(a2) * amp) / 16384) };
}

export function sweepPoints(c: Extract<Challenge, { kind: 'sweep' }>, n = 16): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = c.from + Math.round(((c.to - c.from) * i) / (n - 1));
    out.push({ x: c.c.x + Math.trunc((icos(a) * c.r) / 16384), y: c.c.y + Math.trunc((isin(a) * c.r) / 16384) });
  }
  return out;
}

export function ringPoints(c: Extract<Challenge, { kind: 'rune' }>, n = 24): Point[] {
  return Array.from({ length: n }, (_, i) => ({ x: c.centre.x + Math.trunc((icos(Math.floor((i * 256) / n)) * c.r) / 16384), y: c.centre.y + Math.trunc((isin(Math.floor((i * 256) / n)) * c.r) / 16384) }));
}

/**
 * The bow at a moment of the pull: how hard it is drawn (0–1), and where the arrow would land. `s` is the stroke so
 * far; the string is grabbed where the stroke began and pulled to where it is now.
 */
export function bowState(c: Extract<Challenge, { kind: 'draw' }>, s: InputSample[]): { power: number; land: Point | null; held: number } {
  if (s.length === 0) return { power: 0, land: null, held: 0 };
  const p0 = s[0], pe = s.at(-1)!;
  const grab = near(p0, c.bow, 220) > 0;
  const v = { x: p0.x - pe.x, y: p0.y - pe.y };
  const pull = Math.sqrt(v.x * v.x + v.y * v.y);
  const power = grab ? clamp01(pull / c.full) : 0;
  // The hold that makes the aim shake starts once the string is fully drawn.
  const fullAt = s.find((p) => Math.hypot(p0.x - p.x, p0.y - p.y) >= c.full);
  const held = fullAt ? pe.t - fullAt.t : 0;
  const hit = pull > 20 ? crossAt(c.bow, v, c.target.y) : null;
  if (!hit) return { power, land: null, held };
  // A bow is steady at the moment of full draw; only holding it there makes it shake.
  const off = swayAt(c, held, 0);
  return { power, land: { x: hit.x + off.x, y: hit.y + off.y }, held };
}

/** Where the crossbow sight points: dragged by the pointer from where it rests, plus the sway since the press. */
export function sightAt(c: Extract<Challenge, { kind: 'aim' }>, s: InputSample[]): Point {
  if (s.length === 0) return c.sight;
  const p0 = s[0], pe = s.at(-1)!;
  const off = swayAt(c, pe.t - p0.t);
  return { x: c.sight.x + (pe.x - p0.x) + off.x, y: c.sight.y + (pe.y - p0.y) + off.y };
}

/** Where a throw lands: along the flick, at the target's height. */
export function throwLanding(c: Extract<Challenge, { kind: 'throw' }>, s: InputSample[]): Point | null {
  if (s.length < 2) return null;
  const a = s[0], b = s.at(-1)!;
  return crossAt(c.hand, { x: b.x - a.x, y: b.y - a.y }, c.target.y);
}

/** Quality from 0 to 1 for what the player did; 0 when the input is malformed or out of time. */
export function scoreGesture(c: Challenge, input: GestureInput): number {
  if (!wellFormed(input)) return 0;
  if (input.kind === 'keys') return round2(oneKey(c, input));
  const samples = input.samples;
  const s = firstStroke(samples);
  const span = s.length ? s.at(-1)!.t - s[0].t : 0;
  switch (c.kind) {
    case 'slash': {
      if (s.length < 2) return 0;
      const line: Point[] = [];
      for (let i = 0; i <= 20; i++) line.push({ x: c.a.x + ((c.b.x - c.a.x) * i) / 20, y: c.a.y + ((c.b.y - c.a.y) * i) / 20 });
      return round2(coverage(line, s, 60) * timing(span, c.window));
    }
    case 'sweep': {
      if (s.length < 2) return 0;
      return round2(coverage(sweepPoints(c), s, 70) * timing(span, c.window));
    }
    case 'thrust': {
      if (s.length < 2) return 0;
      const start = 0.5 + 0.5 * near(s[0], c.from, 160);
      return round2(start * near(s.at(-1)!, c.to, 150) * straightness(s, 120) * timing(span, c.window, 0.4));
    }
    case 'smash': {
      if (s.length < 2) return 0;
      // The highest point of the swing, then the drop from there onto the target.
      let top = 0;
      for (let i = 1; i < s.length; i++) if (s[i].y < s[top].y) top = i;
      const lift = clamp01((s[0].y - s[top].y) / Math.max(1, s[0].y - c.raise));
      const drop = s.slice(top);
      if (drop.length < 2) return 0;
      return round2(lift * near(drop.at(-1)!, c.target, 150) * timing(drop.at(-1)!.t - drop[0].t, c.window, 0.4));
    }
    case 'lash': {
      if (s.length < 2) return 0;
      const fromEnd = near(s[0], c.points[0], 180) > 0 || near(s[0], c.points.at(-1)!, 180) > 0 ? 1 : 0.6;
      return round2(fromEnd * coverage(c.points, s, 65) * timing(span, c.window));
    }
    case 'draw': {
      const b = bowState(c, s);
      if (!b.land) return 0;
      return round2(b.power * near(b.land, c.target, 220));
    }
    case 'aim': {
      if (s.length < 1) return 0;
      return round2(near(sightAt(c, s), c.target, 180));
    }
    case 'throw': {
      const land = throwLanding(c, s);
      if (!land) return 0;
      const length = dist(s[0], s.at(-1)!);
      return round2(near(land, c.target, 170) * clamp01(length / 220) * timing(span, c.window, 0.4));
    }
    case 'rune': {
      // The circle: the best single stroke along the ring. The sigil: points touched in their order by the other strokes
      // (the circle itself runs through every point, so it does not count toward the order).
      const ring = ringPoints(c);
      const all = strokes(samples).filter((k) => k[0].t <= c.limit);
      const fits = all.map((k) => coverage(ring, k, 70));
      const best = fits.length ? fits.indexOf(Math.max(...fits)) : -1;
      const circle = best >= 0 ? fits[best] : 0;
      const touched: number[] = [];
      all.forEach((k, n) => {
        if (n === best && circle >= 0.5) return;
        for (const p of k) {
          if (p.t > c.limit) continue;
          const i = c.points.findIndex((q) => dist2(p, q) <= 70 * 70);
          if (i < 0 || touched.at(-1) === i) continue;
          touched.push(i);
        }
      });
      let right = 0;
      while (right < touched.length && touched[right] === right) right++;
      return round2(0.4 * circle + 0.6 * (right / c.points.length));
    }
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Rejects input a real pointer or keyboard could not have made: wrong shapes, times going backwards, too much of it. */
export function wellFormed(input: unknown): input is GestureInput {
  const i = input as GestureInput;
  if (!i || typeof i !== 'object') return false;
  const time = (t: unknown) => typeof t === 'number' && Number.isInteger(t) && t >= 0 && t <= GESTURE_LIMIT_MS;
  if (i.kind === 'keys') {
    if (!Array.isArray(i.presses) || i.presses.length > 40) return false;
    let last = 0;
    for (const p of i.presses) {
      if (!p || !time(p.t) || p.t < last || typeof p.key !== 'string' || p.key.length > 12) return false;
      last = p.t;
    }
    return true;
  }
  if (i.kind !== 'pointer' || !Array.isArray(i.samples) || i.samples.length > 600) return false;
  let last = 0;
  for (const s of i.samples) {
    if (!s || !time(s.t) || s.t < last || !Number.isInteger(s.x) || !Number.isInteger(s.y) || (s.d !== 0 && s.d !== 1)) return false;
    if (s.x < -200 || s.x > 1200 || s.y < -200 || s.y > 1200) return false;
    last = s.t;
  }
  return true;
}

/** What each gesture is called on screen, and the one-line instruction under it. */
export const GESTURE_TEXT: Record<Exclude<Interaction, 'none'>, { name: string; how: string; key: string }> = {
  slash: { name: '斬擊', how: '一筆畫過發光的弱點線，畫得準、畫得俐落加值越高。', key: '游標掃到中間時按空白鍵（或點一下）。' },
  thrust: { name: '突刺', how: '從護手圈往目標點一戳：直、短、快。', key: '游標掃到中間時按空白鍵（或點一下）。' },
  sweep: { name: '橫掃', how: '沿著弧線一口氣拖過去。', key: '游標掃到中間時按空白鍵（或點一下）。' },
  smash: { name: '重擊', how: '按住往上舉過虛線，再用力砸到目標上。', key: '游標掃到中間時按空白鍵（或點一下）。' },
  lash: { name: '甩鞭', how: '從波浪的一端一筆順著甩到另一端。', key: '游標掃到中間時按空白鍵（或點一下）。' },
  draw: { name: '拉弓', how: '按住弓弦往後拉（離目標越遠越滿），對準靶心放開。拉滿後拖太久準心會晃。', key: '游標掃到中間時按空白鍵（或點一下）。' },
  aim: { name: '瞄準', how: '按住拖動準星，壓住晃動對準靶心，放開就射。', key: '游標掃到中間時按空白鍵（或點一下）。' },
  throw: { name: '投擲', how: '從手邊往目標快速一甩，方向對準就好。', key: '游標掃到中間時按空白鍵（或點一下）。' },
  rune: { name: '魔法陣', how: '先沿著外圈畫一圈魔法陣，再照數字順序連起符文點。', key: '依序按數字鍵 1、2、3…（或依序點）。' },
};
