/**
 * Dice that tumble in a tray: polyhedra, a small rigid-body step and a way to make them land on the faces the
 * server rolled. The server always rolls; this only animates. The step is deterministic, so the client can run a
 * copy of the dice ahead to see which face each will land on, then swap that face's number with the rolled one
 * before anyone can read it.
 *
 * Units: a die is about 1 across its corners; the tray floor is z = 0, x across and y away from the viewer.
 */

export type Vec = [number, number, number];
export type Quat = [number, number, number, number];

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec): Vec => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function qmul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
function qnorm(q: Quat): Quat { const l = Math.hypot(...q) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; }
export function rotate(q: Quat, v: Vec): Vec {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
function axisAngle(axis: Vec, angle: number): Quat { const a = unit(axis), s = Math.sin(angle / 2); return [Math.cos(angle / 2), a[0] * s, a[1] * s, a[2] * s]; }

// ---------------- shapes ----------------

export interface Shape {
  sides: number;
  verts: Vec[];
  /** Each face as vertex indexes, counter-clockwise seen from outside. */
  faces: number[][];
  normals: Vec[];
  centers: Vec[];
  /** The number printed on each face (a d4 is read from its top corner instead: see `cornerValues`). */
  values: number[];
  /** d4 only: the number of each corner; every face prints its three corners' numbers. */
  cornerValues?: number[];
  radius: number;
}

/** The faces of a convex point set: every plane through three points with all the others on one side. */
function hull(verts: Vec[]): number[][] {
  const seen = new Set<string>();
  const faces: number[][] = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    let nv = cross(sub(verts[j], verts[i]), sub(verts[k], verts[i]));
    if (len(nv) < 1e-9) continue;
    nv = unit(nv);
    const d = dot(nv, verts[i]);
    let above = 0, below = 0;
    for (const v of verts) { const s = dot(nv, v) - d; if (s > 1e-6) above++; else if (s < -1e-6) below++; }
    if (above && below) continue;
    if (above) nv = mul(nv, -1);
    const key = nv.map((x) => Math.round(x * 1e4)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const dd = dot(nv, verts[i]);
    const on = verts.map((_, m) => m).filter((m) => Math.abs(dot(nv, verts[m]) - dd) < 1e-6);
    const c = mul(on.reduce((s, m) => add(s, verts[m]), [0, 0, 0] as Vec), 1 / on.length);
    const u = unit(sub(verts[on[0]], c)), w = cross(nv, u);
    on.sort((a, b) => Math.atan2(dot(sub(verts[a], c), w), dot(sub(verts[a], c), u)) - Math.atan2(dot(sub(verts[b], c), w), dot(sub(verts[b], c), u)));
    faces.push(on);
  }
  return faces;
}

const PHI = (1 + Math.sqrt(5)) / 2;
function points(sides: number): Vec[] {
  switch (sides) {
    case 4: return [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
    case 6: return [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z): Vec => [x, y, z])));
    case 8: return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    case 10: {
      // Pentagonal trapezohedron: two apexes and two staggered rings; the apex height keeps each kite flat.
      const out: Vec[] = [[0, 0, 0.9472135955], [0, 0, -0.9472135955]];
      for (let k = 0; k < 5; k++) {
        const a = (k * 72 * Math.PI) / 180, b = ((k * 72 + 36) * Math.PI) / 180;
        out.push([Math.cos(a), Math.sin(a), 0.1], [Math.cos(b), Math.sin(b), -0.1]);
      }
      return out;
    }
    case 12: {
      const out: Vec[] = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z): Vec => [x, y, z])));
      for (const a of [-1, 1]) for (const b of [-1, 1]) out.push([0, a / PHI, b * PHI], [a / PHI, b * PHI, 0], [a * PHI, 0, b / PHI]);
      return out;
    }
    default: {
      const out: Vec[] = [];
      for (const a of [-1, 1]) for (const b of [-1, 1]) out.push([0, a, b * PHI], [a, b * PHI, 0], [a * PHI, 0, b]);
      return out;
    }
  }
}

