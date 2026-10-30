import { describe, expect, it } from 'vitest';
import { evaluate, ExprError, hasDice, parse, references } from '../src/pack/expr';
import { scriptedRng } from '../src/rules/dice';

const scope = (vals: Record<string, number>) => (p: string) => vals[p];
const none = () => undefined;

describe('formulas', () => {
  it('does arithmetic with the usual precedence and the allowed functions', () => {
    expect(evaluate('1 + 2 * 3', none).total).toBe(7);
    expect(evaluate('(1 + 2) * 3', none).total).toBe(9);
    expect(evaluate('-2 - -3', none).total).toBe(1);
    expect(evaluate('floor((15 - 10) / 2)', none).total).toBe(2);
    expect(evaluate('floor((7 - 10) / 2)', none).total).toBe(-2);
    expect(evaluate('max(1, 4, 2) + min(3, 9) + abs(-2) + ceil(1.2) + round(2.5)', none).total).toBe(4 + 3 + 2 + 2 + 3);
    expect(evaluate('if(3 >= 2, 10, 20)', none).total).toBe(10);
    expect(evaluate('if(1 == 2, 10, 20)', none).total).toBe(20);
  });

  it('reads sheet values and refuses names it does not know, so a typo never reads as 0', () => {
    expect(evaluate('10 + @mod.DEX + @armor.bonus', scope({ 'mod.DEX': 2, 'armor.bonus': 3 })).total).toBe(15);
    expect(() => evaluate('@mod.DXE', scope({ 'mod.DEX': 2 }))).toThrow(/找不到 @mod.DXE/);
    expect(references('1d20 + @mod.STR + if(@prof > 0, @prof, 0)')).toEqual(['mod.STR', 'prof']);
  });

  it('rolls dice, keeps the highest or lowest, and writes each face into the breakdown', () => {
    const r = evaluate('1d20 + 5', none, scriptedRng([14]));
    expect(r.total).toBe(19);
    expect(r.text).toBe('1d20[14] + 5');
    const adv = evaluate('2d20kh1 + 3', none, scriptedRng([4, 17]));
    expect(adv.total).toBe(20);
    expect(adv.dice[0]).toMatchObject({ rolls: [4, 17], kept: [false, true], total: 17 });
    expect(adv.text).toBe('2d20kh1[~4~,17] + 3');
    expect(evaluate('4d6kh3', none, scriptedRng([1, 5, 3, 6])).total).toBe(14);
    expect(evaluate('2d20kl1', none, scriptedRng([4, 17])).total).toBe(4);
    expect(evaluate('d%', none, scriptedRng([73])).total).toBe(73);
    expect(evaluate('roll(@n, 6)', scope({ n: 3 }), scriptedRng([1, 2, 3])).total).toBe(6);
    expect(evaluate('roll(0, 6) + 1', none).total).toBe(1);
  });

  it('without an rng, previews dice at their average', () => {
    expect(evaluate('1d8 + 2', none).total).toBe(6.5);
    expect(evaluate('4d6kh3', none).total).toBe(10.5);
    expect(hasDice('1 + @a')).toBe(false);
    expect(hasDice('max(roll(1, 4), 2)')).toBe(true);
  });

  it('rejects anything outside the language with a message a pack author can act on', () => {
    for (const [src, msg] of [
      ['1 +', /不完整/], ['2 3', /多出了/], ['foo(1)', /沒有「foo」/], ['max()', /公式不完整|不該出現/],
      ['if(1, 2)', /3 個參數/], ['101d6', /1 到 100/], ['1d1', /2 到 1000/], ['3d6kh4', /保留/], ['1 / 0', /除以 0/],
      ['"x"', /看不懂/], ['a.b', /看不懂|沒有/], ['x'.repeat(501), /太長/], ['('.repeat(60) + '1' + ')'.repeat(60), /太多層/],
      ['constructor(1)', /沒有/], ['@__proto__', /找不到/],
    ] as const) expect(() => evaluate(src, scope({})), src).toThrow(msg);
    expect(() => parse('1d6 +')).toThrow(ExprError);
  });

  it('caps the dice one formula may throw', () => {
    expect(() => evaluate('100d6 + 100d6 + 100d6 + 100d6 + 1d6', none, () => 1)).toThrow(/太多/);
  });
});
