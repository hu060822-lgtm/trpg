// World sandbox (Phases 3–4): two players and three GMs share one world on the real world and economy engines.
// Switching the viewer shows exactly what that person's API would return: redacted state and filtered history.
import seed from '../config/world-seed.json';
import { autopilot } from '../src/combat/autopilot';
import { startCombat, submitAction } from '../src/combat/engine';
import type { CombatantSetup } from '../src/combat/types';
import { maxHp } from '../src/character/create';
import { DEFAULT_RULES as R } from '../src/rules/config';
import { randomRng } from '../src/rules/dice';
import type { AttributeCode } from '../src/rules/types';
import { WORLD_V03 as CFG, WorldError, applyWorld, createWorld, joinWorld, pvpLegality, type WorldSeed } from '../src/world/engine';
import type { LedgerEntry, WorldActor, WorldCommand, WorldEvent, WorldState } from '../src/world/types';
import { auditFor, historyFor, ledgerFor, viewFor } from '../src/world/view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const attrs = (o: Partial<Record<AttributeCode, number>>): Record<AttributeCode, number> =>
  ({ STR: 1, AGI: 1, VIT: 1, PRE: 1, PER: 1, INT: 1, WIL: 1, CHA: 1, INS: 1, SPR: 1, ...o });

interface Viewer { key: string; label: string; actor: WorldActor; characterId?: string }
const VIEWERS: Viewer[] = [
  { key: 'crow', label: '灰鴉（玩家 A）', actor: { userId: 'u1', role: 'player' }, characterId: 'crow' },
  { key: 'nightingale', label: '夜鶯（玩家 B）', actor: { userId: 'u2', role: 'player' }, characterId: 'nightingale' },
  { key: 'main', label: '主 GM', actor: { userId: 'gm-main', role: 'gm' } },
  { key: 'scene', label: '遺跡場景 GM', actor: { userId: 'gm-ruins', role: 'gm' } },
  { key: 'arb', label: '仲裁 GM', actor: { userId: 'gm-arb', role: 'gm' } },
];
const VIS: Record<string, string> = { public: '公開', scene: '場景', private: '私人', gm: 'GM' };

let state: WorldState;
let events: WorldEvent[] = [];
let changes: ReturnType<typeof applyWorld>['changes'] = [];
let ledger: LedgerEntry[] = [];
/** Stands in for the store's request table: a request id is applied once. */
let requests = new Map<string, string>();
let reqSeq = 0;
let now = new Date();
let viewer = VIEWERS[0];
let flash = '';

function reset() {
  now = new Date();
  let s = createWorld(seed as WorldSeed, { 'gm-main': { role: 'main' }, 'gm-ruins': { role: 'scene', locations: ['ruins'] }, 'gm-arb': { role: 'arbiter' } });
  s = joinWorld(s, { id: 'crow', ownerUserId: 'u1', name: '灰鴉', attributes: attrs({ STR: 3, VIT: 3, PER: 2 }), skills: { melee: 3, scouting: 2 }, coins: 40 }, 'road');
  s = joinWorld(s, { id: 'nightingale', ownerUserId: 'u2', name: '夜鶯', attributes: attrs({ AGI: 3, PRE: 3, INT: 2 }), skills: { stealth: 3, pickpocket: 3 }, coins: 25 }, 'road');
  state = s;
  events = [];
  changes = [];
  ledger = [];
  requests = new Map();
  flash = '';
  render();
}

function send(actor: WorldActor, command: WorldCommand, label?: string, requestId?: string): boolean {
  try {
    if (requestId && requests.has(requestId)) {
      flash = `↺ 請求 ${requestId} 已經處理過，這次沒有重複執行，也沒有重複扣款`;
      render();
      return true;
    }
    const r = applyWorld(state, { actor, command, requestId }, R, randomRng, now);
    state = r.state;
    events.push(...r.events);
    changes.push(...r.changes);
    ledger.push(...r.ledger);
    if (requestId) requests.set(requestId, JSON.stringify(command));
    const seen = historyFor(state, viewer.actor, r.events).at(-1)?.text;
    flash = `✔ ${label ?? seen ?? '已執行'}`;
    if (r.pvp) flash = `✔ ${r.pvp.legality.reason}。${fightOut(r.pvp.attackerId, r.pvp.targetId, r.pvp.legality.lethal)}`;
    if (command.type === 'gmRuling') applyDeathRuling(command.rulingId);
    render();
    return true;
  } catch (e) {
    flash = `✘ ${e instanceof WorldError ? e.message : String(e)}`;
    render();
    return false;
  }
}

/**
 * Stands in for the server's PvP combat: both sides fight on autopilot on the real combat engine,
 * with every death held for a GM ruling, then the results are written back to the world.
 */
