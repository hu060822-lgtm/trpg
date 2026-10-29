import { iatan2, icos, isin, seeded, type Seeded } from './rng';
import type { DodgeSetup, Emitter, PatternDef } from './types';

/**
 * The dodge: a thread knot (the player) in a small box, threads and needles flying at it. The browser runs this to
 * draw and play; the server runs the very same code over the player's recorded moves to count the hits, so the
 * result never depends on frame rate, network or a doctored page.
 *
 * Everything is integers: positions in thousandths of an arena unit (the box is 1000 × 1000 units), velocities per
 * tick, 60 ticks a second.
 */

export const TICKS_PER_SECOND = 60;
export const BOX = 1000;
const M = 1000;
const SOUL = 10;
/** After a hit the knot flickers and cannot be hit again for this many ticks. */
export const INVULNERABLE = 45;
const BASE_SPEED = 330;
const LASER_WARN = 36, LASER_ON = 18;
// Unit vectors for directions 1–8, clockwise from up, scaled by 1000.
const DIRS: readonly [number, number][] = [[0, 0], [0, -1000], [707, -707], [1000, 0], [707, 707], [0, 1000], [-707, 707], [-1000, 0], [-707, -707]];

export interface Bullet { x: number; y: number; vx: number; vy: number; r: number; born: number }
export interface Laser { vertical: boolean; at: number; w: number; warnUntil: number; until: number }

export const ticksFor = (ms: number) => Math.floor((ms * TICKS_PER_SECOND) / 1000);

/** The box the knot may move in, shrunk by the tier's arena factor (1.2 is the full box). */
export function boxOf(arena: number) {
  const side = Math.round((BOX * Math.min(arena, 1.2)) / 1.2);
  const o = Math.floor((BOX - side) / 2);
  return { o, side };
}

export class DodgeSim {
  tick = 0;
  hits = 0;
  invulnerable = 0;
  x: number;
  y: number;
  bullets: Bullet[] = [];
  lasers: Laser[] = [];
  readonly total: number;
  readonly box: { o: number; side: number };
  private rng: Seeded;
  private speed: number;
  private bulletScale: number;
  private density: number;
  private fires: { tick: number; e: Emitter }[] = [];

  constructor(readonly setup: DodgeSetup, seed: number) {
    this.rng = seeded(seed);
    this.total = ticksFor(setup.duration);
    this.box = boxOf(setup.tier.arena);
    this.x = (this.box.o + this.box.side / 2) * M;
    this.y = (this.box.o + Math.floor((this.box.side * 3) / 4)) * M;
    this.speed = Math.round((BASE_SPEED * setup.tier.speed * M) / TICKS_PER_SECOND);
    // The accessibility setting slows the threads, not the knot, so the player keeps full control.
    this.bulletScale = setup.reduced ? 3 : 4;
    this.density = setup.tier.density;
    for (const e of setup.pattern.emitters) {
      const every = Math.max(1, ticksFor(e.every ?? 500));
      for (let k = 0; k <= Math.min(e.repeat ?? 0, 40); k++) {
        const tick = ticksFor(e.at) + k * every;
        // Nothing new is fired in the last third of a second, so the end never feels like a trap.
        if (tick < this.total - 20) this.fires.push({ tick, e });
      }
    }
    this.fires.sort((a, b) => a.tick - b.tick);
  }

  get done() { return this.tick >= this.total; }

  /** Advances one tick with the player holding direction `dir` (0 still, 1–8 clockwise from up). */
  step(dir: number) {
    if (this.done) return;
    const [dx, dy] = DIRS[dir] ?? DIRS[0];
    const lo = (this.box.o + SOUL) * M, hi = (this.box.o + this.box.side - SOUL) * M;
    this.x = Math.max(lo, Math.min(hi, this.x + Math.trunc((dx * this.speed) / 1000)));
    this.y = Math.max(lo, Math.min(hi, this.y + Math.trunc((dy * this.speed) / 1000)));
    while (this.fires.length && this.fires[0].tick <= this.tick) this.fire(this.fires.shift()!.e);
    for (const b of this.bullets) if (b.born <= this.tick) { b.x += b.vx; b.y += b.vy; }
    const margin = 80 * M;
    this.bullets = this.bullets.filter((b) => b.born > this.tick || (b.x > -margin && b.y > -margin && b.x < BOX * M + margin && b.y < BOX * M + margin));
    this.lasers = this.lasers.filter((l) => l.until > this.tick);
    if (this.invulnerable > 0) this.invulnerable--;
    else if (this.touching()) { this.hits++; this.invulnerable = INVULNERABLE; }
    this.tick++;
  }

  private touching(): boolean {
    for (const b of this.bullets) {
      if (b.born > this.tick) continue;
      const ddx = b.x - this.x, ddy = b.y - this.y, rr = b.r + SOUL * M;
      if (ddx * ddx + ddy * ddy < rr * rr) return true;
    }
    for (const l of this.lasers) {
      if (this.tick < l.warnUntil) continue;
      const d = Math.abs((l.vertical ? this.x : this.y) - l.at);
      if (d < (l.w / 2 + SOUL) * M) return true;
    }
    return false;
  }

