// Combat sandbox: the player's character and an NPC medic against two wolves, on the real engine.
// Shows turn order, who is acting, the odds of each action before it is taken, and plays NPC turns one at a time.
import { autopilot } from '../src/combat/autopilot';
import {
  COMBAT_V03 as CFG, CombatError, applyTimeout, attackCheck, attackDamage, canAct, defenseOf, escapeCheck, rescueCheck,
  startCombat, submitAction, weapon,
} from '../src/combat/engine';
import type { CombatAction, CombatEvent, CombatState, Combatant, CombatantSetup } from '../src/combat/types';
import { exampleBuild, maxHp, type CharacterDraft } from '../src/character/create';
import { DEFAULT_RULES as R } from '../src/rules/config';
import { randomRng } from '../src/rules/dice';
import type { AttributeCode, CheckInput, TierKey } from '../src/rules/types';
import { distribution } from '../src/sim/enumerate';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pct = (p: number) => `${Math.round(p * 100)}%`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const PLAYER = 'me';
const COND: Record<string, string> = {
  healthy: '健康', wounded: '受傷', severe: '重傷', dying: '瀕死', stable: '穩定（昏迷）', dead: '死亡', escaped: '已脫離',
};
const TIER: Record<string, string> = Object.fromEntries(R.tiers.map((t) => [t.key, t.name]));
const TIER_KEYS = R.tiers.map((t) => t.key) as TierKey[];
const tierColor = (k: string) => `var(--t-${k})`;
const wolfAttrs: Record<AttributeCode, number> = { STR: 2, AGI: 2, VIT: 2, PRE: 1, PER: 2, INT: 0, WIL: 1, CHA: 0, INS: 1, SPR: 0 };

let state: CombatState;
let getHero: () => { draft: CharacterDraft; created: boolean };
let clock = new Date();
let n = 0;
let targetId = '';
let busy = false;
/** Bumped on every new fight so a paced NPC loop from the previous fight stops. */
let fightNo = 0;
/** Damage numbers to show on tokens at the next render. */
let flashes: Record<string, { text: string; cls: string }> = {};
let lastRoll: CombatEvent | null = null;
let narration = '';

function name(id?: string) {
  return id ? state.combatants[id]?.name ?? id : '';
}
const list = () => state.order.map((id) => state.combatants[id]);
const out = (c: Combatant) => c.condition === 'dead' || c.condition === 'escaped';

function describe(e: CombatEvent): string | null {
  const d = e.data as Record<string, any>;
  const who = esc(name(e.combatantId));
  switch (e.kind) {
    case 'combatStarted': return `戰鬥開始。行動順序：${d.order.map((id: string) => esc(name(id))).join(' → ')}`;
    case 'moved': return `${who} 移動到${CFG.bands.names[d.to]}`;
    case 'attack': return `${who} 攻擊 ${esc(name(d.targetId))}：d20 [${d.d20.join(', ')}] 總值 ${d.total} 對防禦 ${d.defense} → ${TIER[d.tier]}${d.damage ? `，造成 ${d.damage} 傷害` : '，沒有造成傷害'}`;
    case 'defend': return `${who} ${d.automatic ? '逾時，自動' : ''}採取防禦姿態（防禦 +${d.bonus}，到下次行動前）`;
    case 'potion': return `${who} 讓 ${esc(name(d.targetId))} 喝下藥水，HP 回到 ${d.hp}`;
    case 'rescue': return `${who} 救援 ${esc(name(d.targetId))}${d.medkit ? '（醫療包，優勢）' : ''}：d20 [${d.d20.join(', ')}] 總值 ${d.total} → ${TIER[d.tier]}`;
    case 'revivedToFight': return `${who} 重新站起來，HP ${d.hp}`;
    case 'stabilized': return `${who} 穩定下來${d.reason === 'protected' ? '（離線保護）' : ''}`;
    case 'dying': return `<span class="warn">${who} 倒下，進入瀕死</span>`;
    case 'dyingHit': return `<span class="warn">${who} 瀕死時再受傷，失敗累積 ${d.failures}</span>`;
    case 'deathSave': return d.result === 'natural-20'
      ? `${who} 瀕死判定擲出自然 20，自行穩定`
      : `${who} 瀕死判定：d20 ${d.d20} 總值 ${d.total} 對 ${CFG.dying.tn} → ${d.success ? '成功' : '失敗'}（成功 ${d.successes}／失敗 ${d.failures}）`;
    case 'death': return `<span class="bad">${who} 永久死亡</span>`;
    case 'escapeAttempt': return `${who} 嘗試脫離：總值 ${d.total} 對 ${CFG.escape.tn} → ${TIER[d.tier]}`;
    case 'escaped': return `${who} 脫離戰鬥`;
    case 'timeout': return `${who} 的回合逾時`;
    case 'combatEnded': return `<b>戰鬥結束：${d.winner === 'party' ? '我方勝利' : d.winner ? '敵方勝利' : '無人站著'}</b>`;
    default: return null;
  }
}

