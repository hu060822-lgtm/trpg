import { randomInt, randomUUID } from 'node:crypto';
import { cleanLaunch, throwDie, type Launch } from '../dice/physics';
import { heightOf, blocksMove } from '../encounter/geometry';
import { bonusFor, DEFAULT_RULES } from '../encounter/rules';
import type { DieFace, GestureInput } from '../encounter/types';
import { challengeFor, scoreGesture, type GestureKind } from '../encounter/weapons';
import { evaluate, type Evaluation } from '../pack/expr';
import { checkFormula, rollOnSheet } from '../pack/pack';
import type { Database } from '../persistence/db';
import type { Rng } from '../rules/dice';
import type { EncounterStore } from './encounters';
import { damageOf, FIELD_ACTIONS, fieldActions, gapTo, isTrap, type FieldAction, type FieldResult, type FieldRoll, type FieldStart } from './fieldRules';
export type { FieldResult, FieldStart } from './fieldRules';
import { mergeProps } from './maps';
import { TableError, type TableStore } from './store';
import type { MapObject, MapObjectKind, ObjectProps } from './types';

/**
 * Doing things to the map: climbing, breaking, picking locks, disarming traps, jumping and swimming across, pulling
 * levers. Two calls, the same order as an attack: `start` throws the dice (a real throw, from the player's flick) and
 * hands back a gesture to do; `finish` scores the gesture, adds its little bonus and settles it against the DC, then
 * changes the map — a wall turns to rubble, a door unlocks, the climber stands on top.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS field_actions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  action TEXT NOT NULL,
  total INTEGER NOT NULL,
  nat INTEGER NOT NULL,
  dc INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS field_actions_room ON field_actions(room_id);
`;

/** A started action is good for this long; after that the gesture counts as not done. */
const PENDING_MS = 3 * 60 * 1000;

export interface FieldStartInput { objectId?: unknown; tokenId?: unknown; action?: unknown; launch?: unknown }
interface ObjectRow { id: string; map_id: string; kind: MapObjectKind; name: string; x: number; y: number; w: number; h: number; hidden: boolean; open: boolean; height: number | null; props: string | null }
interface TokenRow { id: string; map_id: string; name: string; x: number; y: number; size: number; elevation: number; character_id: string | null; owner_user_id: string }
interface PendingRow { id: string; room_id: string; user_id: string; token_id: string; object_id: string; action: FieldAction; total: number; nat: number; dc: number; seed: number; done: boolean; created_at: string }

const props = (r: ObjectRow): ObjectProps => { try { return JSON.parse(r.props || '{}'); } catch { return {}; } };
const objectOf = (r: ObjectRow): Pick<MapObject, 'kind' | 'open' | 'props' | 'x' | 'y' | 'w' | 'h' | 'height' | 'name'> => ({ kind: r.kind, open: r.open, props: props(r), x: r.x, y: r.y, w: r.w, h: r.h, height: r.height, name: r.name });

export class FieldStore {
  private constructor(private db: Database, private table: TableStore, private encounters: EncounterStore, private rng: Rng) {}

  static async open(db: Database, table: TableStore, encounters: EncounterStore, rng: Rng) {
    await db.migrate(SCHEMA);
    return new FieldStore(db, table, encounters, rng);
  }

