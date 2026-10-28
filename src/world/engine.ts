import attributesJson from '../../config/attributes.json';
import skillsJson from '../../config/skills.json';
import worldJson from '../../config/world.v03.json';
import { performCheck, type PerformedCheck } from '../rules/check';
import { assertActive } from '../rules/config';
import type { Rng } from '../rules/dice';
import type { CheckInput, RulesConfig } from '../rules/types';
import type {
  Change, GmRole, Holder, Item, Location, PendingCheck, PvpLegality, WorldActor, WorldCharacter, WorldCommand, WorldConfig,
  WorldEvent, WorldState, WorldSubmission, LedgerEntry, EconomyCommand,
} from './types';
import { performEconomy } from './economy';

export const WORLD_V03 = worldJson as WorldConfig;

export class WorldError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const ABLE = ['healthy', 'wounded', 'severe'];
const SKILL_NAMES: Record<string, string> = Object.fromEntries((skillsJson as { id: string; name: string }[]).map((k) => [k.id, k.name]));
const ATTRIBUTE_NAMES: Record<string, string> = Object.fromEntries((attributesJson as { code: string; name: string }[]).map((a) => [a.code, a.name]));
const MAX_TEXT = 500;

function text(t: unknown, what: string): string {
  const v = typeof t === 'string' ? t.trim() : '';
  if (!v) throw new WorldError('bad-text', `${what}不能是空的`);
  if (v.length > MAX_TEXT) throw new WorldError('bad-text', `${what}最多 ${MAX_TEXT} 字`);
  return v;
}

export interface Ctx {
  s: WorldState;
  actor: WorldActor;
  rules: RulesConfig;
  cfg: WorldConfig;
  rng: Rng;
  now: Date;
  events: WorldEvent[];
  changes: Change[];
  ledger: LedgerEntry[];
}

export interface WorldResult {
  state: WorldState;
  events: WorldEvent[];
  changes: Change[];
  ledger: LedgerEntry[];
  /** Set when an attack is legal: the caller opens a combat with these protections. */
  pvp?: { attackerId: string; targetId: string; locationId: string; legality: PvpLegality };
}

// ---------- seed ----------

export interface WorldSeed {
  id: string;
  name: string;
  day: number;
  locations: (Omit<Location, 'version' | 'clock'> & { clock?: number })[];
  npcs: { id: string; name: string; locationId: string; public: boolean; status?: 'alive' | 'dead' }[];
  items: { id: string; name: string; unique: boolean; tradable: boolean; holder: Holder; hidden?: { tn: number }; template?: string }[];
}

export function createWorld(seed: WorldSeed, gms: WorldState['gms']): WorldState {
  const s: WorldState = {
    id: seed.id, name: seed.name, day: seed.day, locations: {}, npcs: {}, items: {}, characters: {},
    hostilities: [], duels: [], rulings: {}, gms, seq: 0,
    economy: { teams: {}, shops: {}, trades: {}, commissions: {}, contracts: {}, locks: {}, disputes: {} },
  };
  for (const l of seed.locations) s.locations[l.id] = { clock: 0, ...l, version: 1 };
  for (const n of seed.npcs) s.npcs[n.id] = { status: 'alive', ...n, version: 1 };
  for (const i of seed.items) s.items[i.id] = { ...i, status: 'present', discoveredBy: [], version: 1 };
  return s;
}

/** Adds a player character to the world at a location (characters come from the character store). */
export function joinWorld(
  s: WorldState, c: Pick<WorldCharacter, 'id' | 'ownerUserId' | 'name' | 'attributes' | 'skills'> & Partial<WorldCharacter>, locationId: string,
): WorldState {
  if (!s.locations[locationId]) throw new WorldError('unknown-location', `unknown location ${locationId}`);
  if (s.characters[c.id]) throw new WorldError('already-joined', `${c.name} 已經在這個世界`);
  if (c.status === 'dead') throw new WorldError('character-dead', `${c.name} 已永久死亡`);
  const next = structuredClone(s);
  next.characters[c.id] = {
    status: 'alive', condition: 'healthy', online: true, lethalPvpOptIn: false, coins: 0, crimes: [], ...c,
    locationId, version: 1,
  };
  return next;
}

// ---------- helpers ----------

const clone = <T>(x: T): T => structuredClone(x);

function emit(ctx: Ctx, e: Omit<WorldEvent, 'seq' | 'at' | 'day' | 'actor' | 'audience' | 'data'> & { audience?: string[]; data?: Record<string, unknown> }) {
  ctx.s.seq += 1;
  ctx.events.push({
    seq: ctx.s.seq, at: ctx.now.toISOString(), day: ctx.s.day, actor: ctx.actor, audience: [], data: {}, ...e,
  });
}

/** Characters at a location who would see a scene event: everyone present, online or as an afterimage. */
function present(s: WorldState, locationId: string): string[] {
  return Object.values(s.characters).filter((c) => c.locationId === locationId && c.status === 'alive').map((c) => c.id);
}

function sceneEvent(ctx: Ctx, locationId: string, kind: string, text: string, data: Record<string, unknown> = {}, extra: string[] = []) {
  emit(ctx, { kind, text, visibility: 'scene', locationId, audience: [...new Set([...present(ctx.s, locationId), ...extra])], data });
}

function privateEvent(ctx: Ctx, to: string[], kind: string, text: string, data: Record<string, unknown> = {}, locationId?: string) {
  emit(ctx, { kind, text, visibility: 'private', locationId, audience: to, data });
}

function gmEvent(ctx: Ctx, kind: string, text: string, data: Record<string, unknown> = {}, locationId?: string) {
  emit(ctx, { kind, text, visibility: 'gm', locationId, data });
}

/** Records a change and bumps the entity version. `mutate` edits the live entity. */
function change<T extends { version: number }>(
  ctx: Ctx, entity: Change['entity'], entityId: string, target: T, basis: string, reversible: boolean, mutate: (t: T) => void,
) {
  const before = clone(target);
  mutate(target);
  target.version += 1;
  audit(ctx, entity, entityId, before, clone(target), basis, reversible);
}

function audit(ctx: Ctx, entity: Change['entity'], entityId: string, before: unknown, after: unknown, basis: string, reversible: boolean) {
  ctx.s.seq += 1;
  ctx.changes.push({ seq: ctx.s.seq, at: ctx.now.toISOString(), actor: ctx.actor, entity, entityId, before, after, basis, reversible });
}

