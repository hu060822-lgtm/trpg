import { readFileSync, readdirSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildPack, checkBonus, checkFormula, computeSheet, mergePackFiles, natural, PackError, rollOnSheet, validateCharacter } from '../src/pack/pack';
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

describe('the 5E SRD pack and its character builder', () => {
  const srd = readPackDir('packs/srd-5e');
  // A level 1 dwarf fighter: soldier background, standard array.
  const fighter = {
    method: 'standard',
    scores: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
    ranks: {}, inputs: { level: 1, armor_base: 16, armor_dex_cap: 0, shield: 2 },
    choices: { class: 'fighter', background: 'soldier', species: 'dwarf' },
    picks: { 'class.skills': ['perception', 'survival'], 'class.style': ['defense'], 'background.asi': { str: 2, con: 1 } },
  };

  it('builds, with a builder for class, background and species', () => {
    expect(srd.builder.map((s) => s.id)).toEqual(['class', 'background', 'species']);
    expect(srd.builder[0].options).toHaveLength(12);
    expect(srd.manifest.license).toBe('CC-BY-4.0');
  });

  it('a builder character is valid and its sheet adds up the class, background and species', () => {
    expect(validateCharacter(srd, fighter, true)).toEqual([]);
    const s = computeSheet(srd, fighter);
    expect(s.values.get('score.str')).toBe(17);
    expect(s.shown['score.str'].text).toBe('15 + 2');
    expect(s.values.get('prof')).toBe(2);
    expect(s.values.get('hp')).toBe(10 + 2 + 1); // d10 + CON 15 (+2) + dwarven toughness
    expect(s.values.get('ac')).toBe(18);
    expect(s.values.get('rank.athletics')).toBe(1);
    expect(s.values.get('rank.perception')).toBe(1);
    expect(s.values.get('see_dark')).toBe(120);
    expect(s.shown.see_dark.hidden).toBeUndefined();
    expect(s.shown.spell_dc.hidden).toBe(true);
    expect(s.hiddenActions).toEqual(['spell']);
    expect(s.features.every((f) => f.level <= 1)).toBe(true);
    expect(s.features.map((f) => f.name)).toContain('戰鬥風格：防禦');
    expect(computeSheet(srd, { ...fighter, inputs: { ...fighter.inputs, level: 5 } }).features.length).toBeGreaterThan(s.features.length);
  });

  it('rolls saving throws with proficiency only where the class gives it', () => {
    const s = computeSheet(srd, fighter);
    const save = (attr: string) => rollOnSheet(srd, s, checkFormula(srd, { attribute: attr, extra: 'save' }), scriptedRng([10])).total;
    expect(save('str')).toBe(10 + 3 + 2);
    expect(save('dex')).toBe(10 + 1);
    expect(checkBonus(srd, s, { attribute: 'con', extra: 'save' })).toBe(4);
    expect(checkBonus(srd, s, { skill: 'perception' })).toBe(1 + 2);
    expect(checkBonus(srd, s, { skill: 'arcana' })).toBe(-1);
    expect(() => checkFormula(srd, { attribute: 'str', extra: 'luck' })).toThrow('沒有「luck」這種檢定');
  });

  it('asks for every step and choice, from the allowed pool, the right number of times', () => {
    expect(validateCharacter(srd, { ...fighter, choices: { class: 'fighter', background: 'soldier' } }, true)).toContain('還沒選種族');
    expect(validateCharacter(srd, { ...fighter, picks: { ...fighter.picks, 'class.skills': ['perception'] } }, true))
      .toContain('戰士的「選 2 項技能」要選 2 個（現在 1 個）');
    expect(validateCharacter(srd, { ...fighter, picks: { ...fighter.picks, 'class.skills': ['perception', 'arcana'] } }, true).join())
      .toContain('不能選奧秘');
    expect(validateCharacter(srd, { ...fighter, picks: { ...fighter.picks, 'background.asi': { str: 2, con: 2 } } }, true).join())
      .toContain('要照這幾種分法之一');
    expect(validateCharacter(srd, { ...fighter, picks: { ...fighter.picks, 'background.asi': { str: 1, int: 2 } } }, true).join())
      .toContain('只能加在');
  });

  it('a skill already given by the background must be swapped for another', () => {
    const twice = { ...fighter, picks: { ...fighter.picks, 'class.skills': ['athletics', 'survival'] } };
    expect(validateCharacter(srd, twice, true)).toEqual([expect.stringContaining('運動已經從別的地方熟練了')]);
  });

  it('rogue expertise doubles proficiency, but only in skills the rogue already has', () => {
    const rogue = {
      method: 'standard', scores: { str: 8, dex: 15, con: 13, int: 14, wis: 12, cha: 10 }, ranks: {}, inputs: {},
      choices: { class: 'rogue', background: 'criminal', species: 'halfling' },
      picks: { 'class.skills': ['acrobatics', 'perception', 'deception', 'investigation'], 'class.expertise': ['stealth', 'perception'], 'background.asi': { dex: 2, int: 1 } },
    };
    expect(validateCharacter(srd, rogue, true)).toEqual([]);
    expect(computeSheet(srd, rogue).values.get('rank.stealth')).toBe(2);
    expect(computeSheet(srd, rogue).values.get('passive_perception')).toBe(10 + 1 + 4);
    expect(validateCharacter(srd, { ...rogue, picks: { ...rogue.picks, 'class.expertise': ['stealth', 'arcana'] } }, true).join())
      .toContain('奧秘還不熟練');
  });

  it('holds starting scores to the chosen method', () => {
    expect(validateCharacter(srd, { ...fighter, scores: { ...fighter.scores, int: 15 } }, true)).toContain('標準陣列要把 15、14、13、12、10、8 各用一次');
    const bought = { ...fighter, method: 'pointbuy', scores: { str: 15, dex: 14, con: 14, int: 8, wis: 10, cha: 10 } };
    expect(validateCharacter(srd, bought, true)).toEqual([]);
    expect(validateCharacter(srd, { ...bought, scores: { ...bought.scores, cha: 12 } }, true)).toContain('屬性點數用了 29，上限 27');
    expect(validateCharacter(srd, { ...bought, scores: { ...bought.scores, str: 16 } }, true)).toContain('力量 16 不能用點數購買');
    expect(validateCharacter(srd, { ...fighter, method: undefined }, true).join()).toContain('請選擇屬性的決定方式');
    expect(validateCharacter(srd, { ...fighter, method: 'rolled', scores: { ...fighter.scores, str: 19 } }, true).join()).toContain('力量加上加值後是 21，上限 20');
  });
});

