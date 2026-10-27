// Combat sandbox: the player's character and an NPC medic against two wolves, on the real engine.
import { autopilot } from '../src/combat/autopilot';
import { COMBAT_V03 as CFG, CombatError, applyTimeout, canAct, startCombat, submitAction, weapon } from '../src/combat/engine';
import type { CombatAction, CombatEvent, CombatState, CombatantSetup } from '../src/combat/types';
import { exampleBuild, maxHp, type CharacterDraft } from '../src/character/create';
import { DEFAULT_RULES as R } from '../src/rules/config';
import { randomRng } from '../src/rules/dice';
import type { AttributeCode } from '../src/rules/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const PLAYER = 'me';
const COND: Record<string, string> = {
  healthy: '健康', wounded: '受傷', severe: '重傷', dying: '瀕死', stable: '穩定（昏迷）', dead: '死亡', escaped: '已脫離',
};
const TIER: Record<string, string> = {
  catastrophe: '災難性失敗', failure: '失敗', partial: '部分成功', success: '普通成功', strong: '強成功', exceptional: '卓越成功',
};
const wolfAttrs: Record<AttributeCode, number> = { STR: 2, AGI: 2, VIT: 2, PRE: 1, PER: 2, INT: 0, WIL: 1, CHA: 0, INS: 1, SPR: 0 };

let state: CombatState;
let getHero: () => { draft: CharacterDraft; created: boolean };
let clock = new Date();
let n = 0;

function name(id?: string) {
  return id ? state.combatants[id]?.name ?? id : '';
}

function describe(e: CombatEvent): string | null {
  const d = e.data as Record<string, any>;
  const who = esc(name(e.combatantId));
  switch (e.kind) {
    case 'combatStarted': return `戰鬥開始。行動順序：${d.order.map((id: string) => esc(name(id))).join(' → ')}`;
    case 'roundStarted': return `<b>第 ${e.round} 輪</b>`;
    case 'turnStarted': return null;
    case 'moved': return `${who} 移動到${CFG.bands.names[d.to]}`;
    case 'attack': return `${who} 攻擊 ${esc(name(d.targetId))}：d20 [${d.d20.join(', ')}] 總值 ${d.total} 對防禦 ${d.defense} → ${TIER[d.tier]}${d.damage ? `，造成 ${d.damage} 傷害` : ''}`;
    case 'defend': return `${who} ${d.automatic ? '逾時，自動' : ''}採取防禦姿態（防禦 +${d.bonus}）`;
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
    case 'escapeAttempt': return `${who} 嘗試脫離：總值 ${d.total} → ${TIER[d.tier]}`;
    case 'escaped': return `${who} 脫離戰鬥`;
    case 'timeout': return `${who} 的回合逾時`;
    case 'combatEnded': return `<b>戰鬥結束：${d.winner === 'party' ? '我方勝利' : d.winner ? '敵方勝利' : '無人站著'}</b>`;
    default: return null;
  }
}

function log(events: CombatEvent[]) {
  const ul = $('cb-log');
  for (const e of events) {
    const text = describe(e);
    if (!text) continue;
    const li = document.createElement('li');
    li.innerHTML = text;
    ul.prepend(li);
  }
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
  const setups: CombatantSetup[] = [
    heroSetup(),
    { id: 'mira', name: '米菈（醫療師）', side: 'party', controller: 'npc-ally', attributes: medic.attributes, skills: medic.skills,
      maxHp: maxHp(medic.attributes, R), band: 1, weaponId: 'dagger', armorId: 'none', medkits: 1 },
    { id: 'w1', name: '灰狼甲', side: 'beasts', controller: 'gm', attributes: wolfAttrs, skills: { melee: 2, dodge: 1 }, maxHp: 10, band: 3, weaponId: 'claws', armorId: 'hide' },
    { id: 'w2', name: '灰狼乙', side: 'beasts', controller: 'gm', attributes: wolfAttrs, skills: { melee: 2, dodge: 1 }, maxHp: 10, band: 3, weaponId: 'claws', armorId: 'hide' },
  ];
  state = startCombat({ id: `demo-${Date.now()}`, combatants: setups, rules: R, rng: randomRng, now: clock });
  $('cb-log').innerHTML = '';
  log(state.events);
  runNpcs();
}

function send(combatantId: string, action: CombatAction) {
  const c = state.combatants[combatantId];
  const actor = c.controller === 'gm' ? { userId: 'gm', role: 'gm' as const } : { userId: c.controller, role: 'player' as const };
  const res = submitAction(state, { actionId: `d${++n}`, actor, combatantId, round: state.round, action }, R, randomRng, clock);
  state = res.state;
  log(res.events);
}

