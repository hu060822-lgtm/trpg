import type { MapObject, MapObjectKind } from '../table/types';
import type { AreaShape } from './types';

/**
 * Grid geometry for combat, in squares: distances, line of sight past walls, how far a creature can walk, and which
 * squares an area covers. The server uses it to decide what is legal; the browser uses the same code to show it.
 * Hits and ranges always come from these world coordinates, never from pixels on a screen, so the top-down and the
 * tilted view cannot disagree.
 */

export interface Footprint { x: number; y: number; size: number; elevation?: number }
export interface Grid { cols: number; rows: number; cellDistance: number; rule: 'chebyshev' | 'alternate' }
export interface Cell { x: number; y: number }

/** How tall each kind of scenery stands by default, in feet; 0 means it lies flat and blocks nothing. */
export const OBJECT_HEIGHT: Record<MapObjectKind, number> = {
  wall: 10, door: 8, window: 8, pillar: 10, stairs: 0, rubble: 1, table: 3, chair: 2, bed: 2, chest: 2, barrel: 3, crate: 3,
  bookshelf: 7, altar: 3, statue: 8, tree: 15, bush: 3, rock: 4, water: 0, fire: 0, trap: 0, label: 0,
};
const BLOCKS_SIGHT = new Set<MapObjectKind>(['wall', 'door', 'pillar', 'bookshelf', 'statue', 'tree', 'rock']);
const BLOCKS_MOVE = new Set<MapObjectKind>(['wall', 'door', 'window', 'pillar', 'bookshelf', 'statue', 'tree', 'rock', 'crate', 'barrel', 'altar']);

export type Blocker = Pick<MapObject, 'kind' | 'x' | 'y' | 'w' | 'h'> & { open?: boolean; height?: number | null };
export const heightOf = (o: Blocker) => o.height ?? OBJECT_HEIGHT[o.kind];
/** Open doors and windows let everything through. */
export const blocksSight = (o: Blocker) => BLOCKS_SIGHT.has(o.kind) && !o.open;
export const blocksMove = (o: Blocker) => BLOCKS_MOVE.has(o.kind) && !o.open;

/** A per-square lookup of the tallest blocking object, for sight and for movement. */
export function blockMap(grid: Grid, objects: Blocker[]) {
  const sight = new Int16Array(grid.cols * grid.rows), move = new Uint8Array(grid.cols * grid.rows);
  for (const o of objects) {
    const s = blocksSight(o), m = blocksMove(o);
    if (!s && !m) continue;
    for (let y = o.y; y < Math.min(o.y + o.h, grid.rows); y++) for (let x = o.x; x < Math.min(o.x + o.w, grid.cols); x++) {
      const i = y * grid.cols + x;
      if (s) sight[i] = Math.max(sight[i], heightOf(o));
      if (m) move[i] = 1;
    }
  }
  return { sight, move };
}
export type BlockMap = ReturnType<typeof blockMap>;

/** Squares between two footprints, in the grid's distance rule, including the height difference. */
export function squaresBetween(grid: Grid, a: Footprint, b: Footprint): number {
  const gap = (a0: number, as: number, b0: number, bs: number) => Math.max(0, b0 - (a0 + as - 1), a0 - (b0 + bs - 1));
  const dx = gap(a.x, a.size, b.x, b.size), dy = gap(a.y, a.size, b.y, b.size);
  const dz = Math.round(Math.abs((a.elevation ?? 0) - (b.elevation ?? 0)) / grid.cellDistance);
  const [hi, mid, lo] = [dx, dy, dz].sort((p, q) => q - p);
  if (grid.rule === 'alternate') return hi + Math.floor(mid / 2) + Math.floor(lo / 2);
  return hi;
}
export const feetBetween = (grid: Grid, a: Footprint, b: Footprint) => squaresBetween(grid, a, b) * grid.cellDistance;

/**
 * Whether `a` can see some part of `b`: a line from the middle of a to the middle or any inner corner of b, not
 * crossing a square with something taller than both of them standing in it.
 */
export function canSee(grid: Grid, blocks: BlockMap, a: Footprint, b: Footprint): boolean {
  const from = { x: a.x + a.size / 2, y: a.y + a.size / 2 };
  const eye = Math.max(a.elevation ?? 0, b.elevation ?? 0);
  const inset = 0.2;
  const targets = [
    { x: b.x + b.size / 2, y: b.y + b.size / 2 },
    { x: b.x + inset, y: b.y + inset }, { x: b.x + b.size - inset, y: b.y + inset },
    { x: b.x + inset, y: b.y + b.size - inset }, { x: b.x + b.size - inset, y: b.y + b.size - inset },
  ];
  const inside = (f: Footprint, x: number, y: number) => x >= f.x && x < f.x + f.size && y >= f.y && y < f.y + f.size;
  return targets.some((to) => {
    for (const c of lineCells(from, to)) {
      if (inside(a, c.x, c.y) || inside(b, c.x, c.y)) continue;
      if (c.x < 0 || c.y < 0 || c.x >= grid.cols || c.y >= grid.rows) continue;
      const h = blocks.sight[c.y * grid.cols + c.x];
      if (h > 0 && h > eye) return false;
    }
    return true;
  });
}

