import { icos, isin, isqrt, seeded } from './rng';
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
  | { kind: 'slash'; a: Point; b: Point; window: [number, number]; beat: number }
  | { kind: 'thrust'; start: number; target: number; shrink: number; beat: number }
  | { kind: 'sweep'; c: Point; r: number; from: number; to: number; window: [number, number]; beat: number }
  | { kind: 'draw'; full: number; sway: number[]; beat: number }
  | { kind: 'rune'; points: Point[]; limit: number; beat: number };

/** How long a gesture panel stays open before it counts as not done. */
export const GESTURE_LIMIT_MS = 8000;

export function challengeFor(kind: Interaction, seed: number, runes = 4): Challenge | null {
  const r = seeded(seed);
  // The one-key form: a marker sweeps across a bar and comes back; the best moment to press is `beat` ms in.
  const beat = 900 + r.int(900);
  switch (kind) {
    case 'slash': {
      const angle = r.int(256), len = 300 + r.int(120);
      const cx = 400 + r.int(200), cy = 400 + r.int(200);
      const dx = Math.trunc((icos(angle) * len) / 16384), dy = Math.trunc((isin(angle) * len) / 16384);
      return { kind, a: { x: cx - dx, y: cy - dy }, b: { x: cx + dx, y: cy + dy }, window: [150, 700], beat };
    }
    case 'thrust':
      return { kind, start: 420, target: 80 + r.int(40), shrink: 300 + r.int(120), beat };
    case 'sweep': {
      const from = 140 + r.int(20), span = 90 + r.int(30);
      return { kind, c: { x: 500, y: 900 }, r: 420 + r.int(80), from, to: from + span, window: [250, 1000], beat };
    }
    case 'draw':
      return { kind, full: 700 + r.int(300), sway: [r.int(256), r.int(256), 3 + r.int(3), 5 + r.int(3)], beat };
    case 'rune': {
      const points: Point[] = [];
      while (points.length < runes) {
        const p = { x: 150 + r.int(700), y: 150 + r.int(700) };
        if (points.every((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 > 200 * 200)) points.push(p);
      }
      return { kind, points, limit: 2500 + runes * 600, beat };
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
/** Squared distance from p to the segment ab. */
function segDist2(p: Point, a: Point, b: Point) {
  const vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy;
  if (len2 === 0) return dist2(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  return dist2(p, { x: a.x + t * vx, y: a.y + t * vy });
}
/** The first continuous press: the samples from the first touch until the pointer lifts. */
function firstStroke(samples: InputSample[]): InputSample[] {
  const start = samples.findIndex((s) => s.d === 1);
  if (start < 0) return [];
  const end = samples.findIndex((s, i) => i > start && s.d === 0);
  return samples.slice(start, end < 0 ? undefined : end);
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

/** Bow sway: where the aim point sits `t` ms after the string is fully drawn, in box units from the centre. */
export function swayAt(c: Extract<Challenge, { kind: 'draw' }>, t: number): Point {
  const [p1, p2, f1, f2] = c.sway;
  // The longer the hold, the wider the wobble: steady for a moment, then shaking.
  const amp = 40 + Math.min(260, Math.max(0, t - 600) / 6);
  const a1 = p1 + Math.floor((t * f1) / 40), a2 = p2 + Math.floor((t * f2) / 40);
  return { x: Math.trunc((icos(a1) * amp) / 16384), y: Math.trunc((isin(a2) * amp) / 16384) };
}

export function thrustRadius(c: Extract<Challenge, { kind: 'thrust' }>, heldMs: number) {
  return Math.max(0, c.start - Math.floor((heldMs * c.shrink) / 1000));
}

export function sweepPoints(c: Extract<Challenge, { kind: 'sweep' }>, n = 16): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = c.from + Math.round(((c.to - c.from) * i) / (n - 1));
    out.push({ x: c.c.x + Math.trunc((icos(a) * c.r) / 16384), y: c.c.y + Math.trunc((isin(a) * c.r) / 16384) });
  }
  return out;
}

/** Quality from 0 to 1 for what the player did; 0 when the input is malformed or out of time. */
export function scoreGesture(c: Challenge, input: GestureInput): number {
  if (!wellFormed(input)) return 0;
  if (input.kind === 'keys') return round2(oneKey(c, input));
  const samples = input.samples;
  switch (c.kind) {
    case 'slash': {
      const s = firstStroke(samples);
      if (s.length < 2) return 0;
      const along: Point[] = [];
      for (let i = 0; i <= 20; i++) along.push({ x: c.a.x + ((c.b.x - c.a.x) * i) / 20, y: c.a.y + ((c.b.y - c.a.y) * i) / 20 });
      return round2(coverage(along, s, 60) * timing(s.at(-1)!.t - s[0].t, c.window));
    }
    case 'sweep': {
      const s = firstStroke(samples);
      if (s.length < 2) return 0;
      return round2(coverage(sweepPoints(c), s, 70) * timing(s.at(-1)!.t - s[0].t, c.window));
    }
    case 'thrust': {
      const s = firstStroke(samples);
      if (s.length < 1) return 0;
      const held = s.at(-1)!.t - s[0].t;
      return round2(clamp01(1 - Math.abs(thrustRadius(c, held) - c.target) / 120));
    }
    case 'draw': {
      const s = firstStroke(samples);
      if (s.length < 1) return 0;
      const held = s.at(-1)!.t - s[0].t;
      const power = clamp01(held / c.full);
      const off = swayAt(c, Math.max(0, held - c.full));
      return round2(power * clamp01(1 - isqrt(off.x * off.x + off.y * off.y) / 250));
    }
    case 'rune': {
      // Every point touched in order counts; touching one out of order ends the chain.
      const touched: number[] = [];
      for (const p of samples) {
        if (p.d !== 1 || p.t > c.limit) continue;
        const i = c.points.findIndex((q) => dist2(p, q) <= 70 * 70);
        if (i < 0 || touched.at(-1) === i) continue;
        touched.push(i);
      }
      let right = 0;
      while (right < touched.length && touched[right] === right) right++;
      return round2(right / c.points.length);
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
  thrust: { name: '突刺', how: '按住蓄力，外圈縮到和目標圈重疊時放開。', key: '游標掃到中間時按空白鍵（或點一下）。' },
  sweep: { name: '橫掃', how: '沿著弧線一口氣拖過去。', key: '游標掃到中間時按空白鍵（或點一下）。' },
  draw: { name: '拉弓', how: '按住拉弓，拉滿後準心會晃，晃到中間時放開。拉太久會越晃越大。', key: '游標掃到中間時按空白鍵（或點一下）。' },
  rune: { name: '符文', how: '照數字順序連起所有符文點。', key: '依序按數字鍵 1、2、3…（或依序點）。' },
};