/** NPCs (wolves and the medic) act until it is the player's turn or the fight ends. */
function runNpcs() {
  let guard = 0;
  while (state.status === 'active' && state.turn && state.turn.combatantId !== PLAYER && guard++ < 200) {
    send(state.turn.combatantId, autopilot(state));
  }
  render();
}

function act(action: CombatAction) {
  $('cb-error').textContent = '';
  try {
    send(PLAYER, action);
  } catch (e) {
    $('cb-error').textContent = e instanceof CombatError ? e.message : String(e);
    return;
  }
  runNpcs();
}

function render() {
  const s = state;
  const me = s.combatants[PLAYER];
  $('cb-bands').innerHTML = CFG.bands.names.map((bandName, i) => `<div class="band"><span class="band-name">${bandName}</span>${
    Object.values(s.combatants).filter((c) => c.band === i).map((c) => {
      const pct = Math.max(0, (c.hp / c.maxHp) * 100);
      return `<div class="token side-${c.side} c-${c.condition}${s.turn?.combatantId === c.id ? ' current' : ''}">
        <span class="tk-name">${esc(c.name)}</span>
        <span class="tk-hp"><i style="width:${pct}%"></i></span>
        <span class="tk-meta">HP ${c.hp}/${c.maxHp}｜${COND[c.condition]}${c.condition === 'dying' ? `（${c.dying.successes}✓ ${c.dying.failures}✗）` : ''}${c.defending ? '｜防禦中' : ''}</span>
      </div>`;
    }).join('')}</div>`).join('');

  const myTurn = s.status === 'active' && s.turn?.combatantId === PLAYER;
  $('cb-status').textContent = s.status === 'ended'
    ? (s.winner === 'party' ? '戰鬥結束：我方勝利' : '戰鬥結束：我方落敗')
    : myTurn ? `第 ${s.round} 輪，輪到你。剩 ${s.turn!.ap} AP` : `第 ${s.round} 輪`;
  const enemies = Object.values(s.combatants).filter((c) => c.side !== 'party' && c.condition !== 'dead' && c.condition !== 'escaped');
  const tSel = $<HTMLSelectElement>('cb-target');
  const prev = tSel.value;
  tSel.innerHTML = enemies.map((c) => `<option value="${c.id}">${esc(c.name)}（${CFG.bands.names[c.band]}）</option>`).join('');
  if (enemies.some((e) => e.id === prev)) tSel.value = prev;
  const w = weapon(me.weaponId);
  $('cb-reach').textContent = `${w.name}：傷害 ${w.damage}，射程 ${w.range === 0 ? '近身' : `${w.range} 個距離`}`;
  const allyDying = Object.values(s.combatants).find((c) => c.side === 'party' && c.id !== PLAYER && c.condition === 'dying');
  for (const b of document.querySelectorAll<HTMLButtonElement>('#cb-actions button')) {
    b.disabled = !myTurn || (b.dataset.act === 'rescue' && !allyDying) || (b.dataset.act === 'potion' && me.potions <= 0)
      || (b.dataset.act === 'left' && me.band === 0) || (b.dataset.act === 'right' && me.band === CFG.bands.count - 1)
      || (b.dataset.act === 'attack' && !enemies.some(canAct) && !enemies.length);
  }
  $<HTMLButtonElement>('cb-timeout').disabled = !myTurn;
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
    else if (a === 'attack') act({ type: 'attack', targetId: $<HTMLSelectElement>('cb-target').value });
    else if (a === 'defend') act({ type: 'defend' });
    else if (a === 'potion') act({ type: 'usePotion' });
    else if (a === 'rescue') {
      const ally = Object.values(state.combatants).find((c) => c.side === 'party' && c.id !== PLAYER && c.condition === 'dying')!;
      act({ type: 'rescue', targetId: ally.id, useMedkit: me.medkits > 0 });
    } else if (a === 'escape') act({ type: 'escape' });
    else if (a === 'end') act({ type: 'endTurn' });
  });
  $('cb-timeout').addEventListener('click', () => {
    clock = new Date(new Date(state.turn!.deadline).getTime() + 1000);
    const res = applyTimeout(state, R, randomRng, clock);
    state = res.state;
    log(res.events);
    runNpcs();
  });
  $('cb-new').addEventListener('click', newFight);
  newFight();
}
