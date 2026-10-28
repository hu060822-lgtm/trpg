import classes from '../../config/classes.json';
import type { WorldCharacter, WorldState } from '../world/types';
import { ApiError, type GameApi } from './api';
import {
  COLORS, auditEmbed, bagEmbed, boardEmbed, dealsEmbed, embed, logEmbed, lookEmbed, rulingsEmbed, sheetEmbed, statusEmbed, teamEmbed,
  whereEmbed, type Reply,
} from './format';

/**
 * Slash commands. Everything here only reads; actions still go through the game's own commands.
 * Replies about a player's own character are ephemeral (only they see them); GM replies too.
 */
const characterOption = { type: 3, name: 'character', description: '角色名稱（有多個角色時用）', required: false };
const countOption = { type: 4, name: 'count', description: '筆數（預設 10）', required: false, min_value: 1, max_value: 30 };

export const COMMANDS = [
  { name: 'me', description: '我的角色狀態：HP、位置、錢幣', options: [characterOption] },
  { name: 'sheet', description: '完整角色卡：屬性與技能', options: [characterOption] },
  { name: 'look', description: '看看四周：在場的人、NPC、地上的東西、出口', options: [characterOption] },
  { name: 'bag', description: '背包、錢幣與鎖定中的東西', options: [characterOption] },
  { name: 'log', description: '我看得到的最近紀錄', options: [countOption, characterOption] },
  { name: 'team', description: '我的隊伍、金庫與進行中的提案', options: [characterOption] },
  { name: 'deals', description: '我的交易、契約與委託', options: [characterOption] },
  { name: 'board', description: '委託板' },
  {
    name: 'gm', description: 'GM 工具（需要這個世界的 GM 授權）',
    options: [
      { type: 1, name: 'rulings', description: '待處理的裁決單、交易爭議與待驗收委託' },
      { type: 1, name: 'where', description: '所有角色的位置與狀態' },
      { type: 1, name: 'log', description: '完整世界紀錄', options: [countOption] },
      { type: 1, name: 'audit', description: '變更稽核（主 GM）', options: [countOption] },
    ],
  },
];

export interface CommandInput {
  userId: string;
  command: string;
  sub?: string;
  options: Record<string, string | number | undefined>;
}

const reply = (r: Omit<Reply, 'ephemeral'>): Reply => ({ ephemeral: true, ...r });
const notice = (text: string, color = COLORS.warn): Reply => reply({ embeds: [embed({ title: '提示', description: text, color })] });

export async function handleCommand(api: GameApi, worldId: string, input: CommandInput): Promise<Reply> {
  try {
    return await dispatch(api, worldId, input);
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401) return notice('機器人沒有連上遊戲伺服器的權限，請通知管理員。');
      return notice(e.message);
    }
    throw e;
  }
}

async function dispatch(api: GameApi, worldId: string, input: CommandInput): Promise<Reply> {
  const count = Number(input.options.count ?? 10);
  if (input.command === 'board') {
    const v = await api.view(worldId, input.userId);
    return reply({ embeds: [boardEmbed(v.world)] });
  }
  if (input.command === 'gm') return gm(api, worldId, input, count);

  const v = await api.view(worldId, input.userId) as { world: WorldState; history: any[] };
  const c = pick(v.world, input);
  if (typeof c === 'string') return notice(c, COLORS.info);
  switch (input.command) {
    case 'me': {
      const sheet = await api.character(c.id, input.userId);
      return reply({ embeds: [statusEmbed(v.world, c, sheet)] });
    }
    case 'sheet': {
      const sheet = await api.character(c.id, input.userId);
      const cls = classes.find((x) => x.id === sheet.classId);
      return reply({ embeds: [sheetEmbed({ ...sheet, classId: cls ? `${cls.name}（${cls.role}）` : sheet.classId })] });
    }
    case 'look': return reply({ embeds: [lookEmbed(v.world, c)] });
    case 'bag': return reply({ embeds: [bagEmbed(v.world, c)] });
    case 'log': return reply({ embeds: [logEmbed(v.history, count)] });
    case 'team': return reply({ embeds: [teamEmbed(v.world, c.id)] });
    case 'deals': return reply({ embeds: [dealsEmbed(v.world, c.id)] });
    default: return notice('不認得這個指令。');
  }
}

/** The caller's character in this world: by name if given, else their first living one. */
function pick(w: WorldState, input: CommandInput): WorldCharacter | string {
  const mine = Object.values(w.characters).filter((c) => c.ownerUserId === `discord:${input.userId}`);
  if (!mine.length) return '你在這個世界還沒有角色。請先建立角色並從據點進入世界。';
  const name = input.options.character;
  if (name) return mine.find((c) => c.name === name || c.id === name) ?? `你沒有叫「${name}」的角色。你的角色：${mine.map((c) => c.name).join('、')}`;
  return mine.find((c) => c.status === 'alive') ?? mine[0];
}

async function gm(api: GameApi, worldId: string, input: CommandInput, count: number): Promise<Reply> {
  const me = await api.me(input.userId) as { gmOf: { worldId: string; role: string }[] };
  const grant = me.gmOf.find((g) => g.worldId === worldId);
  if (!grant) return notice('你不是這個世界的 GM。');
  const v = await api.view(worldId, input.userId, true) as { world: WorldState; history: any[]; audit: any[] };
  switch (input.sub) {
    case 'rulings': return reply({ embeds: [rulingsEmbed(v.world)] });
    case 'where':
      if (grant.role !== 'main') return notice('只有主 GM 看得到所有角色的位置。', COLORS.gm);
      return reply({ embeds: [whereEmbed(v.world)] });
    case 'log': return reply({ embeds: [logEmbed(v.history, count, `世界紀錄（${grant.role === 'main' ? '全部' : '你的權限範圍'}）`)] });
    case 'audit':
      if (grant.role !== 'main') return notice('變更稽核只有主 GM 看得到。', COLORS.gm);
      return reply({ embeds: [auditEmbed(v.audit, count)] });
    default: return notice('不認得這個 GM 指令。');
  }
}