function check(ctx: Ctx, input: CheckInput): PerformedCheck {
  return performCheck(input, ctx.rng, ctx.rules);
}
const passed = (r: PerformedCheck) => (r.kind === 'auto' || r.kind === 'rolled') && r.result.success;
const tierOf = (r: PerformedCheck) => (r.kind === 'auto' || r.kind === 'rolled' ? r.result.tier : 'failure');
function rollData(r: PerformedCheck) {
  if (r.kind === 'rolled') return { d20: r.result.rolls.d20, total: r.result.total, tn: r.result.input.tn, tier: r.result.tier };
  if (r.kind === 'auto') return { auto: true, tier: 'success' };
  return { [r.kind]: true, tier: 'failure' };
}

const isProtectedSpot = (l: Location) => l.zone === 'safe' || l.outpost;

/** 「PER＋偵查，難度 14（困難），情境 +1，優勢，高風險」 */
export function describeCheck(ctx: Pick<Ctx, 'rules'>, c: Pick<PendingCheck, 'attribute' | 'skill' | 'tn' | 'situational' | 'mode' | 'highRisk'>) {
  const d = ctx.rules.difficulties.find((x) => x.tn === c.tn);
  return [
    `${ATTRIBUTE_NAMES[c.attribute] ?? c.attribute}${c.skill ? `＋${SKILL_NAMES[c.skill] ?? c.skill}` : ''}`,
    `難度 ${c.tn}${d ? `（${d.name}）` : ''}`,
    c.situational ? `情境 ${c.situational > 0 ? '+' : ''}${c.situational}` : '',
    c.mode === 'advantage' ? '優勢' : c.mode === 'disadvantage' ? '劣勢' : '',
    c.highRisk ? '高風險' : '',
  ].filter(Boolean).join('，');
}

function rollText(ctx: Ctx, r: PerformedCheck) {
  if (r.kind === 'auto') return '能力足夠，自動成功';
  if (r.kind === 'impossible') return '以目前能力不可能做到';
  if (r.kind === 'skill-required') return '需要受過訓練才能嘗試';
  const x = r.result;
  const dice = x.rolls.d20.length > 1 ? `${x.rolls.d20.join('／')}→${x.d20}` : `${x.d20}`;
  return `d20=${dice}，合計 ${x.total} 對 ${x.input.tn}，${x.tierName}${x.natural ? `（自然 ${x.natural}）` : ''}`;
}

// ---------- authorization ----------

function character(ctx: Ctx, id: string): WorldCharacter {
  const c = ctx.s.characters[id];
  if (!c) throw new WorldError('unknown-character', `unknown character ${id}`);
  return c;
}

/** A player may only command their own living character. */
function own(ctx: Ctx, id: string): WorldCharacter {
  const c = character(ctx, id);
  if (ctx.actor.role !== 'player' || c.ownerUserId !== ctx.actor.userId) throw new WorldError('forbidden', '你不能操作這個角色');
  if (c.status === 'dead') throw new WorldError('character-dead', `${c.name} 已永久死亡`);
  return c;
}

/** Own, online and able to act (not dying or unconscious). */
function active(ctx: Ctx, id: string): WorldCharacter {
  const c = own(ctx, id);
  if (!c.online) throw new WorldError('offline', `${c.name} 不在線`);
  if (!ABLE.includes(c.condition)) throw new WorldError('incapacitated', `${c.name} 目前無法行動`);
  return c;
}

/** GM powers are looked up in the world's own grant table; the request's role claim alone grants nothing. */
export function gmGrant(s: WorldState, actor: WorldActor) {
  return actor.role === 'gm' ? s.gms[actor.userId] : undefined;
}

function requireGm(ctx: Ctx, roles: GmRole[], locationId?: string) {
  const g = gmGrant(ctx.s, ctx.actor);
  if (!g || !roles.includes(g.role)) throw new WorldError('forbidden', '沒有這項 GM 權限');
  if (g.role === 'scene' && (!locationId || !g.locations?.includes(locationId))) {
    throw new WorldError('forbidden', '場景 GM 只能操作被指派的地點');
  }
}

function location(ctx: Ctx, id: string): Location {
  const l = ctx.s.locations[id];
  if (!l) throw new WorldError('unknown-location', `unknown location ${id}`);
  return l;
}

function item(ctx: Ctx, id: string): Item {
  const i = ctx.s.items[id];
  if (!i) throw new WorldError('unknown-item', `unknown item ${id}`);
  return i;
}

/** Where an item physically is: the location of whoever holds it. */
export function itemLocation(s: WorldState, i: Item): string | undefined {
  if (i.holder.type === 'location') return i.holder.id;
  if (i.holder.type === 'character') return s.characters[i.holder.id]?.locationId;
  return s.npcs[i.holder.id]?.locationId;
}

function movable(i: Item) {
  if (i.status !== 'present') throw new WorldError('item-gone', `${i.name} 已經${i.status === 'destroyed' ? '被摧毀' : '被封存'}`);
  if (i.lockedBy) throw new WorldError('item-locked', `${i.name} 正在裁決中，暫時不能移動`);
}

function moveItem(ctx: Ctx, i: Item, to: Holder, basis: string, bind?: string) {
  change(ctx, 'item', i.id, i, basis, true, (t) => {
    t.holder = to;
    if (bind && !t.tradable && !t.boundTo) t.boundTo = bind;
  });
}

function tick(ctx: Ctx, l: Location, minutes: number, basis: string) {
  change(ctx, 'location', l.id, l, basis, false, (t) => { t.clock += minutes; });
}

// ---------- PvP legality ----------

