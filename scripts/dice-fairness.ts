/**
 * Are the physical dice fair? Throws every die many times through the same physics the server uses (half of the
 * throws with a flick from random spots, half tossed with no flick) and checks how often each face comes up.
 *
 *   npx tsx scripts/dice-fairness.ts [throws per face=300]   → writes reports/dice-fairness.md
 */
import { writeFileSync } from 'node:fs';
import { MAX_STEPS, reading, step, tossBody, TRAY } from '../src/dice/physics';

const PER_FACE = Number(process.argv[2] ?? 300);
// The chi-square value a fair die stays under 99% of the time, by degrees of freedom.
const CHI99: Record<number, number> = { 3: 11.34, 5: 15.09, 7: 18.48, 9: 21.67, 11: 24.72, 19: 36.19 };
const lines = ['# 實體骰子公平性檢查', '', `由 \`scripts/dice-fairness.ts\` 產生：每種骰子每面平均擲 ${PER_FACE} 次，用和伺服器同一套物理（一半有甩動、一半沒有）。`, '',
  '卡方值低於「99% 門檻」代表和公平骰子沒有顯著差異。', '', '| 骰子 | 次數 | 最少的一面 | 最多的一面 | 卡方 | 99% 門檻 | 平均停下時間 | 沒停穩就讀數 |', '|---|---|---|---|---|---|---|---|'];
for (const sides of [4, 6, 8, 10, 12, 20]) {
  const n = sides * PER_FACE;
  const counts = new Array(sides + 1).fill(0);
  let steps = 0, unrested = 0;
  for (let i = 0; i < n; i++) {
    const launch = i % 2 ? { hand: [((i * 37) % 80) / 10 - 4, ((i * 13) % 40) / 10 - 2] as [number, number], v: [((i * 7) % 30) - 15, ((i * 11) % 20) - 10] as [number, number] } : undefined;
    const b = tossBody(sides, { seed: 77 + i * 104729, lane: i % 4, launch });
    let k = 0;
    while (!b.asleep && k < MAX_STEPS) { step([b], TRAY); k++; }
    steps += k;
    if (!b.asleep) unrested++;
    counts[reading(b)]++;
  }
  const faces = counts.slice(1), exp = n / sides;
  const chi = faces.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
  lines.push(`| d${sides} | ${n} | ${Math.min(...faces)} | ${Math.max(...faces)} | ${chi.toFixed(1)} | ${CHI99[sides - 1]} | ${(steps / n / 240).toFixed(2)} 秒 | ${unrested} |`);
}
lines.push('');
writeFileSync('reports/dice-fairness.md', lines.join('\n'));
console.log(lines.join('\n'));