const SIZE: Record<number, number> = { 4: 1.05, 6: 0.95, 8: 1, 10: 1, 12: 1, 20: 1.05 };
const shapes = new Map<number, Shape>();

/** A die with this many sides (4, 6, 8, 10, 12 or 20; anything else is drawn as a d20). */
export function shapeOf(sides: number): Shape {
  const s = [4, 6, 8, 10, 12, 20].includes(sides) ? sides : 20;
  const cached = shapes.get(s);
  if (cached) return cached;
  const raw = points(s);
  const far = Math.max(...raw.map(len));
  const verts = raw.map((v) => mul(v, SIZE[s] / far));
  const faces = hull(verts);
  const centers = faces.map((f) => mul(f.reduce((a, i) => add(a, verts[i]), [0, 0, 0] as Vec), 1 / f.length));
  const normals = faces.map((f) => unit(cross(sub(verts[f[1]], verts[f[0]]), sub(verts[f[2]], verts[f[0]]))));
  // Opposite faces add up to sides + 1, as on real dice.
  const values: number[] = new Array(faces.length).fill(0);
  let next = 1;
  for (let i = 0; i < faces.length; i++) {
    if (values[i]) continue;
    values[i] = next;
    const opp = normals.findIndex((n, j) => j !== i && !values[j] && dot(n, normals[i]) < -0.999);
    if (opp >= 0) values[opp] = faces.length + 1 - next;
    next++;
  }
  const shape: Shape = { sides: s, verts, faces, normals, centers, values, radius: SIZE[s] };
  if (s === 4) shape.cornerValues = [1, 2, 3, 4];
  shapes.set(s, shape);
  return shape;
}

// ---------------- bodies ----------------

export interface Tray { w: number; d: number }
export interface Body {
  sides: number;
  /** This die's own numbering (a copy of the shape's, so it can be swapped to land on the rolled face). */
  values: number[];
  cornerValues?: number[];
  p: Vec; q: Quat; v: Vec; w: Vec;
  /** Steps it has been almost still while touching the floor. */
  calm: number;
  asleep: boolean;
  /** Steps since the throw; a die still rocking after a few seconds is let to rest. */
  age: number;
}

const G = 70;
export const STEP = 1 / 240;
const MAX_STEPS = 240 * 5;

export function body(sides: number, p: Vec, q: Quat = [1, 0, 0, 0]): Body {
  const sh = shapeOf(sides);
  return { sides: sh.sides, values: [...sh.values], cornerValues: sh.cornerValues && [...sh.cornerValues], p, q, v: [0, 0, 0], w: [0, 0, 0], calm: 0, asleep: false, age: 0 };
}

export function clone(b: Body): Body {
  return { ...b, values: [...b.values], cornerValues: b.cornerValues && [...b.cornerValues], p: [...b.p], q: [...b.q], v: [...b.v], w: [...b.w] };
}

/** Sends a die off from where it is, with the velocity of the throw and a spin that follows it. */
export function launch(b: Body, v: Vec, spin: Vec) {
  b.v = v; b.w = spin; b.calm = 0; b.asleep = false; b.age = 0;
}

/** World positions of a die's corners. */
export function corners(b: Body): Vec[] {
  return shapeOf(b.sides).verts.map((v) => add(b.p, rotate(b.q, v)));
}

function planesOf(t: Tray): { n: Vec; d: number; e: number }[] {
  return [
    { n: [0, 0, 1], d: 0, e: 0.3 },
    { n: [1, 0, 0], d: -t.w / 2, e: 0.45 },
    { n: [-1, 0, 0], d: -t.w / 2, e: 0.45 },
    { n: [0, 1, 0], d: -t.d / 2, e: 0.45 },
    { n: [0, -1, 0], d: -t.d / 2, e: 0.45 },
    { n: [0, 0, -1], d: -9, e: 0.2 },
  ];
}

