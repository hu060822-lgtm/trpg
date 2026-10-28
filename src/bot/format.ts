import attributes from '../../config/attributes.json';
import skills from '../../config/skills.json';
import type { WorldCharacter, WorldEvent, WorldState } from '../world/types';

/** A Discord embed as plain data (discord.js accepts this shape directly). Limits are enforced here. */
export interface Embed { title: string; description?: string; fields?: { name: string; value: string; inline?: boolean }[]; color?: number }
export interface Reply { content?: string; embeds?: Embed[]; ephemeral: boolean }

export const COLORS = { info: 0x4a6fa5, gm: 0x8e5ea2, warn: 0xc0392b, ok: 0x2e8b57 };

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
/** Applies Discord's embed limits: 256 title, 4096 description, 25 fields of 256/1024. */
export function embed(e: Embed): Embed {
  return {
    ...e,
    title: cut(e.title, 256),
    description: e.description === undefined ? undefined : cut(e.description || '（無）', 4096),
    fields: e.fields?.slice(0, 25).map((f) => ({ ...f, name: cut(f.name, 256), value: cut(f.value || '（無）', 1024) })),
  };
}

const ZONES: Record<string, string> = { safe: '安全區', controlled: '管制區', wild: '荒野' };
const CONDITIONS: Record<string, string> = {
  healthy: '健康', wounded: '輕傷', severe: '重傷', dying: '瀕死', stable: '昏迷', deathPending: '待 GM 確認死亡', dead: '死亡',
};
export const attrName = (code: string) => attributes.find((a) => a.code === code)?.name ?? code;
export const skillName = (id: string) => skills.find((s) => s.id === id)?.name ?? id;
const teamOrName = (w: WorldState, id: string) =>
  (id.startsWith('team:') ? `隊伍「${w.economy.teams[id.slice(5)]?.name ?? id}」` : w.characters[id]?.name ?? id);

export function conditionText(c: Pick<WorldCharacter, 'status' | 'condition'>) {
  return c.status === 'dead' ? '已永久死亡' : CONDITIONS[c.condition] ?? c.condition;
}

/** The status line for one of the caller's characters. */
export function statusEmbed(w: WorldState, c: WorldCharacter, hp?: { hp: number; maxHp: number }): Embed {
  const l = w.locations[c.locationId];
  return embed({
    title: c.name,
    color: c.status === 'dead' ? COLORS.warn : COLORS.info,
    fields: [
      { name: '狀態', value: `${conditionText(c)}${hp ? `・HP ${hp.hp}/${hp.maxHp}` : ''}`, inline: true },
      { name: '位置', value: l ? `${l.name}（${ZONES[l.zone]}${l.outpost ? '・據點' : ''}）` : '未知', inline: true },
      { name: '錢幣', value: String(c.coins), inline: true },
      { name: '在線', value: c.online ? '在線' : c.afterimageUntil ? `殘影到 ${new Date(c.afterimageUntil).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}` : '已安全下線', inline: true },
      ...(c.crimes.length ? [{ name: '前科', value: `${c.crimes.length} 筆`, inline: true }] : []),
    ],
  });
}

export function sheetEmbed(c: { name: string; classId: string; attributes: Record<string, number>; skills: Record<string, number>; hp: number; maxHp: number; status: string; condition: string }): Embed {
  return embed({
    title: `${c.name} 的角色卡`,
    color: COLORS.info,
    description: `職業 ${c.classId}・HP ${c.hp}/${c.maxHp}・${conditionText(c as Pick<WorldCharacter, 'status' | 'condition'>)}`,
    fields: [
      { name: '屬性', value: attributes.map((a) => `${a.name} ${c.attributes[a.code] ?? 0}`).join('　') },
      { name: '技能', value: Object.entries(c.skills).filter(([, v]) => v > 0).map(([k, v]) => `${skillName(k)} ${v}`).join('　') || '（沒有）' },
    ],
  });
}