describe('add-on packs', () => {
  it('merge into their base by id, and the result builds as a new pack', () => {
    const base = Object.fromEntries(readdirSync('packs/srd-5e').map((f) => [f.slice(0, -5), JSON.parse(readFileSync(`packs/srd-5e/${f}`, 'utf8'))]));
    const addon = {
      manifest: { id: 'srd-plus', name: '5E 追加', version: '0.1', license: 'CC-BY-4.0', extends: `${base.manifest.id}@${base.manifest.version}`, attribution: '追加內容' },
      builder: { steps: [{ id: 'background', label: '背景', options: [{ id: 'farmer', name: '農夫', grants: { ranks: { animal_handling: 1, nature: 1 } }, choices: [{ id: 'asi', label: '屬性', kind: 'bonus', from: ['str', 'con', 'wis'], patterns: [[2, 1], [1, 1, 1]] }] }] }] },
    };
    expect(problemsOf(() => buildPack(addon))).toContainEqual(expect.stringContaining('extends'));
    const merged = buildPack(mergePackFiles(base, addon, `${base.manifest.id}@${base.manifest.version}`));
    expect(merged.manifest.id).toBe('srd-plus');
    expect(merged.manifest.basedOn).toBe('srd-5e@1.0.0');
    const bg = merged.builder.find((s) => s.id === 'background')!;
    expect(bg.options.map((o) => o.id)).toEqual(['acolyte', 'criminal', 'sage', 'soldier', 'farmer']);
    expect(merged.builder.find((s) => s.id === 'class')!.options).toHaveLength(12);
    expect(merged.skills).toHaveLength(18);
    expect(merged.manifest.attribution).toContain('追加內容');
  });
});
