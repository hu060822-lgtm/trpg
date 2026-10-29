/**
 * Dodge balance check with bots, not people. Runs every pattern in the 5E pack at every Model B tier with three
 * kinds of bot and reports the hits and the damage factor they end up with. Bots are not players: a still bot is a
 * floor (someone who does nothing), a random bot is a careless player, and the greedy bot only looks a few ticks
 * ahead. Real players will land somewhere between, so treat this as a sanity check, not a balance proof.
 *
 *   npx tsx scripts/dodge-sim.ts [seeds=30]   → writes reports/dodge-balance.md
 */
import { writeFileSync } from 'node:fs';
import { DodgeSim } from '../src/encounter/dodge';
import { DEFAULT_RULES, factorFor } from '../src/encounter/rules';
import { seeded } from '../src/encounter/rng';
import type { DodgeSetup, PatternDef } from '../src/encounter/types';
import { readPackDir } from '../src/pack/zip';

const SEEDS = Number(process.argv[2] ?? 30);
const pack = readPackDir('packs/srd-5e');
const patterns = pack.combat!.patterns;
const rules = pack.combat!.rules ?? DEFAULT_RULES;
const DIRS: [number, number][] = [[0, 0], [0, -1], [0.707, -0.707], [1, 0], [0.707, 0.707], [0, 1], [-0.707, 0.707], [-1, 0], [-0.707, -0.707]];

type Bot = (sim: DodgeSim, rng: ReturnType<typeof seeded>) => number;
const still: Bot = () => 0;
let held = 0;
const careless: Bot = (sim, rng) => { if (sim.tick % 20 === 0) held = rng.int(9); return held; };
/** Looks 8 ticks ahead along straight lines and steps where the nearest needle or beam will be furthest away. */
const greedy: Bot = (sim) => {
  const speed = 330 * sim.setup.tier.speed * 1000 / 60;
  let best = 0, bestScore = -Infinity;
  const { o, side } = sim.box;
  for (let d = 0; d < 9; d++) {
    let score = Infinity;
    for (const ahead of [3, 8]) {
      const x = Math.max((o + 10) * 1000, Math.min((o + side - 10) * 1000, sim.x + DIRS[d][0] * speed * ahead));
      const y = Math.max((o + 10) * 1000, Math.min((o + side - 10) * 1000, sim.y + DIRS[d][1] * speed * ahead));
      for (const b of sim.bullets) {
        if (b.born > sim.tick + ahead) continue;
        const t = Math.max(0, sim.tick + ahead - Math.max(b.born, sim.tick));
        const bx = b.x + b.vx * t, by = b.y + b.vy * t;
        score = Math.min(score, Math.hypot(bx - x, by - y) - b.r);
      }
      for (const l of sim.lasers) score = Math.min(score, Math.abs((l.vertical ? x : y) - l.at) - (l.w / 2) * 1000);
      // Corners are traps; keep a little room.
      score = Math.min(score + 0, Math.min(x - o * 1000, (o + side) * 1000 - x, y - o * 1000, (o + side) * 1000 - y) * 0.5 + 20000);
    }
    if (score > bestScore + 1) { bestScore = score; best = d; }
  }
  return best;
};

function play(setup: DodgeSetup, seed: number, bot: Bot) {
  const sim = new DodgeSim(setup, seed);
  const rng = seeded(seed * 7 + 1);
  held = 0;
  while (!sim.done) sim.step(bot(sim, rng));
  return sim.hits;
}

const bots: [string, Bot][] = [['不動', still], ['亂走', careless], ['貪婪閃避', greedy]];
const lines: string[] = [];
lines.push('# 閃避平衡檢查（機器人，不是真人）', '');
lines.push(`由 \`scripts/dodge-sim.ts\` 產生，每格 ${SEEDS} 個亂數種子。數字是平均被打中次數，括號是平均傷害倍率（0 次 ×0.5 … 4 次以上 ×1.25）。`, '');
lines.push('**這不是平衡證明。** 機器人只代表下限（不動）、粗心（亂走）和只看幾格的簡單閃避；真人會落在中間。要定案得找真人試玩。', '');

const summary: Record<string, Record<string, number[]>> = {};
for (const p of patterns as PatternDef[]) {
  lines.push(`## ${p.name}（${p.id}）`, '', `| 局勢 | ${bots.map(([n]) => n).join(' | ')} |`, `|---|${bots.map(() => '---').join('|')}|`);
  for (const tier of rules.tiers) {
    const cells = bots.map(([name, bot]) => {
      let hits = 0, factor = 0;
      for (let s = 1; s <= SEEDS; s++) {
        const h = play({ tier, duration: tier.duration, pattern: p, reduced: false, damage: 10 }, s * 101 + 7, bot);
        hits += h;
        factor += factorFor(rules, h);
      }
      ((summary[tier.label] ??= {})[name] ??= []).push(factor / SEEDS);
      return `${(hits / SEEDS).toFixed(1)}（×${(factor / SEEDS).toFixed(2)}）`;
    });
    lines.push(`| ${tier.label} | ${cells.join(' | ')} |`);
  }
  lines.push('');
}
lines.push('## 全部彈幕平均的傷害倍率', '', `| 局勢 | ${bots.map(([n]) => n).join(' | ')} |`, `|---|${bots.map(() => '---').join('|')}|`);
for (const tier of rules.tiers) {
  lines.push(`| ${tier.label} | ${bots.map(([n]) => { const v = summary[tier.label][n]; return `×${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)}`; }).join(' | ')} |`);
}
lines.push('');
writeFileSync('reports/dodge-balance.md', lines.join('\n'));
console.log(lines.slice(-8).join('\n'));