/** Pure legality check for one character attacking another (plan ch.9, approved draft decision 4). */
export function pvpLegality(s: WorldState, attackerId: string, targetId: string, now: Date, cfg: WorldConfig = WORLD_V03): PvpLegality {
  const a = s.characters[attackerId];
  const t = s.characters[targetId];
  const no = (reason: string): PvpLegality => ({ allowed: false, reason, lethal: false, crime: false });
  if (!a || !t) return no('角色不存在');
  if (a.id === t.id) return no('不能攻擊自己');
  if (t.status === 'dead') return no('目標已死亡');
  if (a.locationId !== t.locationId) return no('目標不在同一個地點');
  const l = s.locations[a.locationId];
  const zone = cfg.zones[l.zone];
  if (!zone.pvp) return no(`${zone.name}禁止 PvP`);
  if (!t.online && !afterimageActive(t, now)) return no('目標已安全下線');
  if (l.zone === 'controlled') {
    const h = s.hostilities.find((x) => x.from === a.id && x.against === t.id && x.locationId === l.id);
    if (!h) return no(`${zone.name}要先公開宣告敵意`);
    const waited = l.clock - h.at;
    if (waited < cfg.hostilityLeadMinutes) return no(`宣告敵意後要等 ${cfg.hostilityLeadMinutes} 分鐘（遊戲時間），還差 ${cfg.hostilityLeadMinutes - waited} 分鐘`);
  }
  // Without an accepted duel, PvP is lethal only if the target opted in; an afterimage can never be killed.
  const lethal = t.lethalPvpOptIn && !afterimageActive(t, now);
  return {
    allowed: true, lethal, crime: zone.consequences,
    reason: `${zone.name}允許 PvP${lethal ? '' : '；沒有決鬥約定，目標最多被打到穩定昏迷，不會死亡'}${zone.consequences ? '；會留下犯罪紀錄' : ''}`,
  };
}

/**
 * A duel both sides agreed to: needs the same location and a zone that allows PvP, but no hostility lead
 * (both consented) and it may be lethal. Any death still waits for a GM to confirm it.
 */
export function duelLegality(s: WorldState, duelId: string, now: Date, cfg: WorldConfig = WORLD_V03): PvpLegality {
  const no = (reason: string): PvpLegality => ({ allowed: false, reason, lethal: false, crime: false });
  const d = s.duels.find((x) => x.id === duelId);
  if (!d) return no('找不到這份決鬥邀請');
  if (d.status !== 'pending') return no('這份邀請已經回覆過了');
  if (now >= new Date(d.expires)) return no('決鬥邀請已經過期');
  const a = s.characters[d.from];
  const t = s.characters[d.to];
  if (a.status === 'dead' || t.status === 'dead') return no('有一方已經死亡');
  if (a.locationId !== t.locationId) return no('雙方不在同一個地點');
  const zone = cfg.zones[s.locations[a.locationId].zone];
  if (!zone.pvp) return no(`${zone.name}禁止決鬥`);
  return { allowed: true, lethal: true, crime: false, duel: true, reason: `雙方同意的決鬥，可能致命；死亡須經 GM 確認` };
}

export function afterimageActive(c: WorldCharacter, now: Date) {
  return !c.online && !!c.afterimageUntil && now < new Date(c.afterimageUntil);
}

// ---------- commands ----------