/** Log entries grouped by round, newest round on top and open. */
function log(events: CombatEvent[]) {
  const box = $('cb-log');
  for (const e of events) {
    const text = describe(e);
    if (!text) continue;
    let group = box.querySelector<HTMLDetailsElement>(`details[data-round="${e.round}"]`);
    if (!group) {
      for (const g of box.querySelectorAll('details')) g.open = false;
      group = document.createElement('details');
      group.dataset.round = String(e.round);
      group.open = true;
      group.innerHTML = `<summary>${e.round === 0 ? '開戰' : `第 ${e.round} 輪`}</summary><ul></ul>`;
      box.prepend(group);
    }
    const li = document.createElement('li');
    const side = e.combatantId ? state.combatants[e.combatantId]?.side : '';
    if (side) li.className = `side-${side}`;
    li.innerHTML = text;
    group.querySelector('ul')!.prepend(li);
  }
}

/** Turn engine events into floating numbers, the last-roll card and a one-line narration. */
function absorb(events: CombatEvent[]) {
  for (const e of events) {
    const d = e.data as Record<string, any>;
    if (e.kind === 'attack') {
      flashes[d.targetId] = d.damage ? { text: `−${d.damage}`, cls: 'dmg' } : { text: d.tier === 'partial' ? '擦過' : '未命中', cls: 'miss' };
    } else if (e.kind === 'potion') flashes[d.targetId] = { text: `+${CFG.potionHeal}`, cls: 'heal' };
    else if (e.kind === 'revivedToFight') flashes[e.combatantId!] = { text: '站起來了', cls: 'heal' };
    else if (e.kind === 'dying') flashes[e.combatantId!] = { text: '倒下', cls: 'dmg' };
    else if (e.kind === 'death') flashes[e.combatantId!] = { text: '死亡', cls: 'dmg' };
    if (['attack', 'rescue', 'deathSave', 'escapeAttempt'].includes(e.kind)) lastRoll = e;
    const text = describe(e);
    if (text && !['roundStarted', 'combatStarted'].includes(e.kind)) narration = text;
  }
  log(events);
}

function heroSetup(): CombatantSetup {
  const { draft } = getHero();
  return {
    id: PLAYER, name: draft.name || '你的角色', side: 'party', controller: 'player', attributes: draft.attributes,
    skills: draft.skills, maxHp: maxHp(draft.attributes, R), band: 1,
    weaponId: (($('cb-weapon') as HTMLSelectElement).value), armorId: 'leather', potions: 1, medkits: 1,
  };
}

function newFight() {
  const medic = exampleBuild('medic', R);
  clock = new Date();
  fightNo += 1;
  busy = false;
  flashes = {};
  lastRoll = null;
  narration = '';
  const setups: CombatantSetup[] = [
    heroSetup(),
    { id: 'mira', name: '米菈（醫療師）', side: 'party', controller: 'npc-ally', attributes: medic.attributes, skills: medic.skills,
      maxHp: maxHp(medic.attributes, R), band: 1, weaponId: 'dagger', armorId: 'none', medkits: 1 },
    { id: 'w1', name: '灰狼甲', side: 'beasts', controller: 'gm', attributes: wolfAttrs, skills: { melee: 2, dodge: 1 }, maxHp: 10, band: 3, weaponId: 'claws', armorId: 'hide' },
    { id: 'w2', name: '灰狼乙', side: 'beasts', controller: 'gm', attributes: wolfAttrs, skills: { melee: 2, dodge: 1 }, maxHp: 10, band: 3, weaponId: 'claws', armorId: 'hide' },
  ];
  state = startCombat({ id: `demo-${Date.now()}`, combatants: setups, rules: R, rng: randomRng, now: clock });
  targetId = 'w1';
  $('cb-log').innerHTML = '';
  absorb(state.events);
  void runNpcs();
}