function fightOut(attackerId: string, targetId: string, lethal: boolean): string {
  const setup = (id: string, protect: boolean): CombatantSetup => {
    const c = state.characters[id];
    return {
      id, name: c.name, side: id, controller: c.ownerUserId, characterId: id, attributes: c.attributes, skills: c.skills,
      maxHp: maxHp(c.attributes, R), band: 1, weaponId: 'sword', armorId: 'leather', deathProtected: protect, deathNeedsRuling: true,
    };
  };
  let cs = startCombat({ id: `pvp-${state.seq}`, combatants: [setup(attackerId, false), setup(targetId, !lethal)], rules: R, rng: randomRng, now, resolveDying: true });
  for (let i = 0; i < 400 && cs.status === 'active' && cs.turn; i++) {
    const c = cs.combatants[cs.turn.combatantId];
    cs = submitAction(cs, { actionId: `a${i}`, actor: { userId: c.controller, role: 'player' }, combatantId: c.id, round: cs.round, action: autopilot(cs) }, R, randomRng, now).state;
  }
  const lines: string[] = [];
  for (const c of Object.values(cs.combatants)) {
    const w = state.characters[c.id];
    w.condition = c.pendingDeath ? 'deathPending' : c.condition;
    lines.push(`${c.name} ${c.pendingDeath ? '被判定死亡，等 GM 確認' : c.condition === 'stable' ? '昏迷' : `剩 ${c.hp} HP`}`);
    if (c.pendingDeath) {
      const other = c.id === attackerId ? targetId : attackerId;
      const r = applyWorld(state, { actor: { userId: 'system', role: 'system' }, command: { type: 'openDeathRuling', characterId: c.id, attackerId: other, combatId: cs.id, cause: c.pendingDeath } }, R, randomRng, now);
      state = r.state;
      events.push(...r.events);
      changes.push(...r.changes);
    }
  }
  return `戰鬥打了 ${cs.round} 輪：${lines.join('；')}。`;
}

/** The server writes a closed death ruling to the character; the sandbox does the same in memory. */
function applyDeathRuling(id: string) {
  const r = state.rulings[id];
  if (r?.kind !== 'pvp-death' || r.status === 'open') return;
  const c = state.characters[r.characterId!];
  if (r.status === 'confirmed') { c.status = 'dead'; c.condition = 'dead'; } else c.condition = 'stable';
}

/** Both players act on the same snapshot of the world; only one commit can win. */
function race() {
  const snap = state;
  const seen = snap.items['bell-heart'].version;
  const results: string[] = [];
  for (const [who, actor] of [['crow', VIEWERS[0].actor], ['nightingale', VIEWERS[1].actor]] as const) {
    try {
      const base = results.length ? state : snap;
      const r = applyWorld(base, { actor, command: { type: 'take', characterId: who, itemId: 'bell-heart' }, expected: { 'bell-heart': seen } }, R, randomRng, now);
      state = r.state;
      events.push(...r.events);
      changes.push(...r.changes);
      results.push(`${state.characters[who].name}：成功取得`);
    } catch (e) {
      results.push(`${snap.characters[who].name}：${(e as Error).message}`);
    }
  }
  flash = `同時搶沉鐘之心 → ${results.join('；')}`;
  render();
}

function zoneBadge(z: keyof typeof CFG.zones) {
  return `<span class="zone zone-${z}">${CFG.zones[z].name}</span>`;
}

function render() {
  const v = viewFor(state, viewer.actor);
  const me = viewer.characterId ? v.characters[viewer.characterId] : undefined;
  $('wd-viewers').innerHTML = VIEWERS.map((x) => `<button type="button" data-viewer="${x.key}" aria-pressed="${x.key === viewer.key}">${x.label}</button>`).join('');
  $('wd-clock').textContent = `世界第 ${state.day} 天・${now.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;

  // Map: what this viewer can see of each location.
  $('wd-map').innerHTML = Object.values(v.locations).map((l) => {
    const people = Object.values(v.characters).filter((c) => c.locationId === l.id);
    const ground = Object.values(v.items).filter((i) => i.holder.type === 'location' && i.holder.id === l.id && i.status === 'present');
    const npcs = Object.values(v.npcs).filter((n) => n.locationId === l.id);
    const st = Object.entries(l.state);
    return `<article class="loc${me?.locationId === l.id ? ' here' : ''}">
      <header><b>${esc(l.name)}</b>${zoneBadge(l.zone)}${l.outpost ? '<span class="zone">據點</span>' : ''}</header>
      <p class="loc-desc">${esc(l.description)}</p>
      ${l.gmNotes ? `<p class="loc-gm">GM 備註：${esc(l.gmNotes)}</p>` : ''}
      <ul class="loc-list">
        ${people.map((c) => `<li>🧍 ${esc(c.name)}${c.online ? '' : c.afterimageUntil || viewer.characterId !== c.id ? '（殘影／離線）' : '（離線）'}${({ dead: '（死亡）', deathPending: '（待確認死亡）', stable: '（昏迷）', dying: '（瀕死）' } as Record<string, string>)[c.status === 'dead' ? 'dead' : c.condition] ?? ''}${c.crimes.length ? `<span class="crime">前科 ${c.crimes.length}</span>` : ''}</li>`).join('')}
        ${npcs.map((n) => `<li>${n.status === 'dead' ? '✝' : '◆'} ${esc(n.name)}${n.status === 'dead' ? '（已死亡）' : ''}${n.public ? '' : '<span class="crime">隱密</span>'}</li>`).join('')}
        ${ground.map((i) => `<li>✦ ${esc(i.name)}${!i.hidden ? '' : viewer.characterId ? '（你發現的）' : `（隱藏・TN ${i.hidden.tn}${i.discoveredBy.length ? `・已被 ${i.discoveredBy.map((c) => esc(state.characters[c].name)).join('、')} 發現` : ''}）`}</li>`).join('')}
        ${st.map(([k, val]) => `<li class="muted">${esc(k)}：${esc(String(val))}</li>`).join('')}
      </ul>
      <footer>場景時鐘 ${Math.floor(l.clock / 60)}:${String(l.clock % 60).padStart(2, '0')}・${l.links.map((k) => `→ ${esc(state.locations[k.to].name)} ${k.minutes} 分`).join('　')}</footer>
    </article>`;
  }).join('');

  renderActions(v, me);

  const hist = historyFor(state, viewer.actor, events).slice().reverse();
  $('wd-history').innerHTML = hist.length
    ? hist.map((e) => `<li class="v-${e.visibility}"><span class="vis">${VIS[e.visibility]}</span><span>${esc(e.text)}</span></li>`).join('')
    : '<li class="muted">這個身分還沒有看得到的紀錄。</li>';
  const hidden = events.length - hist.length;
  $('wd-hidden').textContent = hidden ? `另有 ${hidden} 筆紀錄這個身分看不到。` : '';
  const audit = auditFor(state, viewer.actor, changes);
  $('wd-audit').textContent = viewer.key === 'main' ? `變更稽核（含變更前後狀態）：${audit.length} 筆` : '變更稽核只有主 GM 看得到。';
  renderMarket(v, me);
  const lines = ledgerFor(state, viewer.actor, ledger).slice().reverse();
  $('wd-ledger').innerHTML = lines.length
    ? lines.map((e) => `<li><span>${esc(party(e.from))} → ${esc(party(e.to))}<br><small class="muted">${esc(reasonText(e.reason))}</small></span><span class="amt">${e.coins ? `${e.coins} 枚` : esc(state.items[e.itemId!]?.name ?? e.itemId!)}</span></li>`).join('')
    : '<li class="muted">還沒有看得到的帳目。</li>';
  const coinsNow = Object.values(state.characters).reduce((a, c) => a + c.coins, 0) + Object.values(state.economy.locks).filter((l) => l.status === 'held').reduce((a, l) => a + l.coins, 0);
  const minted = ledger.filter((e) => e.from.type === 'mint').reduce((a, e) => a + (e.coins ?? 0), 0);
  const sunk = ledger.filter((e) => e.to.type === 'sink').reduce((a, e) => a + (e.coins ?? 0), 0);
  $('wd-ledger-note').textContent = viewer.key === 'main' || viewer.key === 'arb'
    ? `對帳：角色錢幣＋鎖定中 = ${coinsNow}；起始 65＋發放 ${minted}－銷毀 ${sunk} = ${65 + minted - sunk}${coinsNow === 65 + minted - sunk ? '，一致 ✔' : '，不一致 ✘'}`
    : '玩家只看得到和自己角色、自己參與的鎖定有關的帳目。';
  $('wd-flash').textContent = flash;
  $('wd-flash').className = `wd-flash${flash.startsWith('✘') ? ' bad' : ''}`;
}

function btn(id: string, label: string, sub = '', disabled = false) {
  return `<button type="button" data-cmd="${esc(id)}"${disabled ? ' disabled' : ''}><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;
}