function perform(ctx: Ctx, cmd: WorldCommand): WorldResult['pvp'] {
  const { s, cfg } = ctx;
  switch (cmd.type) {
    case 'move': {
      const c = active(ctx, cmd.characterId);
      const from = location(ctx, c.locationId);
      const link = from.links.find((k) => k.to === cmd.to);
      if (!link) throw new WorldError('no-route', `${from.name} 沒有路通往這裡`);
      const to = location(ctx, cmd.to);
      sceneEvent(ctx, from.id, 'left', `${c.name} 離開${from.name}，前往${to.name}`, { characterId: c.id, to: to.id });
      change(ctx, 'character', c.id, c, 'move', true, (t) => { t.locationId = to.id; });
      tick(ctx, to, link.minutes, `travel ${link.minutes}m`);
      sceneEvent(ctx, to.id, 'arrived', `${c.name} 抵達${to.name}（路程 ${link.minutes} 分鐘）`, { characterId: c.id, from: from.id });
      return;
    }
    case 'setOnline': {
      const c = own(ctx, cmd.characterId);
      const l = location(ctx, c.locationId);
      if (cmd.online) {
        if (c.online) return;
        change(ctx, 'character', c.id, c, 'log in', true, (t) => { t.online = true; delete t.afterimageUntil; });
        sceneEvent(ctx, l.id, 'online', `${c.name} 回到了${l.name}`, { characterId: c.id });
        return;
      }
      if (!c.online) return;
      if (isProtectedSpot(l)) {
        change(ctx, 'character', c.id, c, 'log off (safe)', true, (t) => { t.online = false; delete t.afterimageUntil; });
        sceneEvent(ctx, l.id, 'offline', `${c.name} 在${l.name}安全下線`, { characterId: c.id });
        return;
      }
      const until = new Date(ctx.now.getTime() + cfg.afterimage.hours * 3600_000).toISOString();
      change(ctx, 'character', c.id, c, 'log off (afterimage)', true, (t) => { t.online = false; t.afterimageUntil = until; });
      sceneEvent(ctx, l.id, 'afterimage', `${c.name} 在${l.name}下線，留下殘影`, { characterId: c.id, until });
      privateEvent(ctx, [c.id], 'afterimageWarning',
        `你在${cfg.zones[l.zone].name}下線，留下殘影到 ${until}。這段時間可能被打到昏迷或被偷，但不會被殺死；若沒有人救援，殘影會被送回最近的據點，並損失 ${Math.round(cfg.afterimage.coinLossRatio * 100)}% 攜帶錢幣。`,
        { until }, l.id);
      return;
    }
    case 'take': {
      const c = active(ctx, cmd.characterId);
      const i = item(ctx, cmd.itemId);
      movable(i);
      if (i.holder.type !== 'location' || i.holder.id !== c.locationId) throw new WorldError('not-here', `${i.name} 不在這裡`);
      if (i.hidden && !i.discoveredBy.includes(c.id)) throw new WorldError('not-here', `${i.name} 不在這裡`);
      moveItem(ctx, i, { type: 'character', id: c.id }, 'take', c.id);
      sceneEvent(ctx, c.locationId, 'took', `${c.name} 取得了${i.name}`, { characterId: c.id, itemId: i.id, unique: i.unique });
      return;
    }
    case 'drop': {
      const c = active(ctx, cmd.characterId);
      const i = item(ctx, cmd.itemId);
      movable(i);
      if (i.holder.type !== 'character' || i.holder.id !== c.id) throw new WorldError('not-yours', `你沒有${i.name}`);
      moveItem(ctx, i, { type: 'location', id: c.locationId }, 'drop');
      sceneEvent(ctx, c.locationId, 'dropped', `${c.name} 放下了${i.name}`, { characterId: c.id, itemId: i.id });
      return;
    }
    case 'give': {
      const c = active(ctx, cmd.characterId);
      const to = character(ctx, cmd.to);
      const i = item(ctx, cmd.itemId);
      movable(i);
      if (i.holder.type !== 'character' || i.holder.id !== c.id) throw new WorldError('not-yours', `你沒有${i.name}`);
      if (!i.tradable) throw new WorldError('bound', `${i.name} 已綁定，不能轉讓`);
      if (to.status === 'dead' || to.locationId !== c.locationId) throw new WorldError('bad-target', `${to.name} 不在這裡`);
      moveItem(ctx, i, { type: 'character', id: to.id }, 'give');
      sceneEvent(ctx, c.locationId, 'gave', `${c.name} 把${i.name}交給 ${to.name}`, { characterId: c.id, to: to.id, itemId: i.id });
      return;
    }
    case 'search': {
      const c = active(ctx, cmd.characterId);
      const l = location(ctx, c.locationId);
      const hidden = Object.values(s.items).filter((i) => i.hidden && i.status === 'present' && i.holder.type === 'location'
        && i.holder.id === l.id && !i.discoveredBy.includes(c.id));
      tick(ctx, l, cfg.search.minutes, 'search');
      const found: string[] = [];
      const rolls: unknown[] = [];
      for (const i of hidden) {
        const r = check(ctx, { attribute: c.attributes[cfg.search.attribute], skill: c.skills[cfg.search.skill] ?? 0, tn: i.hidden!.tn });
        rolls.push({ itemId: i.id, ...rollData(r) });
        if (passed(r)) {
          change(ctx, 'item', i.id, i, `search by ${c.id}`, false, (t) => { t.discoveredBy.push(c.id); });
          found.push(i.name);
        }
      }
      // Hidden things are reported only to the searcher; others see only that someone searched.
      sceneEvent(ctx, l.id, 'searched', `${c.name} 花了 ${cfg.search.minutes} 分鐘仔細搜索${l.name}`, { characterId: c.id });
      privateEvent(ctx, [c.id], 'searchResult', found.length ? `你找到了：${found.join('、')}` : '你沒有發現新的東西。', { found }, l.id);
      gmEvent(ctx, 'searchRolls', `${c.name} 搜索${l.name}`, { rolls }, l.id);
      return;
    }
    case 'wait': {
      const c = active(ctx, cmd.characterId);
      if (!Number.isInteger(cmd.minutes) || cmd.minutes < 1 || cmd.minutes > 24 * 60) throw new WorldError('bad-minutes', '等待時間要在 1 分鐘到 24 小時之間');
      const l = location(ctx, c.locationId);
      tick(ctx, l, cmd.minutes, `wait ${cmd.minutes}m`);
      sceneEvent(ctx, l.id, 'waited', `${c.name} 在${l.name}等待了 ${cmd.minutes} 分鐘`, { characterId: c.id, minutes: cmd.minutes });
      return;
    }
    case 'setLethalOptIn': {
      const c = own(ctx, cmd.characterId);
      change(ctx, 'character', c.id, c, 'lethal pvp opt-in', true, (t) => { t.lethalPvpOptIn = cmd.optIn; });
      privateEvent(ctx, [c.id], 'optIn', cmd.optIn ? '你已設定：離線時也接受致命 PvP。' : '你已取消：離線時接受致命 PvP。');
      return;
    }
    case 'declareHostility': {
      const c = active(ctx, cmd.characterId);
      const t = character(ctx, cmd.targetId);
      const l = location(ctx, c.locationId);
      if (t.locationId !== l.id || t.status === 'dead') throw new WorldError('bad-target', `${t.name} 不在這裡`);
      if (!cfg.zones[l.zone].pvp) throw new WorldError('pvp-forbidden', `${cfg.zones[l.zone].name}禁止 PvP`);
      s.hostilities = s.hostilities.filter((h) => !(h.from === c.id && h.against === t.id));
      const h = { id: `h${s.seq + 1}`, from: c.id, against: t.id, locationId: l.id, at: l.clock };
      s.hostilities.push(h);
      audit(ctx, 'character', c.id, null, { hostility: h }, 'declare hostility', true);
      sceneEvent(ctx, l.id, 'hostility', `${c.name} 公開向 ${t.name} 宣告敵意`, { characterId: c.id, targetId: t.id, clock: l.clock }, [t.id]);
      return;
    }
    case 'attack': {
      const c = active(ctx, cmd.characterId);
      const t = character(ctx, cmd.targetId);
      const legality = pvpLegality(s, c.id, t.id, ctx.now, cfg);
      if (!legality.allowed) throw new WorldError('pvp-illegal', legality.reason);
      const l = location(ctx, c.locationId);
      if (legality.crime) recordCrime(ctx, c, l, 'assault');
      sceneEvent(ctx, l.id, 'pvpStarted', `${c.name} 對 ${t.name} 發動攻擊`, { characterId: c.id, targetId: t.id, lethal: legality.lethal }, [t.id]);
      gmEvent(ctx, 'pvpLegality', `PvP 合法性：${legality.reason}`, { ...legality, attackerId: c.id, targetId: t.id }, l.id);
      return { attackerId: c.id, targetId: t.id, locationId: l.id, legality };
    }
    case 'inviteDuel': {
      const c = active(ctx, cmd.characterId);
      const t = character(ctx, cmd.targetId);
      if (t.id === c.id || t.status === 'dead') throw new WorldError('bad-target', '不能向這個角色提出決鬥');
      const expires = new Date(ctx.now.getTime() + cfg.duel.inviteHours * 3600_000).toISOString();
      const d = { id: `D${s.seq + 1}`, from: c.id, to: t.id, locationId: c.locationId, expires, status: 'pending' as const };
      s.duels = s.duels.filter((x) => !(x.from === c.id && x.to === t.id && x.status === 'pending'));
      s.duels.push(d);
      audit(ctx, 'character', c.id, null, { duel: d }, 'duel invitation', true);
      privateEvent(ctx, [c.id, t.id], 'duelInvited', `${c.name} 向 ${t.name} 提出決鬥邀請（${cfg.duel.inviteHours} 小時內有效）。接受就代表同意這場決鬥可能致命。`, { duelId: d.id, from: c.id, to: t.id, expires }, c.locationId);
      return;
    }
    case 'respondDuel': {
      const c = active(ctx, cmd.characterId);
      const d = s.duels.find((x) => x.id === cmd.duelId);
      if (!d || d.to !== c.id) throw new WorldError('bad-duel', '沒有給你的這份決鬥邀請');
      if (!cmd.accept) {
        if (d.status !== 'pending') throw new WorldError('bad-duel', '這份邀請已經回覆過了');
        audit(ctx, 'character', c.id, { duel: { ...d } }, { duel: { ...d, status: 'declined' } }, 'duel declined', false);
        d.status = 'declined';
        privateEvent(ctx, [d.from, d.to], 'duelDeclined', `${c.name} 拒絕了決鬥`, { duelId: d.id });
        return;
      }
      const legality = duelLegality(s, d.id, ctx.now, cfg);
      if (!legality.allowed) throw new WorldError('duel-illegal', legality.reason);
      audit(ctx, 'character', c.id, { duel: { ...d } }, { duel: { ...d, status: 'accepted' } }, 'duel accepted', false);
      d.status = 'accepted';
      const a = character(ctx, d.from);
      sceneEvent(ctx, c.locationId, 'duelStarted', `${a.name} 與 ${c.name} 的決鬥開始了`, { duelId: d.id, from: a.id, to: c.id });
      return { attackerId: a.id, targetId: c.id, locationId: c.locationId, legality };
    }
    case 'openDeathRuling': {
      if (ctx.actor.role !== 'system') throw new WorldError('forbidden', '只有系統能建立死亡裁決');
      const c = character(ctx, cmd.characterId);
      const id = `R${s.seq + 1}`;
      s.rulings[id] = {
        id, kind: 'pvp-death', status: 'open', subjects: [c.id, cmd.attackerId], characterId: c.id, combatId: cmd.combatId, cause: cmd.cause,
        summary: `${c.name} 在 PvP 戰鬥 ${cmd.combatId} 中被判定死亡`, version: 1,
      };
      audit(ctx, 'ruling', id, null, clone(s.rulings[id]), 'pvp death pending', false);
      gmEvent(ctx, 'rulingOpened', `PvP 死亡待確認（${id}）：${c.name}，原因 ${cmd.cause}。角色暫時昏迷，GM 確認後才寫入永久死亡。`, { rulingId: id, characterId: c.id, combatId: cmd.combatId });
      privateEvent(ctx, [c.id, cmd.attackerId], 'rulingOpened', `${c.name} 倒下了。這次死亡要等 GM 確認（${id}），在那之前角色處於昏迷。`, { rulingId: id }, c.locationId);
      return;
    }
    case 'steal':
      steal(ctx, cmd.characterId, cmd.targetId, cmd.itemId);
      return;

    // ---------- GM ----------
    case 'gmSetLocationState': {
      const l = location(ctx, cmd.locationId);
      requireGm(ctx, ['main', 'scene'], l.id);
      const old = l.state[cmd.key];
      change(ctx, 'location', l.id, l, 'gm', true, (t) => { t.state[cmd.key] = cmd.value; });
      const text = `${l.name}：${cmd.key}${old === undefined ? '' : `從「${old}」`}變成「${cmd.value}」`;
      if (cmd.visibility === 'public') emit(ctx, { kind: 'locationChanged', text, visibility: 'public', locationId: l.id, data: { key: cmd.key, value: cmd.value } });
      else sceneEvent(ctx, l.id, 'locationChanged', text, { key: cmd.key, value: cmd.value });
      return;
    }
    case 'gmSetZone': {
      const l = location(ctx, cmd.locationId);
      requireGm(ctx, ['main']);
      change(ctx, 'location', l.id, l, 'gm', true, (t) => { t.zone = cmd.zone; });
      emit(ctx, { kind: 'zoneChanged', text: `${l.name} 現在是${cfg.zones[cmd.zone].name}`, visibility: 'public', locationId: l.id, data: { zone: cmd.zone } });
      return;
    }
    case 'gmSetNpcStatus': {
      const n = s.npcs[cmd.npcId];
      if (!n) throw new WorldError('unknown-npc', `unknown npc ${cmd.npcId}`);
      requireGm(ctx, ['main', 'scene'], n.locationId);
      if (n.status === 'dead' && cmd.status === 'alive') throw new WorldError('npc-dead', `${n.name} 已經死亡，不能用一般操作復活`);
      if (n.status === cmd.status) return;
      change(ctx, 'npc', n.id, n, cmd.basis, false, (t) => { t.status = cmd.status; });
      const text = `${n.name} 死了`;
      if (n.public) emit(ctx, { kind: 'npcDied', text, visibility: 'public', locationId: n.locationId, data: { npcId: n.id } });
      else sceneEvent(ctx, n.locationId, 'npcDied', text, { npcId: n.id });
      gmEvent(ctx, 'npcDiedBasis', `${n.name} 死亡依據：${cmd.basis}`, { npcId: n.id, basis: cmd.basis }, n.locationId);
      return;
    }
    case 'gmItemStatus': {
      const i = item(ctx, cmd.itemId);
      requireGm(ctx, ['main', 'scene'], itemLocation(s, i));
      if (i.status === 'destroyed') throw new WorldError('item-gone', `${i.name} 已經被摧毀`);
      if (i.lockedBy) throw new WorldError('item-locked', `${i.name} 正在裁決中`);
      change(ctx, 'item', i.id, i, cmd.basis, cmd.status !== 'destroyed', (t) => { t.status = cmd.status; });
      const word = { present: '重新出現', sealed: '被封存', destroyed: '被摧毀' }[cmd.status];
      emit(ctx, { kind: 'itemStatus', text: `${i.name}${word}`, visibility: i.unique ? 'public' : 'gm', locationId: itemLocation(s, i), data: { itemId: i.id, status: cmd.status } });
      return;
    }
    case 'say': {
      // Out-of-character table talk is allowed even while down; speaking or acting in character needs to be able to act.
      const c = cmd.mode === 'ooc' ? own(ctx, cmd.characterId) : active(ctx, cmd.characterId);
      const body = text(cmd.text, '內容');
      const line = cmd.mode === 'act' ? `＊${c.name} ${body}` : cmd.mode === 'ooc' ? `（${c.name}，場外）${body}` : `${c.name}：「${body}」`;
      sceneEvent(ctx, c.locationId, 'said', line, { characterId: c.id, mode: cmd.mode, text: body });
      return;
    }
    case 'whisper': {
      const c = active(ctx, cmd.characterId);
      const to = character(ctx, cmd.to);
      if (to.id === c.id || to.status === 'dead' || to.locationId !== c.locationId) throw new WorldError('not-here', `${to.name} 不在這裡`);
      const body = text(cmd.text, '悄悄話');
      privateEvent(ctx, [c.id, to.id], 'whispered', `${c.name} 對 ${to.name} 悄聲說：「${body}」`, { from: c.id, to: to.id, text: body }, c.locationId);
      sceneEvent(ctx, c.locationId, 'whisperSeen', `${c.name} 和 ${to.name} 低聲交談`, { from: c.id, to: to.id });
      return;
    }
    case 'gmNarrate': {
      const l = location(ctx, cmd.locationId);
      requireGm(ctx, ['main', 'scene'], l.id);
      const body = text(cmd.text, '敘述');
      if (cmd.to?.length) {
        const to = cmd.to.map((id) => character(ctx, id));
        if (to.some((c) => c.locationId !== l.id)) throw new WorldError('not-here', '只能私下描述給在這個地點的角色');
        privateEvent(ctx, to.map((c) => c.id), 'narration', body, { gm: true }, l.id);
      } else {
        sceneEvent(ctx, l.id, 'narration', body, { gm: true });
      }
      return;
    }
    case 'gmRequestCheck': {
      const c = character(ctx, cmd.characterId);
      requireGm(ctx, ['main', 'scene'], c.locationId);
      if (c.status === 'dead') throw new WorldError('character-dead', `${c.name} 已永久死亡`);
      if (!(cmd.attribute in c.attributes)) throw new WorldError('bad-check', `沒有屬性 ${cmd.attribute}`);
      if (cmd.skill !== null && !SKILL_NAMES[cmd.skill]) throw new WorldError('bad-check', `沒有技能 ${cmd.skill}`);
      if (!ctx.rules.difficulties.some((d) => d.tn === cmd.tn)) throw new WorldError('bad-check', `難度要是 ${ctx.rules.difficulties.map((d) => d.tn).join('／')} 其中之一`);
      const situational = cmd.situational ?? 0;
      if (!Number.isInteger(situational) || Math.abs(situational) > ctx.rules.check.modifierCap) {
        throw new WorldError('bad-check', `情境修正要在 ±${ctx.rules.check.modifierCap} 以內`);
      }
      const check: PendingCheck = {
        id: `chk-${s.seq + 1}`, label: text(cmd.label, '檢定名稱'), attribute: cmd.attribute, skill: cmd.skill, tn: cmd.tn, situational,
        mode: cmd.mode ?? 'normal', highRisk: !!cmd.highRisk, secret: !!cmd.secret, requestedBy: ctx.actor.userId, at: ctx.now.toISOString(),
      };
      change(ctx, 'character', c.id, c, `check requested: ${check.label}`, true, (t) => { t.pendingChecks = [...(t.pendingChecks ?? []), check]; });
      const desc = describeCheck(ctx, check);
      privateEvent(ctx, [c.id], 'checkRequested', `GM 要求你進行檢定：${check.label}（${desc}）`, { checkId: check.id }, c.locationId);
      if (!check.secret) sceneEvent(ctx, c.locationId, 'checkCalled', `GM 要求 ${c.name} 進行「${check.label}」檢定`, { characterId: c.id, checkId: check.id });
      return;
    }
    case 'rollCheck': {
      const c = character(ctx, cmd.characterId);
      // The player rolls their own check; a GM of the scene may roll for them (e.g. when they are away).
      if (ctx.actor.role === 'player') {
        own(ctx, c.id);
        if (!ABLE.includes(c.condition)) throw new WorldError('incapacitated', `${c.name} 目前無法行動`);
      } else {
        requireGm(ctx, ['main', 'scene'], c.locationId);
      }
      const pending = (c.pendingChecks ?? []).find((x) => x.id === cmd.checkId);
      if (!pending) throw new WorldError('unknown-check', '沒有這個待擲的檢定');
      const r = check(ctx, {
        attribute: c.attributes[pending.attribute], skill: pending.skill ? c.skills[pending.skill] ?? 0 : 0,
        situational: pending.situational, tn: pending.tn, mode: pending.mode, highRisk: pending.highRisk,
      });
      change(ctx, 'character', c.id, c, `check rolled: ${pending.label}`, false, (t) => {
        t.pendingChecks = (t.pendingChecks ?? []).filter((x) => x.id !== pending.id);
      });
      const outcome = rollText(ctx, r);
      const data = { characterId: c.id, checkId: pending.id, label: pending.label, ...rollData(r), success: passed(r) };
      const who = ctx.actor.role === 'player' ? c.name : `GM 代 ${c.name}`;
      if (pending.secret) {
        privateEvent(ctx, [c.id], 'checkRolled', `${who}擲了「${pending.label}」，結果由 GM 掌握`, { characterId: c.id, checkId: pending.id, secret: true }, c.locationId);
        gmEvent(ctx, 'checkResult', `${c.name}「${pending.label}」（暗骰）：${outcome}`, data, c.locationId);
      } else {
        sceneEvent(ctx, c.locationId, 'checkResult', `${who}擲「${pending.label}」：${outcome}`, data);
      }
      return;
    }
    case 'gmCancelCheck': {
      const c = character(ctx, cmd.characterId);
      requireGm(ctx, ['main', 'scene'], c.locationId);
      const pending = (c.pendingChecks ?? []).find((x) => x.id === cmd.checkId);
      if (!pending) throw new WorldError('unknown-check', '沒有這個待擲的檢定');
      change(ctx, 'character', c.id, c, `check cancelled: ${pending.label}`, true, (t) => {
        t.pendingChecks = (t.pendingChecks ?? []).filter((x) => x.id !== pending.id);
      });
      privateEvent(ctx, [c.id], 'checkCancelled', `GM 取消了「${pending.label}」檢定`, { checkId: pending.id }, c.locationId);
      return;
    }
    case 'gmPublish': {
      requireGm(ctx, ['main']);
      emit(ctx, { kind: 'worldEvent', text: `【${cmd.title}】${cmd.body}`, visibility: 'public', data: { title: cmd.title } });
      return;
    }
    case 'gmRuling': {
      requireGm(ctx, ['main', 'arbiter']);
      const r = s.rulings[cmd.rulingId];
      if (!r) throw new WorldError('unknown-ruling', `unknown ruling ${cmd.rulingId}`);
      if (r.status !== 'open') throw new WorldError('ruling-closed', '這張裁決單已經結案');
      const i = r.itemId ? item(ctx, r.itemId) : undefined;
      if (i) {
        change(ctx, 'item', i.id, i, `ruling ${r.id} ${cmd.decision}`, cmd.decision === 'confirm', (t) => {
          delete t.lockedBy;
          if (cmd.decision === 'overturn' && r.revertTo) t.holder = r.revertTo;
        });
      }
      change(ctx, 'ruling', r.id, r, cmd.decision, false, (t) => { t.status = cmd.decision === 'confirm' ? 'confirmed' : 'overturned'; t.decidedBy = ctx.actor.userId; });
      const outcome = r.kind === 'pvp-death'
        ? (cmd.decision === 'confirm' ? '確認死亡，寫入永久死亡紀錄' : '不成立，角色以 1 HP 昏迷倖存')
        : (cmd.decision === 'confirm' ? '維持原結果' : '撤銷，物品歸還原持有者');
      const text = `裁決單 ${r.id}（${r.summary}）${outcome}`;
      privateEvent(ctx, r.subjects, 'ruling', text, { rulingId: r.id, decision: cmd.decision });
      gmEvent(ctx, 'ruling', text, { rulingId: r.id, decision: cmd.decision });
      return;
    }
    case 'advanceDay': {
      if (ctx.actor.role !== 'system') requireGm(ctx, ['main']);
      audit(ctx, 'world', s.id, { day: s.day }, { day: s.day + 1 }, 'day', false);
      s.day += 1;
      emit(ctx, { kind: 'dayStarted', text: `第 ${s.day} 天開始了`, visibility: 'public', data: { day: s.day } });
      return;
    }
    case 'expireAfterimages': {
      if (ctx.actor.role !== 'system') requireGm(ctx, ['main']);
      for (const c of Object.values(s.characters)) {
        if (c.online || !c.afterimageUntil || ctx.now < new Date(c.afterimageUntil)) continue;
        const from = location(ctx, c.locationId);
        const outpost = nearestOutpost(s, from.id);
        const lost = Math.floor(c.coins * cfg.afterimage.coinLossRatio);
        change(ctx, 'character', c.id, c, 'afterimage expired', false, (t) => {
          delete t.afterimageUntil;
          t.locationId = outpost;
          t.coins -= lost;
          if (t.condition === 'dying') t.condition = 'stable';
        });
        if (lost) {
          s.seq += 1;
          ctx.ledger.push({
            seq: s.seq, at: ctx.now.toISOString(), tx: `afterimage-${c.id}-${s.day}`, from: { type: 'character', id: c.id }, to: { type: 'sink', id: 'afterimage' },
            coins: lost, reason: 'afterimage expired',
          });
        }
        // A team that chose to share the risk loses the same ratio of this member's share of the treasury.
        const team = Object.values(s.economy.teams).find((t) => t.status === 'active' && t.afterimageShare && t.members.includes(c.id));
        if (team) {
          const living = team.members.filter((m) => s.characters[m]?.status === 'alive').length || 1;
          const teamLost = Math.floor((team.coins / living) * cfg.afterimage.coinLossRatio);
          if (teamLost) {
            change(ctx, 'team', team.id, team, `afterimage of ${c.id}`, false, (t) => { t.coins -= teamLost; });
            s.seq += 1;
            ctx.ledger.push({
              seq: s.seq, at: ctx.now.toISOString(), tx: `afterimage-${c.id}-${s.day}`, from: { type: 'team', id: team.id }, to: { type: 'sink', id: 'afterimage' },
              coins: teamLost, reason: `afterimage expired (${c.id}'s share)`,
            });
            privateEvent(ctx, team.members, 'teamAfterimageLoss', `${c.name} 的殘影到期，依隊伍規則，「${team.name}」金庫損失 ${teamLost} 枚`, { teamId: team.id, lost: teamLost });
          }
        }
        sceneEvent(ctx, from.id, 'afterimageGone', `${c.name} 的殘影消失了`, { characterId: c.id });
        privateEvent(ctx, [c.id], 'afterimageReturned', `你的殘影無人接應，被送回${s.locations[outpost].name}，損失 ${lost} 枚錢幣。`, { lost, to: outpost });
      }
      return;
    }
    default:
      performEconomy(ctx, cmd as EconomyCommand, H);
      return;
  }
}