/** Where the character stands: what anyone there could see. */
export function lookEmbed(w: WorldState, c: WorldCharacter): Embed {
  const l = w.locations[c.locationId];
  if (!l) return embed({ title: '位置不明', description: '這個角色目前不在任何地點。' });
  const people = Object.values(w.characters).filter((x) => x.locationId === l.id && x.id !== c.id);
  const npcs = Object.values(w.npcs).filter((n) => n.locationId === l.id);
  const ground = Object.values(w.items).filter((i) => i.holder.type === 'location' && i.holder.id === l.id && i.status === 'present');
  const shops = Object.values(w.economy.shops).filter((s) => s.locationId === l.id && s.open);
  return embed({
    title: `${l.name}（${ZONES[l.zone]}${l.outpost ? '・據點' : ''}）`,
    description: l.description,
    color: COLORS.info,
    fields: [
      { name: '在場的人', value: people.map((p) => `${p.name}${p.online ? '' : '（殘影／離線）'}${p.status === 'dead' ? '（死亡）' : ''}`).join('、') },
      { name: 'NPC', value: npcs.map((n) => `${n.name}${n.status === 'dead' ? '（已死亡）' : ''}`).join('、') },
      { name: '地上的東西', value: ground.map((i) => i.name).join('、') },
      { name: '商店', value: shops.map((s) => `${s.name}（${s.listings.length} 件商品）`).join('、') },
      { name: '可以前往', value: l.links.map((k) => `${w.locations[k.to]?.name ?? k.to}（${k.minutes} 分）`).join('、') },
      ...(Object.keys(l.state).length ? [{ name: '現場狀況', value: Object.entries(l.state).map(([k, v]) => `${k}：${v}`).join('\n') }] : []),
    ],
  });
}

export function bagEmbed(w: WorldState, c: WorldCharacter): Embed {
  const items = Object.values(w.items).filter((i) => i.holder.type === 'character' && i.holder.id === c.id);
  const escrow = Object.values(w.economy.locks).filter((l) => l.ownerId === c.id && l.status === 'held');
  return embed({
    title: `${c.name} 的背包`,
    color: COLORS.info,
    fields: [
      { name: '錢幣', value: String(c.coins), inline: true },
      { name: '物品', value: items.map((i) => `${i.name}${i.unique ? '（唯一）' : ''}${i.boundTo ? '（綁定）' : ''}${i.lockedBy ? '（裁決中）' : ''}`).join('\n') },
      { name: '鎖定中（交易、委託、押金）', value: escrow.map((l) => `${l.id}：${[l.coins ? `${l.coins} 枚` : '', ...l.itemIds.map((i) => w.items[i]?.name ?? i)].filter(Boolean).join('＋')}（${l.ref}）`).join('\n') },
    ],
  });
}

const VIS: Record<string, string> = { public: '公開', scene: '場景', private: '私人', gm: 'GM' };
export function logEmbed(events: WorldEvent[], count: number, title = '最近的紀錄'): Embed {
  const recent = events.slice(-count).reverse();
  return embed({
    title,
    color: COLORS.info,
    description: recent.map((e) => `\`${VIS[e.visibility]}\` 第 ${e.day} 天｜${e.text}`).join('\n') || '還沒有看得到的紀錄。',
  });
}

export function teamEmbed(w: WorldState, characterId: string): Embed {
  const t = Object.values(w.economy.teams).find((x) => x.status === 'active' && x.members.includes(characterId));
  const invites = Object.values(w.economy.teams).filter((x) => x.status === 'active' && x.invites.includes(characterId));
  if (!t) return embed({ title: '隊伍', description: `你目前沒有隊伍。${invites.length ? `\n收到邀請：${invites.map((x) => `「${x.name}」`).join('、')}` : ''}` });
  const items = Object.values(w.items).filter((i) => i.holder.type === 'team' && i.holder.id === t.id);
  const open = t.proposals.filter((p) => p.status === 'open');
  return embed({
    title: `隊伍「${t.name}」`,
    color: COLORS.info,
    fields: [
      { name: '成員', value: t.members.map((m) => `${w.characters[m]?.name ?? m}${m === t.leaderId ? '（隊長）' : ''}`).join('、') },
      { name: '金庫', value: `${t.coins} 枚${items.length ? `＋${items.map((i) => i.name).join('、')}` : ''}`, inline: true },
      { name: '規則', value: `${t.policy === 'leader' ? '隊長決定提領' : '多數決提領'}・殘影${t.afterimageShare ? '會' : '不'}扣金庫`, inline: true },
      { name: `進行中的提案（${open.length}）`, value: open.map((p) => `${p.id}：${p.kind}（${p.approvals.length} 同意／${p.rejections.length} 反對）`).join('\n') },
    ],
  });
}

