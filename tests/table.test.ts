import { describe, expect, it } from 'vitest';
import seed from '../config/world-seed.json';
import { RULES_V03 } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import type { AttributeCode } from '../src/rules/types';
import { applyWorld, createWorld, joinWorld, type WorldSeed } from '../src/world/engine';
import type { WorldActor, WorldCommand, WorldState } from '../src/world/types';
import { historyFor, viewFor } from '../src/world/view';

/** The table loop: speech, GM narration, and checks the GM calls and the player rolls. */
const R = RULES_V03;
const T0 = new Date('2026-10-28T12:00:00Z');
const attrs = (o: Partial<Record<AttributeCode, number>> = {}): Record<AttributeCode, number> =>
  ({ STR: 1, AGI: 1, VIT: 1, PRE: 1, PER: 1, INT: 1, WIL: 1, CHA: 1, INS: 1, SPR: 1, ...o });

const U1: WorldActor = { userId: 'u1', role: 'player' };
const U2: WorldActor = { userId: 'u2', role: 'player' };
const U3: WorldActor = { userId: 'u3', role: 'player' };
const MAIN: WorldActor = { userId: 'gm-main', role: 'gm' };
const SCENE: WorldActor = { userId: 'gm-ruins', role: 'gm' };

/** 灰鴉 and 夜鶯 in the ruins, 鷦鷯 in the plaza. */
function world(): WorldState {
  let s = createWorld(seed as WorldSeed, { 'gm-main': { role: 'main' }, 'gm-ruins': { role: 'scene', locations: ['ruins'] } });
  s = joinWorld(s, { id: 'crow', ownerUserId: 'u1', name: '灰鴉', attributes: attrs({ PER: 3 }), skills: { scouting: 2 } }, 'ruins');
  s = joinWorld(s, { id: 'nightingale', ownerUserId: 'u2', name: '夜鶯', attributes: attrs(), skills: {} }, 'ruins');
  s = joinWorld(s, { id: 'wren', ownerUserId: 'u3', name: '鷦鷯', attributes: attrs(), skills: {} }, 'plaza');
  return s;
}

const run = (s: WorldState, actor: WorldActor, command: WorldCommand, rolls: number[] = []) =>
  applyWorld(s, { actor, command }, R, scriptedRng(rolls), T0);
const seen = (s: WorldState, actor: WorldActor, events: ReturnType<typeof run>['events']) => historyFor(s, actor, events).map((e) => e.text);

describe('speech', () => {
  it('is heard by everyone at the location and nobody elsewhere', () => {
    const r = run(world(), U1, { type: 'say', characterId: 'crow', text: '鐘樓的門開著', mode: 'say' });
    expect(seen(r.state, U2, r.events)).toEqual(['灰鴉：「鐘樓的門開著」']);
    expect(seen(r.state, U3, r.events)).toEqual([]);
    expect(seen(r.state, SCENE, r.events)).toHaveLength(1);
  });

  it('a whisper is read only by the two of them; the others see that it happened', () => {
    const r = run(world(), U1, { type: 'whisper', characterId: 'crow', to: 'nightingale', text: '小心看守' });
    expect(seen(r.state, U2, r.events)).toContain('灰鴉 對 夜鶯 悄聲說：「小心看守」');
    expect(seen(r.state, U3, r.events)).toEqual([]);
    expect(seen(r.state, SCENE, r.events)).toEqual(['灰鴉 對 夜鶯 悄聲說：「小心看守」', '灰鴉 和 夜鶯 低聲交談']); // the GM hears everything in their scene
    expect(() => run(world(), U1, { type: 'whisper', characterId: 'crow', to: 'wren', text: 'x' })).toThrow(/不在這裡/);
  });

  it('refuses empty or overlong text, and speaking for someone else', () => {
    expect(() => run(world(), U1, { type: 'say', characterId: 'crow', text: '  ', mode: 'say' })).toThrow(/空的/);
    expect(() => run(world(), U1, { type: 'say', characterId: 'crow', text: 'x'.repeat(501), mode: 'say' })).toThrow(/500/);
    expect(() => run(world(), U2, { type: 'say', characterId: 'crow', text: 'x', mode: 'say' })).toThrow(/不能操作/);
  });

  it('a downed character can still talk out of character, but not in character', () => {
    const s = world();
    s.characters.crow.condition = 'dying';
    expect(() => run(s, U1, { type: 'say', characterId: 'crow', text: '救我', mode: 'say' })).toThrow(/無法行動/);
    expect(run(s, U1, { type: 'say', characterId: 'crow', text: '我先離開一下', mode: 'ooc' }).events[0].text).toBe('（灰鴉，場外）我先離開一下');
  });
});

describe('GM narration', () => {
  it('a scene GM narrates their own location only; a private description reaches only the named characters', () => {
    const r = run(world(), SCENE, { type: 'gmNarrate', locationId: 'ruins', text: '冷風從裂縫灌進來。' });
    expect(seen(r.state, U2, r.events)).toEqual(['冷風從裂縫灌進來。']);
    expect(() => run(world(), SCENE, { type: 'gmNarrate', locationId: 'plaza', text: 'x' })).toThrow(/指派/);
    expect(() => run(world(), U1, { type: 'gmNarrate', locationId: 'ruins', text: 'x' })).toThrow(/GM 權限/);
    const p = run(world(), MAIN, { type: 'gmNarrate', locationId: 'ruins', text: '你注意到地上有血跡。', to: ['crow'] });
    expect(seen(p.state, U1, p.events)).toEqual(['你注意到地上有血跡。']);
    expect(seen(p.state, U2, p.events)).toEqual([]);
  });
});