function renderActions(v: WorldState, me: WorldState['characters'][string] | undefined) {
  const box = $('wd-actions');
  if (me) {
    const l = state.locations[me.locationId];
    const other = Object.values(state.characters).find((c) => c.id !== me.id)!;
    const mine = Object.values(v.items).filter((i) => i.holder.type === 'character' && i.holder.id === me.id);
    const ground = Object.values(v.items).filter((i) => i.holder.type === 'location' && i.holder.id === me.locationId && i.status === 'present');
    const legal = pvpLegality(state, me.id, other.id, now);
    const loot = Object.values(state.items).find((i) => i.holder.type === 'character' && i.holder.id === other.id && i.tradable && !i.boundTo && !i.lockedBy);
    const sameSpot = other.locationId === me.locationId;
    const invite = state.duels.find((d) => d.to === me.id && d.status === 'pending' && now < new Date(d.expires));
    box.innerHTML = `
      <p class="wd-me">${esc(me.name)} 在<b>${esc(l.name)}</b>${zoneBadge(l.zone)}・${me.online ? '在線' : me.afterimageUntil ? `殘影到 ${new Date(me.afterimageUntil).toLocaleString('zh-TW')}` : '已安全下線'}・錢幣 ${me.coins}
        ${mine.length ? `・身上：${mine.map((i) => esc(i.name) + (i.lockedBy ? '（裁決中）' : i.boundTo ? '（綁定）' : '')).join('、')}` : ''}</p>
      <div class="wd-btns">
        ${l.links.map((k) => btn(`move:${k.to}`, `前往${state.locations[k.to].name}`, `${k.minutes} 分鐘`, !me.online)).join('')}
        ${ground.map((i) => btn(`take:${i.id}`, `拿取${i.name}`, i.unique ? '唯一物品' : '', !me.online)).join('')}
        ${btn('search', '仔細搜索', `${CFG.search.minutes} 分鐘・感知＋偵查`, !me.online)}
        ${btn('wait', '等待 1 小時', '推進場景時鐘', !me.online)}
        ${me.online ? btn('off', '下線', l.zone === 'safe' || l.outpost ? '安全下線' : '會留下殘影 24 小時') : btn('on', '上線')}
      </div>
      <h4 class="wd-sub">對 ${esc(other.name)}${sameSpot ? '' : '（不在這裡）'}</h4>
      <div class="wd-btns">
        ${btn('hostile', '公開宣告敵意', '管制區開打前要先宣告', !me.online || !sameSpot)}
        ${btn('attack', '突襲', legal.allowed ? (legal.lethal ? '合法・可能致命' : '合法・最多打到昏迷') : legal.reason, !me.online || !legal.allowed)}
        ${btn('duel', '提出決鬥邀請', '對方接受才可能致命', !me.online || other.status === 'dead')}
        ${invite ? btn(`accept:${invite.id}`, `接受 ${state.characters[invite.from].name} 的決鬥`, '可能致命・死亡要 GM 確認', !me.online) + btn(`decline:${invite.id}`, '拒絕決鬥') : ''}
        ${btn('steal', '偷竊', loot ? `接近→得手→察覺→證據（目標：${loot.name}）` : '對方身上沒有可偷的東西', !me.online || !sameSpot || !loot)}
        ${btn('race', '兩人同時搶沉鐘之心', '模擬同一瞬間的兩筆操作')}
        ${btn('forge', '假冒 GM 發公告', '測試未授權修改')}
      </div>`;
    return;
  }
  const rulings = Object.values(state.rulings).filter((r) => r.status === 'open');
  const g = viewer.key === 'main';
  box.innerHTML = `
    <p class="wd-me">${g ? '主 GM：可以操作整個世界，看得到所有紀錄與稽核。' : viewer.key === 'arb' ? '仲裁 GM：不能改世界，負責驗收委託、確認契約條款與裁決交易爭議（在下方市集面板操作）。' : '遺跡場景 GM：只能操作沉鐘遺跡裡的地點、NPC 與物品。'}</p>
    <div class="wd-btns">
      ${btn('kill-keeper', '守墓人老楊死亡', '公開 NPC，全世界都會知道')}
      ${btn('kill-smuggler', '走私販死亡', '隱密 NPC，只有在場者知道')}
      ${btn('open-gate', '炸開鐘樓大門', '改變遺跡的地點狀態')}
      ${btn('market-safe', '市集改為安全區', '只有主 GM 能改區域')}
      ${btn('publish', '發布世界事件', '公開公告')}
      ${btn('day', '推進一天', '1 遊戲日＝現實 1 日')}
      ${btn('skip', '時間快轉 24 小時', '讓殘影到期並結算')}
    </div>
    ${rulings.length ? `<h4 class="wd-sub">待裁決</h4><div class="wd-btns">${rulings.map((r) => `${btn(`confirm:${r.id}`, `${r.kind === 'pvp-death' ? '確認死亡' : '維持'} ${r.id}`, r.summary)}${btn(`overturn:${r.id}`, `撤銷 ${r.id}`, r.kind === 'pvp-death' ? '死亡不成立，以 1 HP 倖存' : '物品歸還原主')}`).join('')}</div>` : '<p class="muted">目前沒有待裁決的案件。</p>'}`;
}