  async start(roomId: string, userId: string, input: FieldStartInput, now = new Date()): Promise<FieldStart> {
    const me = await this.table.requireRole(roomId, userId, 'player');
    const gm = me.role === 'gm';
    const { object, token } = await this.load(roomId, String(input.objectId ?? ''), String(input.tokenId ?? ''), gm);
    if (!gm && token.owner_user_id !== userId) throw new TableError(403, 'forbidden', '只能用自己的代幣行動');
    const action = String(input.action ?? '') as FieldAction;
    const offer = fieldActions(objectOf(object)).find((a) => a.action === action);
    if (!offer) throw new TableError(400, 'bad-request', `這個物件現在不能「${FIELD_ACTIONS[action]?.label ?? action}」`);
    if (gapTo(token, object) > 1) throw new TableError(400, 'too-far', '要先走到物件旁邊');
    const def = FIELD_ACTIONS[action];
    const target = object.name || KIND_NAME[object.kind] || '物件';
    // In a fight this is the creature's action for the turn; refused off its turn.
    await this.encounters.spendAction(roomId, userId, token.id, `${def.label}「${target}」`, now);

    const id = randomUUID(), seed = randomInt(1, 2 ** 31 - 1);
    if (offer.dc === 0) {
      const result = await this.settle(roomId, userId, { object, token, action, total: 0, natural: 0, dc: 0, quality: null, bonus: 0 }, now);
      return { id, action, label: def.label, target, dc: 0, roll: null, gesture: null, seed, result };
    }

    // The check, thrown for real in the tray.
    const { pack, characters } = await this.table.combatContext(roomId);
    const sheet = token.character_id ? characters.find((c) => c.id === token.character_id)?.sheet : undefined;
    let formula = '1d20';
    if (sheet) {
      try { formula = checkFormula(pack, def.skill && pack.skills.some((s) => s.id === def.skill) ? { skill: def.skill } : { attribute: def.attribute }); } catch { formula = '1d20'; }
    }
    const launch: Launch | undefined = cleanLaunch(input.launch);
    const dice: DieFace[] = [];
    let lane = 0;
    const toss: Rng = (sides) => {
      if (![4, 6, 8, 10, 12, 20].includes(sides)) return this.rng(sides);
      const t = { seed: randomInt(1, 2 ** 31 - 1), lane: lane++, ...(launch ? { launch } : {}) };
      const value = throwDie(sides, t);
      dice.push({ sides, value, kept: true, toss: t });
      return value;
    };
    let ev: Evaluation;
    try { ev = sheet ? rollOnSheet(pack, sheet, formula, toss) : evaluate(formula, () => undefined, toss); } catch { ev = evaluate('1d20', () => undefined, toss); }
    const natural = dice.find((d) => d.sides === 20)?.value ?? 0;
    const roll: FieldRoll = { total: ev.total, text: ev.text, natural, dice };
    await this.table.rollFor(roomId, userId, { label: `${token.name}：${def.label}「${target}」`, text: ev.text, total: ev.total, natural: natural === 20 ? 'critical' : natural === 1 ? 'fumble' : null, ...(token.character_id ? { characterId: token.character_id } : {}) }, now);

    const settledByDice = natural === 20 || natural === 1 || !def.gesture;
    if (settledByDice) {
      const result = await this.settle(roomId, userId, { object, token, action, total: ev.total, natural, dc: offer.dc, quality: null, bonus: 0 }, now);
      return { id, action, label: def.label, target, dc: offer.dc, roll, gesture: null, seed, result };
    }
    await this.db.run(`INSERT INTO field_actions (id, room_id, user_id, token_id, object_id, action, total, nat, dc, seed, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, roomId, userId, token.id, object.id, action, ev.total, natural, offer.dc, seed, now.toISOString()]);
    return { id, action, label: def.label, target, dc: offer.dc, roll, gesture: def.gesture, seed, result: null };
  }

  /** Scores the gesture (none, or one out of time, counts as 0) and settles the action. */
  async finish(roomId: string, userId: string, id: string, input: unknown, now = new Date()): Promise<FieldResult> {
    const me = await this.table.requireRole(roomId, userId, 'player');
    const p = await this.db.tx(async () => {
      const row = await this.db.one<PendingRow>('SELECT * FROM field_actions WHERE id = $1 AND room_id = $2 FOR UPDATE', [id, roomId]);
      if (!row) throw new TableError(404, 'not-found', '找不到這個行動');
      if (row.user_id !== userId && me.role !== 'gm') throw new TableError(403, 'forbidden', '這不是你的行動');
      if (row.done) throw new TableError(409, 'done', '這個行動已經結算了');
      await this.db.run('UPDATE field_actions SET done = true WHERE id = $1', [id]);
      return row;
    });
    const def = FIELD_ACTIONS[p.action];
    const late = now.getTime() - Date.parse(p.created_at) > PENDING_MS;
    const ch = def.gesture ? challengeFor(def.gesture, p.seed) : null;
    const quality = ch && input && !late ? scoreGesture(ch, input as GestureInput) : 0;
    const { pack } = await this.table.combatContext(roomId);
    const bonus = bonusFor(pack.combat?.rules ?? DEFAULT_RULES, quality);
    const { object, token } = await this.load(roomId, p.object_id, p.token_id, true);
    return this.settle(roomId, userId, { object, token, action: p.action, total: p.total, natural: p.nat, dc: p.dc, quality, bonus }, now);
  }

  private async load(roomId: string, objectId: string, tokenId: string, gm: boolean) {
    const object = await this.db.one<ObjectRow>(`SELECT o.* FROM map_objects o JOIN room_maps m ON m.id = o.map_id WHERE o.id = $1 AND m.room_id = $2`, [objectId, roomId]);
    if (!object || (object.hidden && !gm)) throw new TableError(404, 'not-found', '找不到這個物件');
    const token = await this.db.one<TokenRow>('SELECT * FROM map_tokens WHERE id = $1 AND map_id = $2', [tokenId, object.map_id]);
    if (!token) throw new TableError(404, 'not-found', '這張地圖上沒有這個代幣');
    return { object, token };
  }

  /** Decides success and changes the map to match, then writes it to the log. */
  private async settle(roomId: string, userId: string, a: { object: ObjectRow; token: TokenRow; action: FieldAction; total: number; natural: number; dc: number; quality: number | null; bonus: number }, now: Date): Promise<FieldResult> {
    const { object: o, token: t, action } = a;
    const def = FIELD_ACTIONS[action];
    const final = a.total + a.bonus;
    const success = a.dc === 0 || a.natural === 20 || (a.natural !== 1 && final >= a.dc);
    const name = o.name || KIND_NAME[o.kind] || '物件';
    const lines: string[] = [];
    const roll = a.dc === 0 ? '' : a.bonus ? `（${a.total} + 操作 ${a.bonus} = ${final}，DC ${a.dc}）` : `（${final}，DC ${a.dc}）`;
    const harm = (formula: string) => evaluate(formula, () => undefined, this.rng);
    await this.db.tx(async () => {
      const p = props(o);
      const setProps = (change: Partial<ObjectProps>) => this.db.run('UPDATE map_objects SET props = $2 WHERE id = $1', [o.id, JSON.stringify(mergeProps(p, change))]);
      const moveToken = (x: number, y: number, elevation = t.elevation) => this.db.run('UPDATE map_tokens SET x = $2, y = $3, elevation = $4 WHERE id = $1', [t.id, x, y, elevation]);
      if (action === 'pull') {
        await this.db.run('UPDATE map_objects SET open = NOT open WHERE id = $1', [o.id]);
        // A lever works whatever shares its name: doors, gates, cages, bridges.
        const linked = o.name ? await this.db.run(`UPDATE map_objects SET open = NOT open WHERE map_id = $1 AND name = $2 AND id <> $3 AND kind IN ('door', 'gate', 'cage', 'bridge', 'window')`, [o.map_id, o.name, o.id]) : 0;
        lines.push(`${t.name} 拉動了「${name}」${linked ? `，${linked} 個機關跟著動了` : ''}`);
        return;
      }
      if (!success) {
        lines.push(`${t.name} ${def.label}「${name}」失敗${roll}`);
        const badly = a.natural === 1 || final <= a.dc - 5;
        if (action === 'disarm' && badly) {
          const d = harm(damageOf({ kind: o.kind, props: p }));
          await setProps({ armed: false });
          lines.push(`陷阱被觸發了！${t.name} 受到 ${d.total} 點傷害（${d.text}），請 GM 扣除生命`);
        } else if (action === 'jump' && (o.kind === 'pit' || o.kind === 'lava')) {
          const d = harm(damageOf({ kind: o.kind, props: p }));
          const at = nearestCell(t, o);
          await moveToken(at.x, at.y, o.kind === 'pit' ? -10 : t.elevation);
          lines.push(`${t.name} 掉了進去，受到 ${d.total} 點傷害（${d.text}），請 GM 扣除生命`);
        } else if (action === 'climb' && badly && heightOf(objectOf(o)) >= 10) {
          const d = harm(damageOf({ kind: o.kind, props: p }));
          lines.push(`${t.name} 摔了下來，受到 ${d.total} 點傷害（${d.text}），請 GM 扣除生命`);
        }
        return;
      }
      lines.push(`${t.name} ${def.verb}「${name}」${roll}`);
      if (action === 'climb') {
        const at = nearestCell(t, o);
        const height = o.kind === 'ladder' || o.kind === 'rope' ? Math.max(10, heightOf(objectOf(o))) : o.kind === 'pit' ? 0 : heightOf(objectOf(o));
        await moveToken(at.x, at.y, height);
        lines.push(`${t.name} 現在在 ${height} 呎高`);
      } else if (action === 'break') {
        if (o.kind === 'cracked_wall') await this.db.run(`UPDATE map_objects SET kind = 'rubble', props = '{}' WHERE id = $1`, [o.id]);
        else if (['crate', 'barrel', 'barricade', 'fence', 'web'].includes(o.kind)) await this.db.run('DELETE FROM map_objects WHERE id = $1', [o.id]);
        else { await this.db.run('UPDATE map_objects SET open = true WHERE id = $1', [o.id]); await setProps({ locked: false }); }
      } else if (action === 'pick') {
        await setProps({ locked: false });
      } else if (action === 'disarm') {
        await setProps({ armed: false });
      } else if (action === 'jump' || action === 'swim') {
        const blockers = (await this.db.query<ObjectRow>('SELECT * FROM map_objects WHERE map_id = $1', [o.map_id])).filter((b) => b.id !== o.id && blocksMove(objectOf(b)));
        const map = await this.db.one<{ cols: number; rows: number }>('SELECT cols, rows FROM room_maps WHERE id = $1', [o.map_id]);
        const at = farSide(t, o, map!, blockers);
        if (at) await moveToken(at.x, at.y);
        else lines.push('對面沒有空位落腳，代幣留在原地');
      }
    });
    if (isTrap(o.kind) && action === 'disarm' && success) lines.push('陷阱已經解除');
    for (const line of lines) await this.table.system(roomId, line, now, '場地');
    return { success, total: final, bonus: a.bonus, quality: a.quality, dc: a.dc, text: lines.join('。'), mapId: o.map_id };
  }
}

/** The square of the object's footprint closest to the token (where a climber ends up). */
function nearestCell(t: TokenRow, o: ObjectRow) {
  return { x: Math.max(o.x, Math.min(o.x + o.w - t.size, t.x)), y: Math.max(o.y, Math.min(o.y + o.h - t.size, t.y)) };
}

/** Across the object from the token, the first free square along the line through its middle. */
function farSide(t: TokenRow, o: ObjectRow, map: { cols: number; rows: number }, blockers: ObjectRow[]) {
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2, tx = t.x + t.size / 2, ty = t.y + t.size / 2;
  let dx = cx - tx, dy = cy - ty;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  dx /= len; dy /= len;
  const inside = (x: number, y: number, b: { x: number; y: number; w: number; h: number }) => x + t.size > b.x && x < b.x + b.w && y + t.size > b.y && y < b.y + b.h;
  for (let k = 1; k < 40; k++) {
    const x = Math.round(tx + dx * k - t.size / 2), y = Math.round(ty + dy * k - t.size / 2);
    if (x < 0 || y < 0 || x + t.size > map.cols || y + t.size > map.rows) return null;
    if (inside(x, y, o)) continue;
    if (blockers.some((b) => inside(x, y, b))) return null;
    if (gapTo({ x, y, size: t.size }, o) <= 1) return { x, y };
  }
  return null;
}

const KIND_NAME: Partial<Record<MapObjectKind, string>> = {
  wall: '牆', door: '門', window: '窗', chest: '寶箱', crate: '木箱', barrel: '木桶', tree: '樹', rock: '岩石', statue: '雕像', water: '水', trap: '陷阱',
  cracked_wall: '裂開的牆', gate: '鐵柵門', fence: '柵欄', cliff: '懸崖', ladder: '梯子', pit: '坑洞', cage: '籠子', lava: '岩漿', web: '蛛網', lever: '拉桿',
  rope: '繩索', spikes: '尖刺地面', barricade: '路障', stalagmite: '石筍',
};