/** One fixed step for every die: gravity, the tray's floor and walls, a little friction, dice pushing each other. */
export function step(dice: Body[], t: Tray) {
  const planes = planesOf(t);
  for (const b of dice) {
    if (b.asleep) continue;
    const sh = shapeOf(b.sides);
    const inv = 1 / (0.4 * sh.radius * sh.radius * 0.8);
    b.v[2] -= G * STEP;
    b.p = add(b.p, mul(b.v, STEP));
    const wl = len(b.w);
    if (wl > 1e-9) b.q = qnorm(qmul(axisAngle(b.w, wl * STEP), b.q));
    let touching = false;
    for (const pl of planes) {
      let deepest = 0;
      for (const vb of sh.verts) {
        const r = rotate(b.q, vb);
        const at = add(b.p, r);
        const depth = pl.d - dot(pl.n, at);
        if (depth <= 0) continue;
        deepest = Math.max(deepest, depth);
        if (pl.n[2] === 1) touching = true;
        const vel = add(b.v, cross(b.w, r));
        const vn = dot(vel, pl.n);
        if (vn >= 0) continue;
        const e = vn < -2 ? pl.e : 0;
        const rn = cross(r, pl.n);
        const jn = (-(1 + e) * vn) / (1 + dot(rn, rn) * inv);
        b.v = add(b.v, mul(pl.n, jn));
        b.w = add(b.w, mul(rn, jn * inv));
        // Friction along the surface, no stronger than the push.
        const vel2 = add(b.v, cross(b.w, r));
        const vt = sub(vel2, mul(pl.n, dot(vel2, pl.n)));
        const vtl = len(vt);
        if (vtl > 1e-6) {
          const tdir = mul(vt, 1 / vtl);
          const rt = cross(r, tdir);
          const jt = Math.min(vtl / (1 + dot(rt, rt) * inv), 0.45 * jn);
          b.v = sub(b.v, mul(tdir, jt));
          b.w = sub(b.w, mul(rt, jt * inv));
        }
      }
      if (deepest > 0) b.p = add(b.p, mul(pl.n, deepest * 0.9));
    }
    b.v = mul(b.v, 1 - 0.15 * STEP);
    b.w = mul(b.w, touching ? 1 - 2.2 * STEP : 1 - 0.2 * STEP);
    const loose = ++b.age > 540 ? 6 : 1;
    const still = len(b.v) < 0.25 * loose && len(b.w) < 0.6 * loose;
    b.calm = touching && still ? b.calm + 1 : 0;
  }
  // Dice bump each other as balls; good enough to keep them apart.
  for (let i = 0; i < dice.length; i++) for (let j = i + 1; j < dice.length; j++) {
    const a = dice[i], c = dice[j];
    const r = (shapeOf(a.sides).radius + shapeOf(c.sides).radius) * 0.82;
    const dv = sub(c.p, a.p);
    const dist = len(dv);
    if (dist >= r || dist < 1e-6) continue;
    const n = mul(dv, 1 / dist);
    const push = (r - dist) / 2;
    a.p = sub(a.p, mul(n, push)); c.p = add(c.p, mul(n, push));
    const rel = dot(sub(c.v, a.v), n);
    if (rel < 0) {
      const j2 = -(1 + 0.4) * rel / 2;
      a.v = sub(a.v, mul(n, j2)); c.v = add(c.v, mul(n, j2));
      // Only a real knock wakes a die; two dice leaning on each other may rest.
      if (rel < -0.8) { a.asleep = false; c.asleep = false; a.calm = 0; c.calm = 0; }
    }
  }
  for (const b of dice) if (!b.asleep && b.calm > 36) b.asleep = true;
}