function send(combatantId: string, action: CombatAction): CombatEvent[] {
  const c = state.combatants[combatantId];
  const actor = c.controller === 'gm' ? { userId: 'gm', role: 'gm' as const } : { userId: c.controller, role: 'player' as const };
  const res = submitAction(state, { actionId: `d${++n}`, actor, combatantId, round: state.round, action }, R, randomRng, clock);
  state = res.state;
  absorb(res.events);
  return res.events;
}

/* ---------- death save ---------- */

/** Death-save stage. The die tumbles while the "roll" is in the air, then lands on the server's number. */
function renderDice(c: Combatant | null, phase: 'idle' | 'rolling' | 'landed' = 'idle', ev?: CombatEvent) {
  const box = $('cb-dice');
  if (!c) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const d = CFG.dying;
  const vit = c.attributes[d.attribute];
  const mine = c.id === PLAYER;
  const e = ev?.data as Record<string, any> | undefined;
  const pips = (on: number, total: number, cls: string) => Array.from({ length: total }, (_, i) => `<i class="pip${i < on ? ` ${cls}` : ''}"></i>`).join('');
  const sv = e && e.successes !== undefined ? { successes: e.successes, failures: e.failures } : c.dying;
  let face = '?', dieCls = '', result = '';
  if (phase === 'landed' && e) {
    face = String(e.d20);
    if (e.result === 'natural-20') { dieCls = 'landed n20'; result = '<span class="ds-result ok">自然 20！自行穩定下來</span>'; }
    else if (e.success) { dieCls = 'landed ok'; result = `<span class="ds-result ok">成功（${e.total} ≥ ${d.tn}）</span>`; }
    else { dieCls = 'landed bad'; result = `<span class="ds-result bad">${e.d20 === 1 ? '自然 1，記兩次失敗' : `失敗（${e.total} < ${d.tn}）`}</span>`; }
    if (e.failures >= d.failuresToDie) result += '<span class="ds-result bad">　永久死亡</span>';
    else if (e.successes >= d.successesToStabilize) result += '<span class="ds-result ok">　穩定下來了</span>';
  } else if (phase === 'rolling') dieCls = 'rolling';
  const pSave = distribution({ attribute: vit, skill: 0, tn: d.tn }, R).pSuccess;
  box.innerHTML = `<div class="bigdie ${dieCls}" id="cb-bigdie" aria-label="d20">${face}</div>
    <div class="ds-title">${esc(c.name)}${mine ? '（你）' : ''}倒下了：瀕死判定</div>
    <div class="ds-rule">d20 + ${d.attribute} ${vit} 對 ${d.tn}，成功率約 ${pct(pSave)}。累積 ${d.successesToStabilize} 次成功就穩定，${d.failuresToDie} 次失敗就永久死亡。自然 20 直接穩定，自然 1 算兩次失敗。</div>
    <div class="ds-row"><span>成功 <span class="pips">${pips(sv.successes, d.successesToStabilize, 'ok')}</span></span>
      <span>失敗 <span class="pips">${pips(sv.failures, d.failuresToDie, 'bad')}</span></span>
      ${phase === 'idle' && mine && !busy ? '<button type="button" class="ds-roll" id="cb-roll">擲瀕死骰</button>' : ''}
      ${phase === 'idle' && !mine ? '<span class="hint">等待擲骰</span>' : ''}${result}</div>`;
}

/** Rolls the current combatant's death save with the tumble animation, then holds on the result. */
async function rollDeathSave(id: string) {
  const fight = fightNo;
  const c = state.combatants[id];
  busy = true;
  render();
  const motion = !reduceMotion() && speed() > 0;
  renderDice(c, 'rolling');
  const die = $('cb-bigdie');
  if (motion) {
    const spin = setInterval(() => { die.textContent = String(1 + Math.floor(Math.random() * 20)); }, 70);
    await wait(950);
    clearInterval(spin);
  }
  if (fight !== fightNo) return;
  const events = send(id, { type: 'deathSave' });
  renderDice(state.combatants[id], 'landed', events.find((e) => e.kind === 'deathSave'));
  render(true);
  await wait(motion ? 1500 : speed() ? 600 : 0);
  if (fight !== fightNo) return;
  void runNpcs();
}

