import { describe, expect, it } from 'vitest';
import { body, launch, reading, restingOn, shapeOf, step, steer, tumble } from '../client/src/combat/dicePhysics';

const TRAY = { w: 10, d: 6 };

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

  it('thrown dice always stop, within a few seconds, on the faces the server rolled', () => {
    for (let k = 0; k < 120; k++) {
      const sides = [4, 6, 8, 10, 12, 20][k % 6];
      const dice = [body(sides, [-3, 1, 2.5], tumble(k)), body(20, [-3, -1, 2.5], tumble(k + 500))];
      launch(dice[0], [8 + (k % 7), -2 + (k % 5), 3], [(k % 11) - 5, 9, k % 3]);
      launch(dice[1], [10, 1, 2], [3, -7, 4]);
      for (let i = 0; i < 20; i++) step(dice, TRAY);
      const want = [1 + (k % sides), 1 + ((k * 7) % 20)];
      steer(dice, TRAY, want);
      let n = 0;
      while (dice.some((b) => !b.asleep) && n < 240 * 5) { step(dice, TRAY); n++; }
      expect(dice.map(reading)).toEqual(want);
      expect(n).toBeLessThan(240 * 4);
    }
  });

  it('can lay a die down showing a given face', () => {
    for (const sides of [4, 6, 8, 10, 12, 20]) {
      const b = body(sides, [0, 0, 1]);
      restingOn(b, 3, 0.7);
      expect(reading(b)).toBe(3);
    }
  });
});