/** The face (index) pointing most nearly up; for a d4, the corner (index) that is highest. */
export function upIndex(b: Body): number {
  const sh = shapeOf(b.sides);
  if (b.sides === 4) {
    let best = 0, top = -Infinity;
    sh.verts.forEach((v, i) => { const z = rotate(b.q, v)[2]; if (z > top) { top = z; best = i; } });
    return best;
  }
  let best = 0, top = -Infinity;
  sh.normals.forEach((n, i) => { const z = rotate(b.q, n)[2]; if (z > top) { top = z; best = i; } });
  return best;
}

/** What the die shows right now. */
export function reading(b: Body): number {
  const i = upIndex(b);
  return b.sides === 4 ? b.cornerValues![i] : b.values[i];
}

/** Runs copies of the dice until they all rest (or time runs out) and returns where each one stops. */
export function predict(dice: Body[], t: Tray): number[] {
  const copy = dice.map(clone);
  for (let i = 0; i < MAX_STEPS && copy.some((b) => !b.asleep); i++) step(copy, t);
  return copy.map(upIndex);
}

/**
 * Renumbers each die so that it will land on `want` (one value per die; null leaves a die alone). Only two numbers
 * swap places on each die, and before it stops, so nobody sees a face change.
 */
export function steer(dice: Body[], t: Tray, want: (number | null)[]) {
  const ends = predict(dice, t);
  dice.forEach((b, k) => {
    const v = want[k];
    if (v === null || v === undefined) return;
    const labels = b.sides === 4 ? b.cornerValues! : b.values;
    const target = Math.min(Math.max(1, Math.round(v)), b.sides === 4 ? 4 : labels.length);
    const from = labels.indexOf(target);
    const to = ends[k];
    if (from < 0 || from === to) return;
    [labels[from], labels[to]] = [labels[to], labels[from]];
  });
}

/** Turns a resting die the last little bit so its top face lies flat (it can come to rest a hair off). */
export function settleFlat(b: Body, k: number) {
  const sh = shapeOf(b.sides);
  const i = upIndex(b);
  const n = b.sides === 4 ? unit(sh.verts[i]) : sh.normals[i];
  // A d4 rests on the face opposite its top corner: that face's normal points straight down.
  const now = rotate(b.q, b.sides === 4 ? mul(n, 1) : n);
  const axis = cross(now, [0, 0, 1]);
  const s = len(axis);
  if (s < 1e-6) return;
  const angle = Math.asin(Math.min(1, s)) * k;
  b.q = qnorm(qmul(axisAngle(axis, angle), b.q));
}

/** A random-looking orientation from a number, so each throw starts differently. */
export function tumble(seed: number): Quat {
  const r = (n: number) => { const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); };
  return qnorm([r(1) - 0.5, r(2) - 0.5, r(3) - 0.5, r(4) - 0.5]);
}

/** An orientation that rests the die showing `value` on top, turned by `yaw` around the vertical. */
export function restingOn(b: Body, value: number, yaw: number) {
  const sh = shapeOf(b.sides);
  const labels = b.sides === 4 ? b.cornerValues! : b.values;
  const i = Math.max(0, labels.indexOf(value));
  const n = b.sides === 4 ? unit(sh.verts[i]) : sh.normals[i];
  const axis = cross(n, [0, 0, 1]);
  const s = len(axis);
  const tilt: Quat = s < 1e-6 ? (n[2] > 0 ? [1, 0, 0, 0] : axisAngle([1, 0, 0], Math.PI)) : axisAngle(axis, Math.atan2(s, n[2]));
  b.q = qnorm(qmul(axisAngle([0, 0, 1], yaw), tilt));
  // Rest it on the floor: lowest corner at z = 0.
  b.p[2] = 0;
  b.p[2] = -Math.min(...corners(b).map((c) => c[2]));
  b.v = [0, 0, 0]; b.w = [0, 0, 0]; b.asleep = true;
}
