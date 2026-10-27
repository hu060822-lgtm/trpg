// Monte Carlo fights between starting characters and sample monsters. Writes reports/combat-sim-v0.3.md.
// Class features are not implemented yet, so this measures the base combat numbers only.
import { writeFileSync } from 'node:fs';
import { CLASSES, exampleBuild, maxHp } from '../src/character/create';
import { autopilot } from '../src/combat/autopilot';
import { COMBAT_V03, startCombat, submitAction } from '../src/combat/engine';
import type { CombatantSetup, CombatState } from '../src/combat/types';
import { RULES_V03 as R } from '../src/rules/config';
import { randomRng } from '../src/rules/dice';
import type { AttributeCode } from '../src/rules/types';

const N = Number(process.argv[2] ?? 2000);
const now = new Date('2026-10-27T12:00:00Z');
const wolfAttrs: Record<AttributeCode, number> = { STR: 2, AGI: 2, VIT: 2, PRE: 1, PER: 2, INT: 0, WIL: 1, CHA: 0, INS: 1, SPR: 0 };
const wolf = (id: string, band = 1): CombatantSetup => ({
  id, name: '灰狼', side: 'beasts', controller: 'gm', attributes: wolfAttrs, skills: { melee: 2, dodge: 1 },
  maxHp: 10, band, weaponId: 'claws', armorId: 'hide',
});
const gear: Record<string, [string, string]> = {
  guardian: ['sword', 'chain'], duelist: ['sword', 'leather'], ranger: ['bow', 'leather'], scout: ['dagger', 'leather'],
  shadow: ['dagger', 'leather'], survivor: ['sword', 'leather'], commander: ['sword', 'leather'],
};
function pc(classId: string, id = classId, band = 0): CombatantSetup {
  const b = exampleBuild(classId, R);
  const [weaponId, armorId] = gear[classId] ?? ['dagger', 'none'];
  return {
    id, name: b.name, side: 'party', controller: `u-${id}`, characterId: id, attributes: b.attributes, skills: b.skills,
    maxHp: maxHp(b.attributes, R), band, weaponId, armorId, medkits: classId === 'medic' ? 1 : 0,
  };
}

interface Tally { wins: number; rounds: number; downed: number; dead: number; dyingAtEnd: number }
function run(setups: () => CombatantSetup[]): Tally {
  const t: Tally = { wins: 0, rounds: 0, downed: 0, dead: 0, dyingAtEnd: 0 };
  for (let i = 0; i < N; i++) {
    let s: CombatState = startCombat({ id: `sim${i}`, combatants: setups(), rules: R, rng: randomRng, now });
    let k = 0;
    while (s.status === 'active' && k++ < 500) {
      const c = s.turn!.combatantId;
      const actor = s.combatants[c].controller === 'gm' ? { userId: 'gm', role: 'gm' as const } : { userId: s.combatants[c].controller, role: 'player' as const };
      s = submitAction(s, { actionId: `${k}`, actor, combatantId: c, round: s.round, action: autopilot(s) }, R, randomRng, now).state;
    }
    const party = Object.values(s.combatants).filter((c) => c.side === 'party');
    if (s.winner === 'party') t.wins++;
    t.rounds += s.round;
    if (s.events.some((e) => e.kind === 'dying' && party.some((p) => p.id === e.combatantId))) t.downed++;
    if (party.some((p) => p.condition === 'dead')) t.dead++;
    if (party.some((p) => p.condition === 'dying')) t.dyingAtEnd++;
  }
  return t;
}
const pct = (x: number) => `${((x / N) * 100).toFixed(1)}%`;
const row = (label: string, t: Tally) =>
  `| ${label} | ${pct(t.wins)} | ${(t.rounds / N).toFixed(1)} | ${pct(t.downed)} | ${pct(t.dead)} | ${pct(t.dyingAtEnd)} |`;

const lines = [
  `# 戰鬥模擬（規則 v${R.version}，戰鬥設定 ${COMBAT_V03.status}）`, '',
  `由 \`npm run sim:combat\` 產生，每組隨機對戰 ${N} 場。雙方都用同一套簡單 AI（靠近、打血最少的敵人、會救瀕死隊友）。`,
  '**職業特性與法術尚未實作**，所以術士、通靈者這類職業在這裡只用短刀戰鬥，數字不代表職業強弱。這份報告只用來觀察基礎戰鬥數值，不是平衡結論。', '',
  '「倒下」＝至少一名隊員曾進入瀕死；「死亡」＝戰鬥中有隊員永久死亡；「結束時瀕死」＝戰鬥結束時還有隊員瀕死，需要戰後救援。', '',
  '## 單人對一隻灰狼', '',
  '| 職業（範例配置） | 勝率 | 平均輪數 | 倒下 | 死亡 | 結束時瀕死 |', '|---|---:|---:|---:|---:|---:|',
  ...CLASSES.map((c) => row(`${c.name}（${(gear[c.id] ?? ['dagger', 'none']).join('＋')}）`, run(() => [pc(c.id), wolf('w1')]))),
  '', '## 小隊對狼群', '',
  '| 組合 | 勝率 | 平均輪數 | 倒下 | 死亡 | 結束時瀕死 |', '|---|---:|---:|---:|---:|---:|',
  row('守衛者＋醫療師 對 2 隻灰狼', run(() => [pc('guardian', 'g'), pc('medic', 'm'), wolf('w1'), wolf('w2')])),
  row('守衛者＋遊獵者＋醫療師 對 3 隻灰狼', run(() => [pc('guardian', 'g'), pc('ranger', 'r', 1), pc('medic', 'm'), wolf('w1', 2), wolf('w2', 2), wolf('w3', 3)])),
  row('斥候＋潛行者 對 2 隻灰狼', run(() => [pc('scout', 's'), pc('shadow', 'h'), wolf('w1'), wolf('w2')])),
  '',
];
writeFileSync('reports/combat-sim-v0.3.md', lines.join('\n'));
console.log(lines.join('\n'));