function onCommand(cmd: string) {
  const a = viewer.actor;
  const me = viewer.characterId;
  const other = me === 'crow' ? 'nightingale' : 'crow';
  const [k, arg] = cmd.split(':');
  if (me) {
    if (k === 'move') return send(a, { type: 'move', characterId: me, to: arg });
    if (k === 'take') return send(a, { type: 'take', characterId: me, itemId: arg }, `取得${state.items[arg].name}`);
    if (k === 'search') return send(a, { type: 'search', characterId: me }, '搜索完成，結果在紀錄裡（只有你看得到）');
    if (k === 'wait') return send(a, { type: 'wait', characterId: me, minutes: 60 });
    if (k === 'off') return send(a, { type: 'setOnline', characterId: me, online: false });
    if (k === 'on') return send(a, { type: 'setOnline', characterId: me, online: true });
    if (k === 'hostile') return send(a, { type: 'declareHostility', characterId: me, targetId: other }, '已公開宣告敵意');
    if (k === 'attack') return send(a, { type: 'attack', characterId: me, targetId: other });
    if (k === 'duel') return send(a, { type: 'inviteDuel', characterId: me, targetId: other }, '已送出決鬥邀請，切換到對方身分就能回覆');
    if (k === 'accept') return send(a, { type: 'respondDuel', characterId: me, duelId: arg, accept: true });
    if (k === 'decline') return send(a, { type: 'respondDuel', characterId: me, duelId: arg, accept: false });
    if (k === 'steal') {
      const loot = Object.values(state.items).find((i) => i.holder.type === 'character' && i.holder.id === other && i.tradable && !i.boundTo && !i.lockedBy)!;
      return send(a, { type: 'steal', characterId: me, targetId: other, itemId: loot.id }, '偷竊判定完成，結果在紀錄裡');
    }
    if (k === 'race') return race();
    if (k === 'forge') return send({ userId: a.userId, role: 'gm' }, { type: 'gmPublish', title: '假公告', body: '城門今晚關閉' });
  }
  if (k === 'kill-keeper') return send(a, { type: 'gmSetNpcStatus', npcId: 'keeper', status: 'dead', basis: '沙盒操作' });
  if (k === 'kill-smuggler') return send(a, { type: 'gmSetNpcStatus', npcId: 'smuggler', status: 'dead', basis: '沙盒操作' });
  if (k === 'open-gate') return send(a, { type: 'gmSetLocationState', locationId: 'ruins', key: '鐘樓大門', value: '被炸開' });
  if (k === 'market-safe') return send(a, { type: 'gmSetZone', locationId: 'market', zone: 'safe' });
  if (k === 'publish') return send(a, { type: 'gmPublish', title: '鐘聲', body: '沉鐘遺跡深處傳來第一聲鐘響。' });
  if (k === 'day') return send(a, { type: 'advanceDay' });
  if (k === 'skip') {
    now = new Date(now.getTime() + 24 * 3600_000 + 1000);
    return send(a, { type: 'expireAfterimages' }, '時間快轉 24 小時');
  }
  if (k === 'confirm' || k === 'overturn') return send(a, { type: 'gmRuling', rulingId: arg, decision: k });
  if (k.startsWith('m-')) return onMarket(k, arg);
}

