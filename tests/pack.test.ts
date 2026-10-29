import { readFileSync, readdirSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildPack, checkFormula, computeSheet, natural, PackError, rollOnSheet, validateCharacter } from '../src/pack/pack';
import { readPackDir, readPackZip } from '../src/pack/zip';
import { scriptedRng } from '../src/rules/dice';

const DIR = 'packs/simple-d20';
const files = () => Object.fromEntries(readdirSync(DIR).map((f) => [f.slice(0, -5), JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'))]));
const problemsOf = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof PackError) return e.problems.map((p) => `${p.file}${p.path} ${p.message}`); throw e; }
  return [];
};
const pack = readPackDir(DIR);
const hero = { scores: { body: 2, agility: 2, mind: 1, presence: 1 }, ranks: { melee: 2, stealth: 1 }, inputs: { armor: 1 } };

describe('the example pack', () => {
  it('loads and works out a sheet, naming each part of every sum', () => {
    const sheet = computeSheet(pack, hero);
    expect(sheet.shown.hp).toEqual({ value: 14, text: '8 + 2 * 體魄 2 + 2 * 等級 1' });
    expect(sheet.shown.defense).toEqual({ value: 13, text: '10 + 靈巧 2 + 護甲加值 1' });
  });

  it('rolls checks and attacks on the sheet, with advantage and natural results', () => {
    const sheet = computeSheet(pack, hero);
    const f = checkFormula(pack, { skill: 'stealth' }, 'advantage');
    expect(f).toBe('(2d20kh1) + @score.agility + @rank.stealth');
    const r = rollOnSheet(pack, sheet, f, scriptedRng([3, 20]));
    expect(r.total).toBe(23);
    expect(r.text).toBe('2d20kh1[~3~,20] + 靈巧 2 + 潛行 1');
    expect(natural(pack, r)).toBe('critical');
    expect(natural(pack, rollOnSheet(pack, sheet, checkFormula(pack, { attribute: 'mind' }), scriptedRng([1])))).toBe('fumble');
    const atk = pack.actions.find((a) => a.id === 'melee_attack')!;
    expect(rollOnSheet(pack, sheet, atk.roll, scriptedRng([10])).total).toBe(14);
  });

  it('holds new characters to the creation budget, and later ones only to the limits', () => {
    expect(validateCharacter(pack, hero, true)).toEqual([]);
    expect(validateCharacter(pack, { ...hero, scores: { body: 4, agility: 4, mind: 0, presence: 0 } }, true)).toEqual(['屬性點數用了 8，上限 6']);
    expect(validateCharacter(pack, { ...hero, ranks: { melee: 3 } }, true)).toEqual(['近戰的等級要在 0 到 2 之間']);
    expect(validateCharacter(pack, { ...hero, ranks: { melee: 3 } }, false)).toEqual([]);
    expect(validateCharacter(pack, { ...hero, scores: { body: 9 } }, false)).toContain('體魄要在 0 到 4 之間');
    expect(validateCharacter(pack, { ...hero, ranks: { cooking: 1 } }, false)).toContain('沒有「cooking」這個技能');
  });
});

describe('pack validation', () => {
  it('collects every problem with its file and place', () => {
    const f = files();
    f.manifest = { ...f.manifest, id: 'Bad Id', version: 'one' };
    f.skills = { list: [...f.skills.list, { id: 'melee', name: '重複', attribute: 'luck' }] };
    f.sheet = { ...f.sheet, derived: [...f.sheet.derived, { id: 'speed', label: '速度', formula: '@score.agilty + 1' }] };
    f.extra = {};
    const problems = problemsOf(() => buildPack(f));
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('extra.json 不認識的檔案'),
      expect.stringContaining('manifest.json.id 只能用小寫英數字'),
      expect.stringContaining('manifest.json.version'),
      expect.stringContaining('skills.json.list[8].id id「melee」重複了'),
      expect.stringContaining('skills.json.list[8].attribute 沒有「luck」這個屬性'),
    ]));
  });

  it('checks formulas: syntax, unknown values and circular derived values', () => {
    const f = files();
    f.sheet = { ...f.sheet, derived: [{ id: 'a', label: 'A', formula: '@b + 1' }, { id: 'b', label: 'B', formula: '@a + 1' }, { id: 'c', label: 'C', formula: '@score.agilty' }] };
    f.actions = { list: [{ id: 'x', label: 'X', roll: '1d20 +' }] };
    const problems = problemsOf(() => buildPack(f));
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('計算繞成一圈：a → b → a'),
      expect.stringContaining('「@score.agilty」不存在'),
      expect.stringContaining('actions.json.list[0].roll 公式錯誤'),
    ]));
  });

  it('needs a manifest and checks', () => {
    expect(problemsOf(() => buildPack({}))).toEqual(expect.arrayContaining([expect.stringContaining('manifest.json'), expect.stringContaining('checks.json')]));
  });
});

describe('pack zips', () => {
  const zipOf = (entries: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])));
  const asText = () => Object.fromEntries(readdirSync(DIR).map((f) => [f, readFileSync(`${DIR}/${f}`, 'utf8')]));

  it('reads a zip, also when everything sits inside one folder', () => {
    expect(readPackZip(zipOf(asText())).manifest.id).toBe('simple-d20');
    const wrapped = Object.fromEntries(Object.entries(asText()).map(([k, v]) => [`simple-d20/${k}`, v]));
    expect(readPackZip(zipOf({ ...wrapped, 'simple-d20/assets/token.png': 'x' })).manifest.id).toBe('simple-d20');
  });

  it('refuses scripts, bad paths, broken JSON and things that are not zips', () => {
    expect(problemsOf(() => readPackZip(zipOf({ ...asText(), 'hack.js': 'alert(1)' })))[0]).toContain('只能有 JSON');
    expect(problemsOf(() => readPackZip(zipOf({ ...asText(), 'assets/run.exe': 'x' })))[0]).toContain('只能放圖片');
    expect(problemsOf(() => readPackZip(zipOf({ ...asText(), '../evil.json': '{}' })))[0]).toContain('路徑不合法');
    expect(problemsOf(() => readPackZip(zipOf({ ...asText(), 'skills.json': '{oops' })))[0]).toContain('JSON 格式錯誤');
    expect(problemsOf(() => readPackZip(strToU8('not a zip')))[0]).toContain('不是有效的 zip');
  });
});
