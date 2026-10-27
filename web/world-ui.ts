// World sandbox (Phase 3): two players and two GMs share one world on the real world engine.
// Switching the viewer shows exactly what that person's API would return: redacted state and filtered history.
import seed from '../config/world-seed.json';
import { DEFAULT_RULES as R } from '../src/rules/config';
import { randomRng } from '../src/rules/dice';
import type { AttributeCode } from '../src/rules/types';
import { WORLD_V03 as CFG, WorldError, applyWorld, createWorld, joinWorld, pvpLegality, type WorldSeed } from '../src/world/engine';
import type { WorldActor, WorldCommand, WorldEvent, WorldState } from '../src/world/types';
import { auditFor, historyFor, viewFor } from '../src/world/view';

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
];
const VIS: Record<string, string> = { public: '公開', scene: '場景', private: '私人', gm: 'GM' };

let state: WorldState;
let events: WorldEvent[] = [];
let changes: ReturnType<typeof applyWorld>['changes'] = [];
let now = new Date();
let viewer = VIEWERS[0];
let flash = '';

function reset() {
  now = new Date();
  let s = createWorld(seed as WorldSeed, { 'gm-main': { role: 'main' }, 'gm-ruins': { role: 'scene', locations: ['ruins'] } });
  s = joinWorld(s, { id: 'crow', ownerUserId: 'u1', name: '灰鴉', attributes: attrs({ STR: 3, VIT: 3, PER: 2 }), skills: { melee: 3, scouting: 2 }, coins: 40 }, 'road');
  s = joinWorld(s, { id: 'nightingale', ownerUserId: 'u2', name: '夜鶯', attributes: attrs({ AGI: 3, PRE: 3, INT: 2 }), skills: { stealth: 3, lockpicking: 3 }, coins: 25 }, 'road');
  state = s;
  events = [];
  changes = [];
  flash = '';
  render();
}

function send(actor: WorldActor, command: WorldCommand, label?: string): boolean {
  try {
    const r = applyWorld(state, { actor, command }, R, randomRng, now);
    state = r.state;
    events.push(...r.events);
    changes.push(...r.changes);
    const seen = historyFor(state, viewer.actor, r.events).at(-1)?.text;
    flash = r.pvp ? `✔ ${r.pvp.legality.reason}。（正式版會在這裡開一場戰鬥，${r.pvp.legality.lethal ? '可能致命' : '目標受死亡保護'}）` : `✔ ${label ?? seen ?? '已執行'}`;
    render();
    return true;
  } catch (e) {
    flash = `✘ ${e instanceof WorldError ? e.message : String(e)}`;
    render();
    return false;
  }
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
        ${people.map((c) => `<li>🧍 ${esc(c.name)}${c.online ? '' : c.afterimageUntil || viewer.characterId !== c.id ? '（殘影／離線）' : '（離線）'}${c.crimes.length ? `<span class="crime">前科 ${c.crimes.length}</span>` : ''}</li>`).join('')}
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
        ${btn('attack', '發動攻擊', legal.allowed ? (legal.lethal ? '合法・可能致命' : '合法・目標受死亡保護') : legal.reason, !me.online || !legal.allowed)}
        ${btn('steal', '偷竊', loot ? `接近→得手→察覺→證據（目標：${loot.name}）` : '對方身上沒有可偷的東西', !me.online || !sameSpot || !loot)}
        ${btn('race', '兩人同時搶沉鐘之心', '模擬同一瞬間的兩筆操作')}
        ${btn('forge', '假冒 GM 發公告', '測試未授權修改')}
      </div>`;
    return;
  }
  const rulings = Object.values(state.rulings).filter((r) => r.status === 'open');
  const g = viewer.key === 'main';
  box.innerHTML = `
    <p class="wd-me">${g ? '主 GM：可以操作整個世界，看得到所有紀錄與稽核。' : '遺跡場景 GM：只能操作沉鐘遺跡裡的地點、NPC 與物品。'}</p>
    <div class="wd-btns">
      ${btn('kill-keeper', '守墓人老楊死亡', '公開 NPC，全世界都會知道')}
      ${btn('kill-smuggler', '走私販死亡', '隱密 NPC，只有在場者知道')}
      ${btn('open-gate', '炸開鐘樓大門', '改變遺跡的地點狀態')}
      ${btn('market-safe', '市集改為安全區', '只有主 GM 能改區域')}
      ${btn('publish', '發布世界事件', '公開公告')}
      ${btn('day', '推進一天', '1 遊戲日＝現實 1 日')}
      ${btn('skip', '時間快轉 24 小時', '讓殘影到期並結算')}
    </div>
    ${rulings.length ? `<h4 class="wd-sub">待裁決</h4><div class="wd-btns">${rulings.map((r) => `${btn(`confirm:${r.id}`, `維持 ${r.id}`, r.summary)}${btn(`overturn:${r.id}`, `撤銷 ${r.id}`, '物品歸還原主')}`).join('')}</div>` : '<p class="muted">目前沒有待裁決的案件。</p>'}`;
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
}

export function initWorld() {
  $('wd-viewers').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-viewer]');
    if (!b) return;
    viewer = VIEWERS.find((x) => x.key === b.dataset.viewer)!;
    flash = '';
    render();
  });
  $('wd-actions').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-cmd]');
    if (b && !b.disabled) onCommand(b.dataset.cmd!);
  });
  $('wd-reset').addEventListener('click', reset);
  reset();
}