// ---------- Phase 4 market panel ----------

const STATUS: Record<string, [string, string]> = {
  pending: ['待回覆', 'wait'], completed: ['完成', 'ok'], cancelled: ['已取消', ''], declined: ['被拒絕', ''],
  published: ['招募中', 'wait'], accepted: ['進行中', 'wait'], submitted: ['待驗收', 'wait'], expired: ['逾期', 'bad'], disputed: ['爭議中', 'bad'],
  proposed: ['待簽署', 'wait'], active: ['生效中', 'wait'], fulfilled: ['已履行', 'ok'], breached: ['違約', 'bad'],
};
const stBadge = (st: string) => `<span class="st${STATUS[st]?.[1] ? ` st-${STATUS[st][1]}` : ''}">${STATUS[st]?.[0] ?? st}</span>`;
const who = (id: string) => state.characters[id]?.name ?? id;
const itemName = (id: string) => state.items[id]?.name ?? id;

function party(p: LedgerEntry['from']): string {
  if (p.type === 'character') return who(p.id);
  if (p.type === 'escrow') return `鎖定 ${p.id}`;
  if (p.type === 'shop') return `商店「${state.economy.shops[p.id]?.name ?? p.id}」`;
  if (p.type === 'mint') return 'GM 發放';
  if (p.type === 'sink') return '銷毀';
  return p.id;
}

/** Ledger reasons are stable English keys on the server; the sandbox shows them in Chinese. */
const REASONS: [RegExp, string][] = [
  [/^grant: /, '發放：'], [/breach of (\S+): deposit forfeited/, '$1 違約，押金沒收'], [/\bunstock\b/, '下架'], [/\bstock\b/, '上架'], [/\bbuy\b/, '購買'],
  [/\bsale\b/, '售出'], [/\block\b/, '鎖定'], [/\bcontract\b/, '契約'], [/\bclause\b/, '條款'], [/\bcommission\b/, '委託'], [/\btrade\b/, '交易'],
  [/\bdispute\b/, '爭議'], [/\breward\b/, '報酬'], [/\bdelivery\b/, '交付'], [/\breturn delivery\b/, '退回交付'], [/\breturned\b/, '退回'],
  [/\brefund\b/, '退款'], [/\bpay\b/, '付款'], [/\bfulfilled\b/, '履行完成'], [/\bclosed\b/, '結束'], [/\bcancelled by agreement\b/, '雙方解約'],
  [/\bcancelled\b/, '取消'], [/\bcancel\b/, '解約'], [/\bdeclined\b/, '被拒絕'], [/\bexpired unsigned\b/, '未簽署作廢'], [/\bexpired\b/, '逾期'],
  [/\bwithdrawn\b/, '撤回'], [/ at /, '，商店 '], [/^afterimage 逾期$/, '殘影到期'],
];
const reasonText = (r: string) => REASONS.reduce((t, [re, to]) => t.replace(new RegExp(re.source, 'g'), to), r);

const later = (days: number) => new Date(now.getTime() + days * 86400_000).toISOString();
const nextReq = (label: string) => `${label}-${++reqSeq}`;

function clauseText(c: WorldState['economy']['contracts'][string]['clauses'][number]): string {
  if (c.kind === 'payCoins') return `${who(c.from)} 付 ${c.amount} 枚給 ${who(c.to)}`;
  if (c.kind === 'deliverItem') return `${who(c.from)} 交出${itemName(c.itemId)}給 ${who(c.to)}`;
  if (c.kind === 'deliverTemplate') return `${who(c.from)} 交 ${c.qty} 件${c.template === 'moonherb' ? '月光草' : c.template}給 ${who(c.to)}`;
  return `${who(c.from)}：${c.text}（GM 確認）`;
}