/** Every square a straight line passes through (a supercover walk), from point to point in square units. */
export function lineCells(p: { x: number; y: number }, q: { x: number; y: number }): Cell[] {
  const out: Cell[] = [];
  let x = Math.floor(p.x), y = Math.floor(p.y);
  const ex = Math.floor(q.x), ey = Math.floor(q.y);
  const dx = q.x - p.x, dy = q.y - p.y;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const tdx = dx === 0 ? Infinity : Math.abs(1 / dx), tdy = dy === 0 ? Infinity : Math.abs(1 / dy);
  let tx = dx === 0 ? Infinity : (sx > 0 ? x + 1 - p.x : p.x - x) * tdx;
  let ty = dy === 0 ? Infinity : (sy > 0 ? y + 1 - p.y : p.y - y) * tdy;
  out.push({ x, y });
  for (let guard = 0; (x !== ex || y !== ey) && guard < 1000; guard++) {
    if (Math.abs(tx - ty) < 1e-9) { x += sx; y += sy; tx += tdx; ty += tdy; }
    else if (tx < ty) { x += sx; tx += tdx; }
    else { y += sy; ty += tdy; }
    out.push({ x, y });
  }
  return out;
}

/**
 * Feet of movement to reach every square a creature can get to within `limitFeet`, going around walls and the
 * creatures in `occupied`. Diagonals cost one square, or 5/10/5… under the alternate rule. Keyed by the square
 * index (y × cols + x) of the creature's top-left corner.
 */
export function walkCosts(grid: Grid, blocks: BlockMap, from: Footprint, occupied: Footprint[], limitFeet: number): Map<number, number> {
  const { cols, rows } = grid, size = from.size;
  const blocked = new Uint8Array(cols * rows);
  for (let i = 0; i < blocked.length; i++) blocked[i] = blocks.move[i];
  for (const o of occupied) for (let y = o.y; y < o.y + o.size; y++) for (let x = o.x; x < o.x + o.size; x++) if (x >= 0 && y >= 0 && x < cols && y < rows) blocked[y * cols + x] = 1;
  const free = (x: number, y: number) => {
    if (x < 0 || y < 0 || x + size > cols || y + size > rows) return false;
    for (let j = y; j < y + size; j++) for (let i = x; i < x + size; i++) if (blocked[j * cols + i]) return false;
    return true;
  };
  const limit = Math.floor(limitFeet / grid.cellDistance);
  const out = new Map<number, number>();
  // Dijkstra over (square, odd diagonal so far); costs are small integers, so a bucket queue is enough.
  const best = new Int32Array(cols * rows * 2).fill(-1);
  const startNode = (from.y * cols + from.x) * 2;
  const buckets: number[][] = [[startNode]];
  best[startNode] = 0;
  for (let cost = 0; cost < buckets.length && cost <= limit; cost++) {
    for (const node of buckets[cost] ?? []) {
      if (best[node] !== cost) continue;
      const cell = node >> 1, odd = node & 1, x = cell % cols, y = Math.floor(cell / cols);
      if (!out.has(cell)) out.set(cell, cost * grid.cellDistance);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (!free(nx, ny)) continue;
        const diagonal = dx !== 0 && dy !== 0;
        // No squeezing between two blocked squares on a diagonal.
        if (diagonal && !free(x + dx, y) && !free(x, y + dy)) continue;
        const step = diagonal && grid.rule === 'alternate' ? (odd ? 2 : 1) : 1;
        const nOdd = diagonal && grid.rule === 'alternate' ? odd ^ 1 : odd;
        const next = ((ny * cols + nx) << 1) | nOdd, c = cost + step;
        if (c > limit || (best[next] !== -1 && best[next] <= c)) continue;
        best[next] = c;
        (buckets[c] ??= []).push(next);
      }
    }
  }
  return out;
}

/** Feet to walk from `from` to `to`, or null when the creature cannot get there within `limitFeet`. */
export function walkCost(grid: Grid, blocks: BlockMap, from: Footprint, to: Cell, occupied: Footprint[], limitFeet = 10000): number | null {
  if (to.x === from.x && to.y === from.y) return 0;
  return walkCosts(grid, blocks, from, occupied, limitFeet).get(to.y * grid.cols + to.x) ?? null;
}

/**
 * Squares an area covers. Cones and lines start at the caster's middle and point at `toward`; spheres and cubes are
 * centred on `toward`. A square counts when its middle is inside the shape.
 */
export function areaCells(grid: Grid, area: AreaShape, origin: Footprint, toward: Cell): Cell[] {
  const sq = area.size / grid.cellDistance;
  const ox = origin.x + origin.size / 2, oy = origin.y + origin.size / 2;
  const tx = toward.x + 0.5, ty = toward.y + 0.5;
  const out: Cell[] = [];
  let ax = tx - ox, ay = ty - oy;
  const len = Math.hypot(ax, ay) || 1;
  ax /= len; ay /= len;
  for (let y = 0; y < grid.rows; y++) for (let x = 0; x < grid.cols; x++) {
    const cx = x + 0.5, cy = y + 0.5;
    let inside = false;
    if (area.kind === 'sphere') inside = Math.hypot(cx - tx, cy - ty) <= sq;
    else if (area.kind === 'cube') inside = Math.abs(cx - tx) <= sq / 2 && Math.abs(cy - ty) <= sq / 2;
    else {
      const vx = cx - ox, vy = cy - oy;
      const along = vx * ax + vy * ay, across = Math.abs(vx * -ay + vy * ax);
      if (along <= 0 || along > sq + 1e-9) inside = false;
      else if (area.kind === 'cone') inside = across <= along / 2 + 1e-9;
      else inside = across <= (area.width ?? grid.cellDistance) / grid.cellDistance / 2 + 1e-9;
      // The caster's own squares are never in their cone or line.
      if (x >= origin.x && x < origin.x + origin.size && y >= origin.y && y < origin.y + origin.size) inside = false;
    }
    if (inside) out.push({ x, y });
  }
  return out;
}

/** Whether a creature's footprint touches any of the squares. */
export function touches(f: Footprint, cells: Cell[]): boolean {
  return cells.some((c) => c.x >= f.x && c.x < f.x + f.size && c.y >= f.y && c.y < f.y + f.size);
}