  private count(n: number) { return Math.max(1, Math.round(n * this.density)); }
  private vel(angle: number, speed: number) {
    const perTick = Math.round((speed * M * this.bulletScale) / 4 / TICKS_PER_SECOND);
    return { vx: Math.trunc((icos(angle) * perTick) / 16384), vy: Math.trunc((isin(angle) * perTick) / 16384) };
  }
  private origin(side: Emitter['side']) {
    const { o, side: s } = this.box;
    const along = o + this.rng.int(s);
    switch (side ?? 'top') {
      case 'bottom': return { x: along * M, y: (o + s + 20) * M };
      case 'left': return { x: (o - 20) * M, y: along * M };
      case 'right': return { x: (o + s + 20) * M, y: along * M };
      case 'center': return { x: (o + s / 2) * M, y: (o + Math.floor(s / 5)) * M };
      default: return { x: along * M, y: (o - 20) * M };
    }
  }
  private add(x: number, y: number, angle: number, e: Emitter, delay = 0) {
    this.bullets.push({ x, y, ...this.vel(angle, e.speed), r: (e.size ?? 9) * M, born: this.tick + delay });
  }

  private fire(e: Emitter) {
    const n = this.count(e.count);
    const { o, side: s } = this.box;
    switch (e.kind) {
      case 'fan': case 'aimed': {
        const p = this.origin(e.side);
        const aim = iatan2(this.y - p.y, this.x - p.x);
        const spread = e.kind === 'aimed' ? 0 : (e.spread ?? 48);
        for (let i = 0; i < n; i++) {
          const a = n === 1 ? aim : aim - Math.floor(spread / 2) + Math.round((i * spread) / (n - 1));
          this.add(p.x, p.y, a, e, e.kind === 'aimed' ? i * 6 : 0);
        }
        break;
      }
      case 'ring': {
        const p = this.origin(e.side ?? 'center');
        const phase = this.rng.int(256);
        for (let i = 0; i < n; i++) this.add(p.x, p.y, phase + Math.floor((i * 256) / n), e);
        break;
      }
      case 'spiral': {
        const p = this.origin('center');
        const phase = this.rng.int(256);
        for (let i = 0; i < n; i++) this.add(p.x, p.y, phase + i * 13, e, i * 3);
        break;
      }
      case 'rain': {
        for (let i = 0; i < n; i++) {
          const x = (o + this.rng.int(s)) * M;
          const tilt = this.rng.range(-8, 8);
          this.add(x, (o - 20 - this.rng.int(60)) * M, 64 + tilt, e);
        }
        break;
      }
      case 'laser': {
        const vertical = e.side !== 'left' && e.side !== 'right';
        const at = vertical ? this.x : this.y;
        this.lasers.push({ vertical, at, w: e.gap ?? 40, warnUntil: this.tick + LASER_WARN, until: this.tick + LASER_WARN + LASER_ON });
        break;
      }
      case 'wall': {
        const side = e.side ?? 'top';
        const gap = Math.min(e.gap ?? 140, s - 40);
        const start = o + this.rng.int(Math.max(1, s - gap));
        const angle = side === 'top' ? 64 : side === 'bottom' ? 192 : side === 'left' ? 0 : 128;
        const spacing = 2 * (e.size ?? 9) + 14;
        for (let along = o; along <= o + s; along += spacing) {
          if (along > start && along < start + gap) continue;
          const pos = side === 'top' ? { x: along, y: o - 20 } : side === 'bottom' ? { x: along, y: o + s + 20 } : side === 'left' ? { x: o - 20, y: along } : { x: o + s + 20, y: along };
          this.add(pos.x * M, pos.y * M, angle, e);
        }
        break;
      }
    }
  }
}

/** Replays a recorded dodge and returns the hits. Missing ticks count as standing still; extra ones are ignored. */
export function runDodge(setup: DodgeSetup, seed: number, moves: string): number {
  const sim = new DodgeSim(setup, seed);
  for (let i = 0; !sim.done; i++) sim.step(Number(moves[i] ?? 0) || 0);
  return sim.hits;
}

/** Checks a moves string from a client: digits 0–8 only, no longer than the dodge. */
export function validMoves(moves: unknown, setup: DodgeSetup): moves is string {
  return typeof moves === 'string' && moves.length <= ticksFor(setup.duration) && /^[0-8]*$/.test(moves);
}

/** Picks a pattern by seed from a list of ids, falling back to the first pattern known. */
export function pickPattern(ids: string[], known: PatternDef[], seed: number): PatternDef {
  const pool = ids.map((id) => known.find((p) => p.id === id)).filter((p): p is PatternDef => !!p);
  const from = pool.length ? pool : known;
  return from[seeded(seed ^ 0x9e3779b9).int(from.length)];
}
