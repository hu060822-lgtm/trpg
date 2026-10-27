// Terminal walkthrough: create a starting character and resolve a few checks.
import { createCharacter, exampleBuild } from '../src/character/create';
import { performCheck } from '../src/rules/check';
import { DEFAULT_RULES as C } from '../src/rules/config';
import { randomRng } from '../src/rules/dice';

const hero = createCharacter({ ...exampleBuild('scout', C), name: '灰鴉' }, C);
console.log(`建立角色 ${hero.name}（${hero.classId}）HP ${hero.hp}/${hero.maxHp}  id=${hero.id}`);

const tn = (key: string) => C.difficulties.find((d) => d.key === key)!.tn;
const actions = [
  { label: '潛入倉庫（敏捷＋潛行，普通）', input: { attribute: hero.attributes.AGI, skill: hero.skills.stealth, tn: tn('normal') } },
  { label: '在黑暗中找埋伏者（感知＋偵查，困難，劣勢）', input: { attribute: hero.attributes.PER, skill: hero.skills.scouting, tn: tn('hard'), mode: 'disadvantage' as const } },
  { label: '跳過崩塌的橋（敏捷＋攀爬，困難，高風險）', input: { attribute: hero.attributes.AGI, skill: hero.skills.climbing ?? 0, tn: tn('hard'), highRisk: true } },
  { label: '說服領主交出神器（魅力＋交涉，傳奇）', input: { attribute: hero.attributes.CHA, skill: hero.skills.negotiation ?? 0, tn: tn('legendary') } },
];
for (const a of actions) {
  const out = performCheck(a.input, randomRng, C);
  if (out.kind === 'impossible') console.log(`- ${a.label}：以目前條件做不到，需要工具、情報或協助`);
  else if (out.kind === 'skill-required') console.log(`- ${a.label}：這個行動需要受過訓練`);
  else if (out.kind === 'auto') console.log(`- ${a.label}：免擲骰，自動普通成功`);
  else {
    const r = out.result;
    console.log(`- ${a.label}：d20 [${r.rolls.d20.join(', ')}] → 總值 ${r.total} vs TN ${r.input.tn}（差距 ${r.margin}）→ ${r.tierName}`);
  }
}