/** NPCs (wolves and the medic) act one step at a time until it is the player's turn or the fight ends. */
async function runNpcs() {
  const fight = fightNo;
  const delay = () => (reduceMotion() ? Math.min(250, speed()) : speed());
  let guard = 0;
  while (state.status === 'active' && state.turn && state.turn.combatantId !== PLAYER && guard++ < 200) {
    if (state.turn.kind === 'deathSave') return rollDeathSave(state.turn.combatantId);
    busy = true;
    render();
    if (delay()) await wait(delay());
    if (fight !== fightNo) return;
    send(state.turn.combatantId, autopilot(state));
  }
  if (fight !== fightNo) return;
  busy = false;
  render();
}
const speed = () => Number($<HTMLSelectElement>('cb-speed').value);

function act(action: CombatAction) {
  if (busy) return;
  $('cb-error').textContent = '';
  try {
    send(PLAYER, action);
  } catch (e) {
    $('cb-error').textContent = e instanceof CombatError ? e.message : String(e);
    return;
  }
  void runNpcs();
}

/* ---------- odds ---------- */

/** P(damage > 0), expected damage and per-tier odds for a check whose tiers map to damage. */
function odds(input: CheckInput, dmgFor: (k: TierKey) => number) {
  const dist = distribution(input, R);
  let pHit = 0;
  let expected = 0;
  const rows = TIER_KEYS.map((k) => {
    const p = dist.tiers[k];
    const dmg = dmgFor(k);
    if (dmg > 0) pHit += p;
    expected += p * dmg;
    return { k, p, dmg };
  });
  return { dist, pHit, expected, rows };
}

function attackOdds(att: Combatant, t: Combatant, defendingOverride?: boolean) {
  const target = defendingOverride === undefined ? t : { ...t, defending: defendingOverride };
  const input = attackCheck(att, target, CFG);
  return { input, ...odds(input, (k) => attackDamage(weapon(att.weaponId), k, target, CFG)) };
}

/** How dangerous the enemies that can still act are to `me`, now and if `me` defends. */
function threat(me: Combatant) {
  const foes = list().filter((c) => c.side !== me.side && canAct(c));
  if (!foes.length) return null;
  const now = foes.map((f) => attackOdds(f, me));
  const guarded = foes.map((f) => attackOdds(f, me, true));
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    pHit: avg(now.map((o) => o.pHit)), expected: now.reduce((a, o) => a + o.expected, 0),
    pHitGuarded: avg(guarded.map((o) => o.pHit)), expectedGuarded: guarded.reduce((a, o) => a + o.expected, 0),
    maxDmg: Math.max(...now.map((o) => Math.max(...o.rows.map((r) => r.dmg)))),
    count: foes.length,
  };
}

/* ---------- render ---------- */

/** keepDice: leave the death-save stage showing its last result instead of redrawing it. */
function render(keepDice = false) {
  const s = state;
  const me = s.combatants[PLAYER];
  const mineNow = s.status === 'active' && s.turn?.combatantId === PLAYER && !busy;
  const myTurn = mineNow && s.turn!.kind !== 'deathSave';
  if (!keepDice) renderDice(s.status === 'active' && s.turn?.kind === 'deathSave' ? s.combatants[s.turn.combatantId] : null);
  const enemies = list().filter((c) => c.side !== 'party' && !out(c));
  if (!enemies.some((e) => e.id === targetId)) targetId = enemies[0]?.id ?? '';
  const target = targetId ? s.combatants[targetId] : null;
  const w = weapon(me.weaponId);

  $('cb-round').textContent = s.status === 'ended' ? '戰鬥結束' : `第 ${s.round} 輪`;
  renderTimeline();
  renderBanner(mineNow);

  $('cb-bands').innerHTML = CFG.bands.names.map((bandName, i) => {
    const inReach = s.status === 'active' && Math.abs(i - me.band) <= w.range && canAct(me);
    const dist = Math.abs(i - me.band);
    return `<div class="band${inReach ? ' reach' : ''}"><span class="band-name"><span>${bandName}</span><span>${i === me.band ? '你在這裡' : inReach ? '射程內' : `差 ${dist}`}</span></span>${
      list().filter((c) => c.band === i).map((c) => token(c, c.id === targetId)).join('')}</div>`;
  }).join('');
  flashes = {};

  renderMe(me);
  renderPreview(me, target, myTurn);
  renderLastRoll();
  renderButtons(me, target, myTurn);
  $<HTMLButtonElement>('cb-timeout').disabled = !mineNow;
}

function hpBar(c: Combatant) {
  return `<span class="tk-hp"><i style="width:${Math.max(0, (c.hp / c.maxHp) * 100)}%"></i></span>`;
}

