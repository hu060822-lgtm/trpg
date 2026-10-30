/**
 * Deterministic arithmetic for everything the browser and the server must both work out the same way: the bullet
 * patterns of a dodge, the weak-point line of a sword swing, the sway of a drawn bow. Only integer maths is used —
 * Math.sin and friends may differ in the last bit between JavaScript engines, so angles go through a fixed table.
 */

/** A seeded generator (mulberry32). Same seed, same numbers, on every engine. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
  return {
    /** An integer in [0, n). */
    int: (n: number) => n <= 0 ? 0 : next() % n,
    /** An integer in [lo, hi]. */
    range: (lo: number, hi: number) => lo + (next() % (hi - lo + 1)),
  };
}
export type Seeded = ReturnType<typeof seeded>;

/** Angles are 0–255 for a full turn; sin/cos come back scaled by 16384. */
export const ANGLE = 256;
export const UNIT = 16384;
const SIN: readonly number[] = [0,402,804,1205,1606,2006,2404,2801,3196,3590,3981,4370,4756,5139,5520,5897,6270,6639,7005,7366,7723,8076,8423,8765,9102,9434,9760,10080,10394,10702,11003,11297,11585,11866,12140,12406,12665,12916,13160,13395,13623,13842,14053,14256,14449,14635,14811,14978,15137,15286,15426,15557,15679,15791,15893,15986,16069,16143,16207,16261,16305,16340,16364,16379,16384,16379,16364,16340,16305,16261,16207,16143,16069,15986,15893,15791,15679,15557,15426,15286,15137,14978,14811,14635,14449,14256,14053,13842,13623,13395,13160,12916,12665,12406,12140,11866,11585,11297,11003,10702,10394,10080,9760,9434,9102,8765,8423,8076,7723,7366,7005,6639,6270,5897,5520,5139,4756,4370,3981,3590,3196,2801,2404,2006,1606,1205,804,402,0,-402,-804,-1205,-1606,-2006,-2404,-2801,-3196,-3590,-3981,-4370,-4756,-5139,-5520,-5897,-6270,-6639,-7005,-7366,-7723,-8076,-8423,-8765,-9102,-9434,-9760,-10080,-10394,-10702,-11003,-11297,-11585,-11866,-12140,-12406,-12665,-12916,-13160,-13395,-13623,-13842,-14053,-14256,-14449,-14635,-14811,-14978,-15137,-15286,-15426,-15557,-15679,-15791,-15893,-15986,-16069,-16143,-16207,-16261,-16305,-16340,-16364,-16379,-16384,-16379,-16364,-16340,-16305,-16261,-16207,-16143,-16069,-15986,-15893,-15791,-15679,-15557,-15426,-15286,-15137,-14978,-14811,-14635,-14449,-14256,-14053,-13842,-13623,-13395,-13160,-12916,-12665,-12406,-12140,-11866,-11585,-11297,-11003,-10702,-10394,-10080,-9760,-9434,-9102,-8765,-8423,-8076,-7723,-7366,-7005,-6639,-6270,-5897,-5520,-5139,-4756,-4370,-3981,-3590,-3196,-2801,-2404,-2006,-1606,-1205,-804,-402];
export const isin = (a: number) => SIN[((a % ANGLE) + ANGLE) % ANGLE];
export const icos = (a: number) => isin(a + ANGLE / 4);

/** The table angle (0–255) pointing from (x0, y0) to (x1, y1), y growing downwards. Binary search over the table, integer only. */
export function iatan2(dy: number, dx: number): number {
  if (dx === 0 && dy === 0) return 0;
  let best = 0, bestErr = Infinity;
  // 256 candidates is cheap and keeps this exact: pick the angle whose direction is closest by cross product.
  for (let a = 0; a < ANGLE; a++) {
    const c = icos(a), s = isin(a);
    if (c * dx + s * dy <= 0) continue;
    const err = Math.abs(c * dy - s * dx);
    if (err < bestErr) { bestErr = err; best = a; }
  }
  return best;
}

/** Integer square root (floor). */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}
