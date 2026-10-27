// Writes reports/sim-<version>.md: exact success rates for every bonus × difficulty, plus starting builds per class.
import { writeFileSync } from 'node:fs';
import { ATTRIBUTES, CLASSES, SKILLS, exampleBuild } from '../src/character/create';
import { RULES_V02, RULES_V03 } from '../src/rules/config';
import { distribution } from '../src/sim/enumerate';
import type { RulesConfig, RollMode } from '../src/rules/types';

const version = process.argv[2] ?? '0.3';
const config: RulesConfig = version === '0.2' ? RULES_V02 : RULES_V03;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const cell = (bonus: number, tn: number, mode: RollMode = 'normal') => {
  const d = distribution({ attribute: 0, skill: bonus, tn, mode }, config);
  return d.preCheck === 'auto' ? '自動' : d.preCheck === 'impossible' ? '不可能' : pct(d.pSuccess);
};

const lines: string[] = [];
const header = `| 加值 | ${config.difficulties.map((d) => `${d.name} ${d.tn}`).join(' | ')} |`;
const sep = `|---:|${config.difficulties.map(() => '---:').join('|')}|`;

lines.push(`# 判定成功率報告（規則 v${config.version}）`, '');
lines.push('由 `npm run sim` 產生，逐一枚舉所有骰值組合，經過正式規則引擎計算，不是抽樣估計。加值＝屬性＋技能，情境修正 0。', '');

for (const mode of ['normal', 'advantage', 'disadvantage'] as const) {
  lines.push(`## ${{ normal: '一般', advantage: '優勢', disadvantage: '劣勢' }[mode]}`, '', header, sep);
  for (let b = 0; b <= config.attribute.max + config.skill.max; b++) {
    lines.push(`| ${b} | ${config.difficulties.map((d) => cell(b, d.tn, mode)).join(' | ')} |`);
  }
  lines.push('');
}

lines.push('## 各職業起始角色', '');
lines.push('範例配置：兩項核心屬性 3、兩項核心技能 4（創角上限）。「本職」＝核心屬性＋核心技能；「非本職」＝屬性 1、技能 0。', '');
lines.push(`| 職業 | 本職檢定 | 加值 | ${config.difficulties.slice(0, 4).map((d) => `${d.name} ${d.tn}`).join(' | ')} |`);
lines.push(`|---|---|---:|${config.difficulties.slice(0, 4).map(() => '---:').join('|')}|`);
const attrName = (c: string) => ATTRIBUTES.find((a) => a.code === c)!.name;
const skillName = (id: string) => SKILLS.find((s) => s.id === id)!.name;
for (const cls of CLASSES) {
  const b = exampleBuild(cls.id, config);
  const attr = cls.coreAttributes[0];
  const skill = cls.coreSkills[0];
  const bonus = b.attributes[attr] + (b.skills[skill] ?? 0);
  lines.push(`| ${cls.name} | ${attrName(attr)}＋${skillName(skill)} | ${bonus} | ${config.difficulties.slice(0, 4).map((d) => cell(bonus, d.tn)).join(' | ')} |`);
}
lines.push(`| （任何職業） | 非本職 | 1 | ${config.difficulties.slice(0, 4).map((d) => cell(1, d.tn)).join(' | ')} |`);
lines.push('');

const out = `reports/sim-v${config.version}.md`;
writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out}`);