function deathPips(c: Combatant) {
  const { successesToStabilize: ns, failuresToDie: nf } = CFG.dying;
  const p = (on: number, total: number, cls: string) => Array.from({ length: total }, (_, i) => `<i class="pip${i < on ? ` ${cls}` : ''}"></i>`).join('');
  return `<span class="pips" title="瀕死判定：成功 ${c.dying.successes}／失敗 ${c.dying.failures}"><b class="pl">救</b>${p(c.dying.successes, ns, 'ok')}</span> <span class="pips"><b class="pl">死</b>${p(c.dying.failures, nf, 'bad')}</span>`;
}

function token(c: Combatant, isTarget: boolean) {
  const s = state;
  const pickable = c.side !== 'party' && !out(c);
  const f = flashes[c.id];
  const tag = pickable ? 'button' : 'div';
  const attrs = pickable ? ` type="button" data-target="${c.id}" aria-pressed="${isTarget}" aria-label="選擇 ${esc(c.name)} 當攻擊目標"` : '';
  const cls = `token side-${c.side} c-${c.condition}${s.turn?.combatantId === c.id ? ' current' : ''}${isTarget ? ' target' : ''}${f && f.cls === 'dmg' ? ' hit' : ''}`;
  return `<${tag} class="${cls}"${attrs}>
    <span class="tk-name">${esc(c.name)}${c.id === PLAYER ? '（你）' : ''}</span>
    ${hpBar(c)}
    <span class="tk-meta">HP ${c.hp}/${c.maxHp}｜${COND[c.condition]}${c.defending && canAct(c) ? '｜防禦中' : ''}</span>
    ${c.condition === 'dying' ? `<span class="tk-meta">${deathPips(c)}</span>` : ''}
    ${f ? `<span class="float ${f.cls}">${esc(f.text)}</span>` : ''}
  </${tag}>`;
}

