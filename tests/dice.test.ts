import { describe, expect, it } from 'vitest';
import { body, cleanLaunch, reading, restingOn, settle, shapeOf, throwDie, tossBody } from '../src/dice/physics';

describe('dice tray physics', () => {
  it('builds every die with the right faces, opposite faces adding up as on real dice', () => {
    for (const sides of [6, 8, 10, 12, 20]) {
      const sh = shapeOf(sides);
      expect(sh.faces).toHaveLength(sides);
      expect([...sh.values].sort((a, b) => a - b)).toEqual(Array.from({ length: sides }, (_, i) => i + 1));
      sh.normals.forEach((n, i) => {
        const opp = sh.normals.findIndex((m) => n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < -0.999);
        expect(sh.values[i] + sh.values[opp]).toBe(sides + 1);
      });
    }
    expect(shapeOf(4).faces).toHaveLength(4);
  });

  it('a throw always comes to rest within a few seconds, and replaying it lands on the same face', () => {
    for (let k = 0; k < 120; k++) {
      const sides = [4, 6, 8, 10, 12, 20][k % 6];
      const toss = { seed: 1000 + k * 7919, lane: k % 5, ...(k % 2 ? { launch: cleanLaunch({ hand: [-2 + (k % 4), 1 - (k % 3)], v: [12 - (k % 9), (k % 7) - 3] })! } : {}) };
      const value = throwDie(sides, toss);
      const b = settle(tossBody(sides, toss));
      expect(b.asleep).toBe(true);
      expect(reading(b)).toBe(value);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(sides);
    }
  });

  it('the flick changes the throw, and a doctored flick is clamped to the tray', () => {
    expect(cleanLaunch({ hand: [99, -99], v: [500, 0] })).toEqual({ hand: [4, -2], v: [22, 0] });
    expect(cleanLaunch({ hand: [0, 0], v: [NaN, 1] })).toBeUndefined();
    expect(cleanLaunch('nope')).toBeUndefined();
    const faces = new Set<number>();
    for (let k = 0; k < 40; k++) faces.add(throwDie(20, { seed: 5, lane: 0, launch: { hand: [-3, 0], v: [6 + k * 0.4, 0] } }));
    expect(faces.size).toBeGreaterThan(5);
  });

  it('can lay a die down showing a given face', () => {
    for (const sides of [4, 6, 8, 10, 12, 20]) {
      const b = body(sides, [0, 0, 1]);
      restingOn(b, 3, 0.7);
      expect(reading(b)).toBe(3);
    }
  });
});