export function dealsEmbed(w: WorldState, characterId: string): Embed {
  const e = w.economy;
  const mine = (id?: string) => !!id && (id === characterId || (id.startsWith('team:') && !!e.teams[id.slice(5)]?.members.includes(characterId)));
  const trades = Object.values(e.trades).filter((t) => t.status === 'pending' && (mine(t.from) || mine(t.to)));
  const contracts = Object.values(e.contracts).filter((k) => ['proposed', 'active', 'disputed'].includes(k.status) && k.parties.some(mine));
  const coms = Object.values(e.commissions).filter((k) => ['published', 'accepted', 'submitted', 'disputed'].includes(k.status) && (mine(k.issuerId) || mine(k.contractorId)));
  return embed({
    title: '我的交易與契約',
    color: COLORS.info,
    fields: [
      { name: `待回覆的交易（${trades.length}）`, value: trades.map((t) => `${t.id}：${teamOrName(w, t.from)} → ${teamOrName(w, t.to)}`).join('\n') },
      { name: `契約（${contracts.length}）`, value: contracts.map((k) => `「${k.title}」${k.status}・${k.clauses.filter((c) => c.done).length}/${k.clauses.length} 條已履行・期限 ${k.deadline.slice(0, 10)}`).join('\n') },
      { name: `委託（${coms.length}）`, value: coms.map((k) => `「${k.title}」${k.status}・報酬 ${k.reward}`).join('\n') },
    ],
  });
}

export function boardEmbed(w: WorldState): Embed {
  const open = Object.values(w.economy.commissions).filter((k) => k.status === 'published');
  return embed({
    title: '委託板',
    color: COLORS.info,
    description: open.map((k) => `**${k.title}**｜報酬 ${k.reward}｜${teamOrName(w, k.issuerId)}｜期限 ${k.deadline.slice(0, 10)}`).join('\n') || '目前沒有招募中的委託。',
  });
}

// ---------- GM ----------

export function rulingsEmbed(w: WorldState): Embed {
  const open = Object.values(w.rulings).filter((r) => r.status === 'open');
  const disputes = Object.values(w.economy.disputes).filter((d) => d.status === 'open');
  const toReview = Object.values(w.economy.commissions).filter((k) => k.status === 'submitted' && k.requirement.kind === 'gm');
  return embed({
    title: '待處理的裁決',
    color: COLORS.gm,
    fields: [
      { name: `裁決單（${open.length}）`, value: open.map((r) => `${r.id}・${r.kind === 'pvp-death' ? 'PvP 死亡' : '唯一物品被偷'}：${r.summary}`).join('\n') },
      { name: `交易爭議（${disputes.length}）`, value: disputes.map((d) => `${d.id}・${d.kind === 'commission' ? '委託' : '契約'} ${d.ref}：${d.reason}`).join('\n') },
      { name: `待驗收委託（${toReview.length}）`, value: toReview.map((k) => `${k.id}「${k.title}」→ ${teamOrName(w, k.contractorId ?? '')}`).join('\n') },
    ],
  });
}

export function whereEmbed(w: WorldState): Embed {
  return embed({
    title: '所有角色的位置',
    color: COLORS.gm,
    description: Object.values(w.characters)
      .map((c) => `${c.name}｜${w.locations[c.locationId]?.name ?? '—'}｜${conditionText(c)}｜${c.online ? '在線' : c.afterimageUntil ? '殘影' : '離線'}｜${c.coins} 枚`)
      .join('\n') || '世界裡還沒有角色。',
  });
}

export function auditEmbed(changes: { seq: number; entity: string; entityId: string; basis: string; actor: { userId: string } }[], count: number): Embed {
  return embed({
    title: '變更稽核（最近）',
    color: COLORS.gm,
    description: changes.slice(-count).reverse().map((c) => `#${c.seq} ${c.entity}:${c.entityId}｜${c.basis}｜${c.actor.userId}`).join('\n') || '沒有紀錄。',
  });
}