function renderMarket(v: WorldState, me: WorldState['characters'][string] | undefined) {
  const e = v.economy;
  const gm = !me;
  const myItems = me ? Object.values(v.items).filter((i) => i.holder.type === 'character' && i.holder.id === me.id && i.tradable && !i.boundTo && !i.lockedBy && i.status === 'present') : [];
  const other = me ? Object.values(state.characters).find((c) => c.id !== me.id)! : undefined;
  const myShop = me ? Object.values(e.shops).find((sh) => sh.ownerId === me.id) : undefined;
  const herbs = (id: string) => Object.values(state.items).filter((i) => i.template === 'moonherb' && i.holder.type === 'character' && i.holder.id === id).map((i) => i.id);
  const out: string[] = [];

  // Shops
  const shops = Object.values(e.shops);
  out.push('<h4 class="wd-sub">商店</h4>');
  out.push(shops.length ? shops.map((sh) => {
    const mine = me && sh.ownerId === me.id;
    const canBuy = me && !mine && sh.open && me.locationId === sh.locationId && me.online;
    return `<div class="wd-card"><header><b>${esc(sh.name)}</b><span class="muted">${esc(who(sh.ownerId))}・${esc(state.locations[sh.locationId].name)}</span>${sh.open ? '<span class="st st-ok">營業中</span>' : '<span class="st">休息</span>'}</header>
      ${sh.listings.length ? `<div class="wd-btns">${sh.listings.map((l) => mine
        ? btn(`m-unstock:${sh.id}|${l.itemId}`, `下架${itemName(l.itemId)}`, `售價 ${l.price}`)
        : btn(`m-buy:${sh.id}|${l.itemId}`, `買${itemName(l.itemId)}`, me && me.locationId !== sh.locationId ? `${l.price} 枚・要到店裡才能買` : `${l.price} 枚`, !canBuy)).join('')}</div>` : '<span class="muted">架上沒有東西</span>'}
      ${mine ? `<div class="wd-btns">${btn(`m-shopopen:${sh.id}|${sh.open ? '0' : '1'}`, sh.open ? '暫停營業' : '開始營業')}${myItems.map((i) => btn(`m-stock:${sh.id}|${i.id}`, `上架${i.name}`, '售價 10 枚')).join('')}</div>` : ''}
      ${canBuy && sh.listings[0] ? `<div class="wd-btns">${btn(`m-dblbuy:${sh.id}|${sh.listings[0].itemId}`, '模擬連點兩次購買', '同一個請求送兩次，只會扣一次款')}</div>` : ''}
    </div>`;
  }).join('') : '<p class="muted">還沒有人開店。</p>');
  if (me && !myShop) out.push(`<div class="wd-btns">${btn('m-openshop', `在${state.locations[me.locationId].name}開店`, '商店只賣真的放在店裡的物品', !me.online)}</div>`);

  // Trades
  const trades = Object.values(e.trades);
  out.push('<h4 class="wd-sub">直接交易</h4>');
  out.push(trades.length ? trades.map((t) => {
    const b = (x: typeof t.give) => [x.coins ? `${x.coins} 枚` : '', ...x.itemIds.map(itemName)].filter(Boolean).join('＋') || '什麼都沒有';
    const acts = me && t.status === 'pending'
      ? t.to === me.id ? btn(`m-accepttrade:${t.id}`, '接受交易', '雙方要在同一個地點') + btn(`m-declinetrade:${t.id}`, '拒絕')
        : t.from === me.id ? btn(`m-canceltrade:${t.id}`, '取消交易', '鎖定的東西退回') : '' : '';
    return `<div class="wd-card"><header><b>${t.id}</b>${stBadge(t.status)}</header><span>${esc(who(t.from))} 出 ${esc(b(t.give))}（已鎖定）⇄ ${esc(who(t.to))} 出 ${esc(b(t.want))}</span>${acts ? `<div class="wd-btns">${acts}</div>` : ''}</div>`;
  }).join('') : `<p class="muted">${gm && viewer.key === 'scene' ? '場景 GM 看不到玩家之間的交易。' : '沒有看得到的交易。'}</p>`);
  if (me && other) {
    const theirs = Object.values(state.items).find((i) => i.holder.type === 'character' && i.holder.id === other.id && i.tradable && !i.boundTo && !i.lockedBy);
    out.push(`<div class="wd-btns">${btn('m-proposetrade', theirs ? `出 10 枚換 ${other.name} 的${theirs.name}` : `送 ${other.name} 5 枚`, '你出的東西會先鎖定', !me.online || other.status === 'dead')}</div>`);
  }

  // Commissions
  const coms = Object.values(e.commissions);
  out.push('<h4 class="wd-sub">委託板（公開）</h4>');
  out.push(coms.length ? coms.map((k) => {
    const acts: string[] = [];
    if (me && k.status === 'published' && k.issuerId !== me.id) acts.push(btn(`m-acceptcom:${k.id}`, '接下委託', '', !me.online));
    if (me && k.status === 'published' && k.issuerId === me.id) acts.push(btn(`m-cancelcom:${k.id}`, '取消委託', '還沒人接才能取消'));
    if (me && k.status === 'accepted' && k.contractorId === me.id) {
      const need = k.requirement.kind === 'deliver' ? k.requirement.qty : 0;
      const have = herbs(me.id).length;
      acts.push(btn(`m-submitcom:${k.id}`, '提交', k.requirement.kind === 'deliver' ? `身上月光草 ${have}／${need}` : '交給 GM 驗收', !me.online || have < need));
    }
    if (me && ['accepted', 'submitted'].includes(k.status) && [k.issuerId, k.contractorId].includes(me.id)) acts.push(btn(`m-dispute:commission|${k.id}`, '提出爭議', '資產凍結，等仲裁'));
    if (gm && k.status === 'submitted') acts.push(btn(`m-review:${k.id}|1`, '驗收通過', `報酬給 ${who(k.contractorId!)}`), btn(`m-review:${k.id}|0`, '退回重交'));
    const req = k.requirement.kind === 'deliver' ? `交 ${k.requirement.qty} 株月光草（系統自動驗收）` : `${k.requirement.text}（GM 驗收）`;
    return `<div class="wd-card"><header><b>${esc(k.title)}</b>${stBadge(k.status)}<span class="muted">報酬 ${k.reward}${['published', 'accepted', 'submitted', 'disputed'].includes(k.status) ? '（已鎖定）' : ''}・${esc(who(k.issuerId))}${k.contractorId ? ` → ${esc(who(k.contractorId))}` : ''}</span></header><span>${esc(req)}・期限 ${new Date(k.deadline).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>${acts.length ? `<div class="wd-btns">${acts.join('')}</div>` : ''}</div>`;
  }).join('') : '<p class="muted">委託板是空的。</p>');
  if (me) out.push(`<div class="wd-btns">${btn('m-postdeliver', '發布：採三株月光草', '報酬 15・兩天內・自動驗收', !me.online)}${btn('m-postgm', '發布：查出走私販下落', '報酬 10・兩天內・GM 驗收', !me.online)}</div>`);

  // Contracts
  const ks = Object.values(e.contracts);
  out.push('<h4 class="wd-sub">契約</h4>');
  out.push(ks.length ? ks.map((k) => {
    const acts: string[] = [];
    if (me && k.parties.includes(me.id)) {
      if (k.status === 'proposed' && !k.signed.includes(me.id)) acts.push(btn(`m-sign:${k.id}`, '簽署', k.deposits[me.id] ? `鎖定押金 ${k.deposits[me.id]}` : '', !me.online));
      if (k.status === 'active') {
        for (const c of k.clauses.filter((c) => !c.done && c.from === me.id && c.kind !== 'gmVerified')) acts.push(btn(`m-fulfill:${k.id}|${c.id}`, `履行 ${c.id.split('-').pop()}`, clauseText(c), !me.online));
        acts.push(btn(`m-dispute:contract|${k.id}`, '提出爭議', '契約凍結，等仲裁'));
      }
      if (k.status === 'proposed' || k.status === 'active') acts.push(btn(`m-cancelk:${k.id}`, k.status === 'proposed' ? '撤回' : k.cancelRequests.includes(me.id) ? '已提議解約' : '提議解約', k.status === 'active' ? '雙方都同意才解約' : '', k.cancelRequests.includes(me.id)));
    }
    if (gm && k.status === 'active') for (const c of k.clauses.filter((c) => !c.done && c.kind === 'gmVerified')) acts.push(btn(`m-verify:${k.id}|${c.id}`, `確認條款 ${c.id.split('-').pop()}`, c.kind === 'gmVerified' ? c.text : ''));
    return `<div class="wd-card"><header><b>${esc(k.title)}</b>${stBadge(k.status)}<span class="muted">${k.parties.map(who).map(esc).join(' ⇄ ')}・押金 ${k.parties.map((p) => k.deposits[p] ?? 0).join('／')}</span></header>
      <ul class="loc-list">${k.clauses.map((c) => `<li>${c.done ? '☑' : '☐'} ${esc(clauseText(c))}</li>`).join('')}</ul>
      ${k.breachedBy ? `<span class="muted">違約方：${k.breachedBy.map(who).map(esc).join('、')}</span>` : ''}
      ${acts.length ? `<div class="wd-btns">${acts.join('')}</div>` : ''}</div>`;
  }).join('') : '<p class="muted">沒有看得到的契約。</p>');
  if (me && other) out.push(`<div class="wd-btns">${btn('m-propose', `和 ${other.name} 立約：月光草供貨`, `你付 8 枚，對方交 1 株月光草・押金各 5`, !me.online || other.status === 'dead')}${btn('m-proposegm', `和 ${other.name} 立約：護送`, '對方護送你到遺跡・GM 確認・押金各 5', !me.online || other.status === 'dead')}</div>`);

  // Disputes and GM tools
  const ds = Object.values(e.disputes).filter((d) => d.status === 'open');
  if (ds.length) {
    out.push('<h4 class="wd-sub">待裁決的交易爭議</h4>');
    out.push(ds.map((d) => {
      const opts = gm ? (d.kind === 'commission'
        ? btn(`m-resolve:${d.id}|pay`, '付給接案人') + btn(`m-resolve:${d.id}|refund`, '退回發布者')
        : btn(`m-resolve:${d.id}|fulfilled`, '視為履行') + btn(`m-resolve:${d.id}|cancel`, '解除契約') + state.economy.contracts[d.ref].parties.map((p) => btn(`m-resolve:${d.id}|breach-${p}`, `${who(p)} 違約`, '押金歸對方')).join('')) : '';
      return `<div class="wd-card"><header><b>${d.id}</b><span class="st st-bad">待仲裁</span><span class="muted">${d.kind === 'commission' ? '委託' : '契約'} ${d.ref}・${esc(who(d.raisedBy))} 提出</span></header><span>${esc(d.reason)}</span>${opts ? `<div class="wd-btns">${opts}</div>` : ''}</div>`;
    }).join(''));
  }
  if (viewer.key === 'main') out.push(`<h4 class="wd-sub">主 GM 工具</h4><div class="wd-btns">${btn('m-grant', '兩位玩家各發 20 枚', '發放會記成「GM 發放」')}${btn('m-deadline', '快轉 3 天並結算期限', '逾期委託退款、契約違約判定')}</div>`);
  $('wd-market').innerHTML = `<div class="wd-board">${out.join('')}</div>`;
}