/** Who acts this round, in initiative order, and where the turn is now. */
function renderTimeline() {
  const s = state;
  const order = s.order;
  const cur = s.turn ? order.indexOf(s.turn.combatantId) : -1;
  // The next combatant who will actually get a turn (dead and escaped are skipped by the engine).
  let next = -1;
  for (let k = 1; k <= order.length && cur >= 0; k++) {
    const c = s.combatants[order[(cur + k) % order.length]];
    if (!out(c) && c.condition !== 'stable') { next = (cur + k) % order.length; break; }
  }
  $('cb-timeline').innerHTML = order.map((id, i) => {
    const c = s.combatants[id];
    const now = i === cur && s.status === 'active';
    const tag = now ? (id === PLAYER ? '你的回合' : '行動中') : i === next ? (next <= cur ? '下一輪先手' : '下一位') : out(c) ? COND[c.condition] : i < cur ? '已行動' : '';
    const extra = c.condition === 'dying' ? deathPips(c) : COND[c.condition];
    return `<li class="tl side-${c.side} c-${c.condition}${now ? ' now' : ''}${i === next ? ' next' : ''}${i < cur && !now ? ' done' : ''}"${now ? ' aria-current="step"' : ''}>
      <span class="tl-top"><span>先攻 ${c.initiative}</span><span class="tl-tag">${tag}</span></span>
      <span class="tl-name">${esc(c.name)}${id === PLAYER ? '（你）' : ''}</span>
      ${hpBar(c)}
      <span class="tl-top"><span>HP ${c.hp}/${c.maxHp}</span><span>${extra}</span></span>
    </li>`;
  }).join('');
  $('cb-timeline').querySelector('.now')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderBanner(myTurn: boolean) {
  const s = state;
  const box = $('cb-banner');
  const main = $('cb-banner-main');
  const sub = $('cb-banner-sub');
  const me = s.combatants[PLAYER];
  if (s.status === 'ended') {
    const win = s.winner === 'party';
    box.className = `banner ${win ? 'over-win' : 'over-lose'}`;
    const lost = list().filter((c) => c.side === 'party' && c.condition === 'dead').map((c) => c.name);
    main.textContent = win ? '勝利！灰狼被擊退了' : me.condition === 'escaped' ? '你脫離了戰鬥' : '我方落敗';
    sub.innerHTML = lost.length ? `<span class="warn">永久失去：${esc(lost.join('、'))}</span>。按「重新開戰」再來一次。` : '按「重新開戰」再來一次，或在上面換武器、改角色配點。';
    return;
  }
  const actor = s.turn ? s.combatants[s.turn.combatantId] : null;
  if (myTurn && actor && s.turn!.kind === 'deathSave') {
    box.className = 'banner mine';
    main.textContent = '你倒下了！擲瀕死判定';
    sub.innerHTML = `按下方的「擲瀕死骰」。骰子由伺服器擲，結果會永久記錄。${narration ? `<br>剛才：${narration}` : ''}`;
    return;
  }
  if (myTurn && actor) {
    box.className = 'banner mine';
    const attacksLeft = CFG.maxAttacksPerTurn - s.turn!.attacks;
    main.innerHTML = `輪到你了　<span class="pips">${Array.from({ length: CFG.apPerTurn }, (_, i) => `<i class="pip ap${i < s.turn!.ap ? ' on' : ''}"></i>`).join('')}</span>`;
    const parts = [`剩 ${s.turn!.ap} AP`, attacksLeft > 0 ? `還能攻擊 ${attacksLeft} 次` : '本回合已攻擊過'];
    if (me.condition === 'severe') parts.push('你重傷了，所有判定劣勢');
    const allyDown = list().find((c) => c.side === 'party' && c.id !== PLAYER && c.condition === 'dying');
    if (allyDown) parts.push(`${allyDown.name} 瀕死中，需要救援`);
    sub.innerHTML = `${esc(parts.join('。'))}。${narration ? `<br>剛才：${narration}` : ''}`;
    return;
  }
  if (actor) {
    box.className = `banner busy ${actor.side === 'party' ? 'ally' : 'enemy'}`;
    main.textContent = actor.condition === 'dying' ? `${actor.name} 正在做瀕死判定` : `${actor.name} 正在行動`;
    sub.innerHTML = narration ? `剛才：${narration}` : '等待電腦操作的角色行動。';
  }
}

function renderMe(me: Combatant) {
  const w = weapon(me.weaponId);
  const effects: string[] = [];
  if (me.condition === 'severe') effects.push('<span class="chip bad">重傷：判定劣勢</span>');
  else if (me.condition === 'wounded') effects.push('<span class="chip">受傷</span>');
  if (me.defending) effects.push(`<span class="chip good">防禦中 +${CFG.defense.defendBonus}</span>`);
  if (me.condition === 'dying') effects.push('<span class="chip bad">瀕死</span>');
  const th = canAct(me) ? threat(me) : null;
  $('cb-me').innerHTML = `<h4>你的角色</h4>
    <div class="kv"><span class="big">${me.hp}<small style="font-size:13px;color:var(--muted)"> / ${me.maxHp} HP</small></span><span>${COND[me.condition]}</span></div>
    ${hpBar(me)}
    <div class="kv"><span>防禦值</span><span>${defenseOf(me, CFG)}${me.defending ? '' : `（防禦時 ${defenseOf({ ...me, defending: true }, CFG)}）`}</span></div>
    <div class="kv"><span>武器</span><span>${esc(w.name)}・傷害 ${w.damage}・射程 ${w.range === 0 ? '近身' : `${w.range} 格`}</span></div>
    <div class="kv"><span>藥水／醫療包</span><span>${me.potions}／${me.medkits}</span></div>
    ${me.condition === 'dying' ? `<div class="kv"><span>瀕死判定</span><span>${deathPips(me)}</span></div>` : ''}
    ${effects.length ? `<div class="chips">${effects.join('')}</div>` : ''}
    ${th ? `<p class="hint${th.expected >= me.hp ? ' warn' : ''}">${th.count} 隻敵人對你：每次命中 ${pct(th.pHit)}，一輪合計預期 ${th.expected.toFixed(1)} 傷害${me.defending ? '' : `；防禦的話降到 ${pct(th.pHitGuarded)}／${th.expectedGuarded.toFixed(1)}`}。</p>` : ''}`;
}

function renderPreview(me: Combatant, t: Combatant | null, myTurn: boolean) {
  const box = $('cb-preview');
  if (!t || state.status === 'ended') { box.innerHTML = `<h4>攻擊預覽</h4><p class="hint">${state.status === 'ended' ? '戰鬥已結束。' : '沒有可攻擊的目標。'}</p>`; return; }
  const w = weapon(me.weaponId);
  const dist = Math.abs(t.band - me.band);
  const o = attackOdds(me, t);
  const bar = o.rows.filter((r) => r.p > 0).map((r) => `<i style="width:${r.p * 100}%;background:${tierColor(r.k)}" title="${TIER[r.k]} ${pct(r.p)}"></i>`).join('');
  const rows = [...o.rows].reverse().filter((r) => r.p > 0).map((r) => `<div><span class="sw" style="background:${tierColor(r.k)}"></span><span>${TIER[r.k]}</span><span>${r.dmg ? `${r.dmg} 傷害` : '—'}</span><span class="p">${pct(r.p)}</span></div>`).join('');
  let hint = '';
  if (dist > w.range) hint = `<p class="hint warn">${esc(w.name)}打不到：還差 ${dist - w.range} 格，先${t.band > me.band ? '前進' : '後退'}。</p>`;
  else if (!canAct(t)) hint = `<p class="hint">${esc(t.name)} 無法閃避，防禦只剩基礎 ${CFG.defense.base}。</p>`;
  else if (myTurn && state.turn!.attacks >= CFG.maxAttacksPerTurn) hint = '<p class="hint">這回合已經攻擊過了。</p>';
  const kills = o.rows.filter((r) => r.dmg >= t.hp && r.dmg > 0).reduce((a, r) => a + r.p, 0);
  box.innerHTML = `<h4>攻擊預覽・${esc(t.name)}（點地圖上的敵人可換目標）</h4>
    <div class="kv"><span class="big">${pct(o.pHit)}<small style="font-size:13px;color:var(--muted)"> 造成傷害</small></span><span>預期 ${o.expected.toFixed(1)}</span></div>
    <div class="tierbar" role="img" aria-label="結果分布">${bar}</div>
    <div class="dmgrows">${rows}</div>
    <p class="hint">d20 + ${o.input.attribute}（屬性）+ ${o.input.skill}（技能）對防禦 ${o.input.tn}${o.input.mode === 'disadvantage' ? '，劣勢' : ''}・對方護甲減傷已算入${kills > 0 ? `・<b>${pct(kills)} 機率直接擊倒</b>` : ''}</p>
    ${hint}`;
}

function renderLastRoll() {
  const box = $('cb-lastroll');
  const e = lastRoll;
  if (!e) {
    box.style.removeProperty('--c');
    box.innerHTML = '<div class="lr-head">最新擲骰</div><p class="hint">還沒有人擲骰。</p>';
    return;
  }
  const d = e.data as Record<string, any>;
  const dice: number[] = Array.isArray(d.d20) ? d.d20 : [d.d20];
  // Two dice: rescue with a medkit is advantage (higher die); anything else is disadvantage (lower die).
  const used = dice.length < 2 ? 0 : (e.kind === 'rescue' && d.medkit) ? dice.indexOf(Math.max(...dice)) : dice.indexOf(Math.min(...dice));
  const faces = dice.map((v, i) => `<span class="die${i !== used ? ' unused' : ''}${v === 20 ? ' n20' : v === 1 ? ' n1' : ''}">${v}</span>`).join('');
  const who = esc(name(e.combatantId));
  let head = '', math = '', tier = '', color = 'var(--line)';
  if (e.kind === 'attack') {
    head = `${who} → ${esc(name(d.targetId))}・攻擊`;
    math = `總值 ${d.total} 對防禦 ${d.defense}`;
    tier = `${TIER[d.tier]}${d.damage ? `・${d.damage} 傷害` : ''}`;
    color = tierColor(d.tier);
  } else if (e.kind === 'rescue') {
    head = `${who} → ${esc(name(d.targetId))}・救援${d.medkit ? '（醫療包）' : ''}`;
    math = `總值 ${d.total} 對 ${CFG.rescue.tn}`;
    tier = TIER[d.tier];
    color = tierColor(d.tier);
  } else if (e.kind === 'escapeAttempt') {
    head = `${who}・脫離`;
    math = `總值 ${d.total} 對 ${CFG.escape.tn}`;
    tier = TIER[d.tier];
    color = tierColor(d.tier);
  } else if (e.kind === 'deathSave') {
    head = `${who}・瀕死判定`;
    if (d.result === 'natural-20') { math = '自然 20'; tier = '自行穩定'; color = 'var(--ok)'; }
    else { math = `總值 ${d.total} 對 ${CFG.dying.tn}`; tier = `${d.success ? '成功' : '失敗'}・${d.successes}✓ ${d.failures}✗`; color = d.success ? 'var(--ok)' : 'var(--bad)'; }
  }
  const key = `${e.seq}`;
  const fresh = box.dataset.seq !== key;
  box.dataset.seq = key;
  box.style.setProperty('--c', color);
  box.classList.toggle('fresh', false);
  box.innerHTML = `<div class="lr-head">最新擲骰・${head}</div>
    <div class="lr-row">${faces}<span class="lr-math">${math}</span></div>
    <div class="lr-tier">${tier}</div>`;
  if (fresh) { void box.offsetWidth; box.classList.add('fresh'); }
}

function renderButtons(me: Combatant, t: Combatant | null, myTurn: boolean) {
  const s = state;
  const ap = s.turn?.ap ?? 0;
  const C = CFG.actionCosts;
  const w = weapon(me.weaponId);
  const allyDying = list().find((c) => c.side === 'party' && c.id !== PLAYER && c.condition === 'dying');
  const inRange = !!t && Math.abs(t.band - me.band) <= w.range;
  const label = (id: string, text: string) => { $(`ab-${id}`).textContent = text; };

  label('attack', t ? (inRange ? `${C.attack} AP・${pct(attackOdds(me, t).pHit)} 命中` : `${C.attack} AP・打不到`) : '—');
  label('left', `${C.move} AP`);
  label('right', `${C.move} AP`);
  label('defend', `${C.defend} AP・防禦 +${CFG.defense.defendBonus}`);
  label('potion', `${C.useItem} AP・回 ${CFG.potionHeal} HP（剩 ${me.potions}）`);
  if (allyDying) {
    const kit = me.medkits > 0;
    const o = distribution(rescueCheck(me, kit, CFG), R);
    const sameBand = allyDying.band === me.band;
    label('rescue', sameBand ? `${C.rescue} AP・${pct(o.pSuccess)} 救回${kit ? '（醫療包）' : ''}` : `${C.rescue} AP・要先走到${CFG.bands.names[allyDying.band]}`);
  } else label('rescue', `${C.rescue} AP・沒人瀕死`);
  label('escape', `${C.escape} AP・${pct(distribution(escapeCheck(me, CFG), R).pSuccess)} 成功`);
  label('end', myTurn && ap ? `放棄剩下 ${ap} AP` : '');

  const dis: Record<string, boolean> = {
    attack: !t || !inRange || ap < C.attack || s.turn!.attacks >= CFG.maxAttacksPerTurn,
    left: me.band === 0 || ap < C.move,
    right: me.band === CFG.bands.count - 1 || ap < C.move,
    defend: ap < C.defend || me.defending,
    potion: me.potions <= 0 || ap < C.useItem || me.hp >= me.maxHp,
    rescue: !allyDying || allyDying.band !== me.band || ap < C.rescue,
    escape: ap < C.escape,
    end: false,
  };
  for (const b of document.querySelectorAll<HTMLButtonElement>('#cb-actions button')) b.disabled = !myTurn || dis[b.dataset.act!];
}

export function initCombat(heroSource: () => { draft: CharacterDraft; created: boolean }) {
  getHero = heroSource;
  $('cb-actions').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || b.disabled) return;
    const me = state.combatants[PLAYER];
    const a = b.dataset.act;
    if (a === 'left') act({ type: 'move', to: me.band - 1 });
    else if (a === 'right') act({ type: 'move', to: me.band + 1 });
    else if (a === 'attack') act({ type: 'attack', targetId });
    else if (a === 'defend') act({ type: 'defend' });
    else if (a === 'potion') act({ type: 'usePotion' });
    else if (a === 'rescue') {
      const ally = list().find((c) => c.side === 'party' && c.id !== PLAYER && c.condition === 'dying')!;
      act({ type: 'rescue', targetId: ally.id, useMedkit: me.medkits > 0 });
    } else if (a === 'escape') act({ type: 'escape' });
    else if (a === 'end') act({ type: 'endTurn' });
  });
  $('cb-bands').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-target]');
    if (!b) return;
    targetId = b.dataset.target!;
    render();
  });
  $('cb-timeout').addEventListener('click', () => {
    if (busy) return;
    clock = new Date(new Date(state.turn!.deadline).getTime() + 1000);
    const res = applyTimeout(state, R, randomRng, clock);
    state = res.state;
    absorb(res.events);
    void runNpcs();
  });
  $('cb-dice').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'cb-roll' && !busy) void rollDeathSave(PLAYER);
  });
  $('cb-new').addEventListener('click', newFight);
  newFight();
}