/** Breadth-first search to the closest safe spot (by travel minutes). */
export function nearestOutpost(s: WorldState, from: string): string {
  const dist: Record<string, number> = { [from]: 0 };
  const queue = [from];
  let best: string | undefined;
  while (queue.length) {
    queue.sort((a, b) => dist[a] - dist[b]);
    const id = queue.shift()!;
    const l = s.locations[id];
    if (isProtectedSpot(l)) { best = id; break; }
    for (const k of l.links) {
      const d = dist[id] + k.minutes;
      if (dist[k.to] === undefined || d < dist[k.to]) { dist[k.to] = d; queue.push(k.to); }
    }
  }
  return best ?? from;
}

function recordCrime(ctx: Ctx, c: WorldCharacter, l: Location, kind: string) {
  change(ctx, 'character', c.id, c, `crime ${kind}`, true, (t) => { t.crimes.push({ locationId: l.id, kind, day: ctx.s.day }); });
}

/**
 * Theft in four checks (approved draft): approach, grab, notice, evidence.
 * Only tradable, unbound items can be stolen; a stolen unique item opens a ruling and stays locked until a GM decides.
 */
function steal(ctx: Ctx, thiefId: string, targetId: string, itemId: string) {
  const { s, cfg } = ctx;
  const c = active(ctx, thiefId);
  const t = character(ctx, targetId);
  const i = item(ctx, itemId);
  const l = location(ctx, c.locationId);
  const zone = cfg.zones[l.zone];
  const T = cfg.theft;
  if (t.id === c.id) throw new WorldError('bad-target', '不能偷自己');
  if (t.status === 'dead' || t.locationId !== l.id) throw new WorldError('bad-target', `${t.name} 不在這裡`);
  if (!zone.theft) throw new WorldError('theft-forbidden', `${zone.name}禁止偷竊`);
  if (!t.online && !afterimageActive(t, ctx.now)) throw new WorldError('bad-target', `${t.name} 已安全下線`);
  if (i.holder.type !== 'character' || i.holder.id !== t.id) throw new WorldError('not-theirs', `${t.name} 身上沒有${i.name}`);
  if (!i.tradable || i.boundTo) throw new WorldError('bound', `${i.name} 已綁定，不能被偷`);
  movable(i);

  const attr = (x: WorldCharacter, k: { attribute: keyof WorldCharacter['attributes']; skill: string }) =>
    ({ attribute: x.attributes[k.attribute], skill: x.skills[k.skill] ?? 0 });
  const awareness = cfg.awareness.base + t.attributes[cfg.awareness.attribute] + (t.skills[cfg.awareness.skill] ?? 0);
  // Asleep or away (afterimage): the victim cannot notice anything themselves.
  const victimAware = t.online && ABLE.includes(t.condition);
  const approach = check(ctx, { ...attr(c, T.approach), tn: victimAware ? awareness : cfg.awareness.base });
  const steps: Record<string, unknown> = { approach: rollData(approach) };
  tick(ctx, l, T.minutes, 'theft');

  let taken = false;
  let alerted = false;
  if (!passed(approach) && tierOf(approach) !== 'partial') {
    // Botched approach: nothing taken. Someone notices only if the victim is aware or guards patrol here.
    alerted = victimAware || zone.consequences;
  } else {
    const grab = check(ctx, { ...attr(c, T.grab), tn: T.grab.tn });
    steps.grab = rollData(grab);
    taken = passed(grab) || tierOf(grab) === 'partial';
    // A sloppy step (partial) makes the theft easier to notice.
    const sloppy = tierOf(approach) === 'partial' || tierOf(grab) === 'partial';
    const concealment = T.concealment.base + c.attributes[T.concealment.attribute] + (c.skills[T.concealment.skill] ?? 0);
    const watcher = victimAware ? attr(t, T.notice) : zone.consequences ? { attribute: T.guards.attribute, skill: T.guards.skill } : null;
    if (watcher) {
      const notice = check(ctx, { ...watcher, tn: concealment, mode: sloppy ? 'advantage' : 'normal' });
      steps.notice = { by: victimAware ? 'victim' : 'guards', ...rollData(notice) };
      alerted = passed(notice);
    }
  }

  let evidence = false;
  if (!alerted) {
    const ev = check(ctx, { ...attr(c, T.evidence), tn: T.evidence.tn });
    steps.evidence = rollData(ev);
    evidence = !passed(ev);
  }
  if (taken) moveItem(ctx, i, { type: 'character', id: c.id }, `theft from ${t.id}`);
  const identified = alerted || evidence;
  if (zone.consequences && identified) recordCrime(ctx, c, l, 'theft');

  privateEvent(ctx, [c.id], 'theftResult',
    `${taken ? `你偷到了${i.name}` : `你沒能偷到${i.name}`}${alerted ? '，而且被發現了' : evidence ? '，但留下了痕跡' : '，沒有人察覺'}。`,
    { taken, alerted, evidence, steps }, l.id);
  if (alerted) {
    privateEvent(ctx, [t.id], 'theftNoticed', `${c.name} ${taken ? `偷走了你的${i.name}` : `想偷你的${i.name}`}，被${victimAware ? '你' : '守衛'}發現了。`, { thiefId: c.id, taken }, l.id);
    if (zone.consequences) sceneEvent(ctx, l.id, 'crime', `${c.name} 在${l.name}行竊被發現`, { characterId: c.id, targetId: t.id });
  } else if (taken) {
    privateEvent(ctx, [t.id], 'theftDiscovered', `你的${i.name}不見了${evidence ? `，現場留下的痕跡指向 ${c.name}` : '，沒有留下任何線索'}。`, { thiefId: evidence ? c.id : null }, l.id);
  }
  gmEvent(ctx, 'theft', `${c.name} 對 ${t.name} 行竊（${i.name}）`, { thiefId: c.id, targetId: t.id, itemId: i.id, taken, alerted, evidence, steps }, l.id);

  if (taken && i.unique && cfg.rulings.uniqueItemTheft) {
    const id = `R${s.seq + 1}`;
    s.rulings[id] = {
      id, kind: 'unique-item-theft', status: 'open', subjects: [c.id, t.id], itemId: i.id,
      revertTo: { type: 'character', id: t.id }, summary: `${c.name} 從 ${t.name} 偷走${i.name}`, version: 1,
    };
    audit(ctx, 'ruling', id, null, clone(s.rulings[id]), 'unique item theft', false);
    change(ctx, 'item', i.id, i, `ruling ${id} opened`, true, (x) => { x.lockedBy = id; });
    gmEvent(ctx, 'rulingOpened', `唯一物品被偷，自動建立裁決單 ${id}：${i.name} 暫時鎖定，結果在 GM 確認前為暫定`, { rulingId: id, itemId: i.id });
    privateEvent(ctx, [c.id, t.id], 'rulingOpened', `${i.name}的去向已送交 GM 裁決（${id}），裁決前物品鎖定。`, { rulingId: id }, l.id);
  }
}

/** The helpers the economy module needs, passed in so the two files do not import each other. */
export const H = { change, audit, privateEvent, gmEvent, emit, own, active, character, item, movable, requireGm, clone, WorldError };
export type Helpers = typeof H;

// ---------- entry point ----------

/** Applies one command. Pure: returns a new state and never mutates the input. */
export function applyWorld(
  state: WorldState, sub: WorldSubmission, rules: RulesConfig, rng: Rng, now: Date, cfg: WorldConfig = WORLD_V03,
): WorldResult {
  assertActive(rules);
  for (const [id, v] of Object.entries(sub.expected ?? {})) {
    const e = state.items[id] ?? state.locations[id] ?? state.npcs[id] ?? state.characters[id];
    if (!e) throw new WorldError('unknown-entity', `unknown entity ${id}`);
    if (e.version !== v) throw new WorldError('stale', '世界狀態已經改變，請重新讀取後再行動');
  }
  const s = structuredClone(state);
  const ctx: Ctx = { s, actor: sub.actor, rules, cfg, rng, now, events: [], changes: [], ledger: [] };
  const pvp = perform(ctx, sub.command);
  return { state: s, events: ctx.events, changes: ctx.changes, ledger: ctx.ledger, pvp };
}