describe('checks', () => {
  const ask = (extra: Partial<Extract<WorldCommand, { type: 'gmRequestCheck' }>> = {}) => run(world(), SCENE, {
    type: 'gmRequestCheck', characterId: 'crow', label: '察看鐘樓', attribute: 'PER', skill: 'scouting', tn: 14, situational: 1, ...extra,
  });

  it('the GM calls it; only the player and GMs see what is pending; the player rolls with their own numbers', () => {
    const asked = ask();
    const pending = asked.state.characters.crow.pendingChecks!;
    expect(pending).toMatchObject([{ label: '察看鐘樓', attribute: 'PER', skill: 'scouting', tn: 14, situational: 1, highRisk: false, secret: false }]);
    expect(seen(asked.state, U1, asked.events)[0]).toBe('GM 要求你進行檢定：察看鐘樓（感知＋偵查，難度 14（普通），情境 +1）');
    expect(viewFor(asked.state, U2).characters.crow.pendingChecks).toBeUndefined();
    expect(viewFor(asked.state, U1).characters.crow.pendingChecks).toHaveLength(1);
    // d20 9 + PER 3 + scouting 2 + 1 = 15 against 14.
    const rolled = run(asked.state, U1, { type: 'rollCheck', characterId: 'crow', checkId: pending[0].id }, [9]);
    const result = rolled.events.find((e) => e.kind === 'checkResult')!;
    expect(result).toMatchObject({ visibility: 'scene', data: { total: 15, tn: 14, success: true } });
    expect(result.text).toBe('灰鴉擲「察看鐘樓」：d20=9，合計 15 對 14，普通成功');
    expect(rolled.state.characters.crow.pendingChecks).toEqual([]);
    expect(() => run(rolled.state, U1, { type: 'rollCheck', characterId: 'crow', checkId: pending[0].id }, [9])).toThrow(/沒有這個/);
  });

  it('only the owner or a GM of the scene rolls it', () => {
    const asked = ask();
    const id = asked.state.characters.crow.pendingChecks![0].id;
    expect(() => run(asked.state, U2, { type: 'rollCheck', characterId: 'crow', checkId: id }, [9])).toThrow(/不能操作/);
    expect(run(asked.state, SCENE, { type: 'rollCheck', characterId: 'crow', checkId: id }, [9]).events.at(-1)!.text).toMatch(/^GM 代 灰鴉擲/);
  });

  it('a secret check tells the player that they rolled, and the result only to GMs', () => {
    const asked = ask({ secret: true });
    expect(seen(asked.state, U2, asked.events)).toEqual([]);
    const id = asked.state.characters.crow.pendingChecks![0].id;
    const rolled = run(asked.state, U1, { type: 'rollCheck', characterId: 'crow', checkId: id }, [2]);
    expect(seen(rolled.state, U1, rolled.events)).toEqual(['灰鴉擲了「察看鐘樓」，結果由 GM 掌握']);
    expect(seen(rolled.state, MAIN, rolled.events).join()).toMatch(/暗骰.*失敗/);
  });

  it('catastrophe needs the high-risk flag set before the roll (rules v0.3 §2.4)', () => {
    const low = ask({ tn: 23, situational: 0 });
    const r1 = run(low.state, U1, { type: 'rollCheck', characterId: 'crow', checkId: low.state.characters.crow.pendingChecks![0].id }, [2]);
    expect(r1.events.at(-1)!.data.tier).toBe('failure');
    const high = ask({ tn: 23, situational: 0, highRisk: true });
    const r2 = run(high.state, U1, { type: 'rollCheck', characterId: 'crow', checkId: high.state.characters.crow.pendingChecks![0].id }, [2]);
    expect(r2.events.at(-1)!.data.tier).toBe('catastrophe');
  });

  it('validates the call: TN on the ladder, a real skill, modifier within the cap, a scene the GM runs', () => {
    expect(() => ask({ tn: 15 })).toThrow(/難度/);
    expect(() => ask({ skill: 'flying' })).toThrow(/技能/);
    expect(() => ask({ situational: 6 })).toThrow(/±5/);
    expect(() => run(world(), SCENE, { type: 'gmRequestCheck', characterId: 'wren', label: 'x', attribute: 'PER', skill: null, tn: 11 })).toThrow(/指派/);
    expect(() => run(world(), U1, { type: 'gmRequestCheck', characterId: 'crow', label: 'x', attribute: 'PER', skill: null, tn: 11 })).toThrow(/GM 權限/);
  });

  it('a GM can cancel a pending check', () => {
    const asked = ask();
    const id = asked.state.characters.crow.pendingChecks![0].id;
    const r = run(asked.state, MAIN, { type: 'gmCancelCheck', characterId: 'crow', checkId: id });
    expect(r.state.characters.crow.pendingChecks).toEqual([]);
    expect(seen(r.state, U1, r.events)).toEqual(['GM 取消了「察看鐘樓」檢定']);
  });
});