function onMarket(k: string, arg = '') {
  const a = viewer.actor;
  const me = viewer.characterId;
  const other = me === 'crow' ? 'nightingale' : 'crow';
  const [x, y] = arg.split('|');
  const go = (command: WorldCommand, label?: string) => send(a, command, label, nextReq(command.type));
  if (k === 'm-grant') {
    go({ type: 'gmGrantCoins', characterId: 'crow', amount: 20, reason: '沙盒發放' });
    return go({ type: 'gmGrantCoins', characterId: 'nightingale', amount: 20, reason: '沙盒發放' }, '兩位玩家各獲得 20 枚錢幣');
  }
  if (k === 'm-deadline') {
    now = new Date(now.getTime() + 3 * 86400_000);
    return go({ type: 'settleDeadlines' }, '時間快轉 3 天，期限已結算');
  }
  if (k === 'm-review') return go({ type: 'reviewCommission', characterId: '', commissionId: x, approve: y === '1' });
  if (k === 'm-verify') return go({ type: 'gmVerifyClause', contractId: x, clauseId: y });
  if (k === 'm-resolve') return go({ type: 'gmResolveDispute', disputeId: x, outcome: y.startsWith('breach-') ? { breachBy: y.slice(7) } : (y as 'pay') });
  if (!me) return;
  if (k === 'm-openshop') return go({ type: 'openShop', characterId: me, shopId: `${me}-shop`, name: me === 'crow' ? '灰鴉的路邊攤' : '夜鶯的暗巷舖', description: '' });
  if (k === 'm-shopopen') return go({ type: 'setShopOpen', characterId: me, shopId: x, open: y === '1' });
  if (k === 'm-stock') return go({ type: 'stockItem', characterId: me, shopId: x, itemId: y, price: 10 });
  if (k === 'm-unstock') return go({ type: 'unstockItem', characterId: me, shopId: x, itemId: y });
  if (k === 'm-buy') return go({ type: 'buy', characterId: me, shopId: x, itemId: y });
  if (k === 'm-dblbuy') {
    const id = nextReq('buy');
    const cmd: WorldCommand = { type: 'buy', characterId: me, shopId: x, itemId: y };
    send(a, cmd, undefined, id);
    const first = flash;
    send(a, cmd, undefined, id);
    flash = `${first}　第二次：${flash}`;
    return render();
  }
  if (k === 'm-proposetrade') {
    const theirs = Object.values(state.items).find((i) => i.holder.type === 'character' && i.holder.id === other && i.tradable && !i.boundTo && !i.lockedBy);
    return go({ type: 'proposeTrade', characterId: me, to: other, give: { coins: theirs ? 10 : 5, itemIds: [] }, want: { coins: 0, itemIds: theirs ? [theirs.id] : [] } }, '已提出交易，切換到對方身分就能回覆');
  }
  if (k === 'm-accepttrade') return go({ type: 'acceptTrade', characterId: me, tradeId: x });
  if (k === 'm-declinetrade') return go({ type: 'declineTrade', characterId: me, tradeId: x });
  if (k === 'm-canceltrade') return go({ type: 'cancelTrade', characterId: me, tradeId: x });
  if (k === 'm-postdeliver') return go({ type: 'postCommission', characterId: me, title: '採三株月光草', requirement: { kind: 'deliver', template: 'moonherb', qty: 3 }, reward: 15, deadline: later(2) });
  if (k === 'm-postgm') return go({ type: 'postCommission', characterId: me, title: '查出走私販的下落', requirement: { kind: 'gm', text: '帶回可信的情報' }, reward: 10, deadline: later(2) });
  if (k === 'm-acceptcom') return go({ type: 'acceptCommission', characterId: me, commissionId: x });
  if (k === 'm-cancelcom') return go({ type: 'cancelCommission', characterId: me, commissionId: x });
  if (k === 'm-submitcom') {
    const c = state.economy.commissions[x];
    const ids = c.requirement.kind === 'deliver'
      ? Object.values(state.items).filter((i) => i.template === 'moonherb' && i.holder.type === 'character' && i.holder.id === me).slice(0, c.requirement.qty).map((i) => i.id) : [];
    return go({ type: 'submitCommission', characterId: me, commissionId: x, itemIds: ids });
  }
  if (k === 'm-dispute') return go({ type: 'raiseDispute', characterId: me, kind: x as 'contract', ref: y, reason: '對方沒有照約定履行' });
  if (k === 'm-propose') {
    return go({
      type: 'proposeContract', characterId: me, with: other, title: '月光草供貨', deadline: later(2), deposits: { [me]: 5, [other]: 5 },
      clauses: [{ kind: 'payCoins', from: me, to: other, amount: 8 }, { kind: 'deliverTemplate', from: other, to: me, template: 'moonherb', qty: 1 }],
    }, '已提出契約，切換到對方身分就能簽署');
  }
  if (k === 'm-proposegm') {
    return go({
      type: 'proposeContract', characterId: me, with: other, title: '護送到沉鐘遺跡', deadline: later(2), deposits: { [me]: 5, [other]: 5 },
      clauses: [{ kind: 'gmVerified', from: other, text: `護送${who(me)}到沉鐘遺跡` }, { kind: 'payCoins', from: me, to: other, amount: 10 }],
    }, '已提出契約，切換到對方身分就能簽署');
  }
  if (k === 'm-sign') return go({ type: 'signContract', characterId: me, contractId: x });
  if (k === 'm-fulfill') {
    const c = state.economy.contracts[x].clauses.find((c) => c.id === y)!;
    const ids = c.kind === 'deliverTemplate'
      ? Object.values(state.items).filter((i) => i.template === c.template && i.holder.type === 'character' && i.holder.id === me).slice(0, c.qty).map((i) => i.id) : undefined;
    return go({ type: 'fulfillClause', characterId: me, contractId: x, clauseId: y, itemIds: ids });
  }
  if (k === 'm-cancelk') return go({ type: 'requestCancelContract', characterId: me, contractId: x });
}

export function initWorld() {
  $('wd-viewers').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-viewer]');
    if (!b) return;
    viewer = VIEWERS.find((x) => x.key === b.dataset.viewer)!;
    flash = '';
    render();
  });
  for (const id of ['wd-actions', 'wd-market']) {
    $(id).addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-cmd]');
      if (b && !b.disabled) onCommand(b.dataset.cmd!);
    });
  }
  $('wd-reset').addEventListener('click', reset);
  reset();
}

