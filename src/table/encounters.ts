import { randomInt, randomUUID } from 'node:crypto';
import {
  CombatError, createEncounter, runClock, runCommand, runMove, viewFor,
  type Command, type Ctx, type Outcome, type SetupEntry, type TokenInfo,
} from '../encounter/engine';
import { blockMap, type Grid } from '../encounter/geometry';
import { BASIC_PATTERNS, DEFAULT_RULES } from '../encounter/rules';
import { DEFAULT_PREFS, type StartInput, type CombatPrefs, type EncounterEvent, type EncounterState, type EncounterView, type PackCombat, type PatternDef } from '../encounter/types';
import { throwDie } from '../dice/physics';
import { emittersOf } from '../pack/combat';
import type { Database } from '../persistence/db';
import type { Rng } from '../rules/dice';
import { TableError, type TableStore } from './store';
import type { MapObjectKind } from './types';

/**
 * Interactive combat for a room: one running encounter at a time, on a map. Every command loads the encounter,
 * locks it, runs the pure engine and saves the result in one transaction, so two players pressing at once never
 * interleave. What happened is kept as an append-only event list (with the replay data for every dodge); results
 * worth keeping also go to the room log.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS encounters (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  map_id TEXT NOT NULL,
  status TEXT NOT NULL,
  state TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS encounters_one_running ON encounters(room_id) WHERE status <> 'ended';
CREATE INDEX IF NOT EXISTS encounters_due ON encounters(deadline) WHERE status <> 'ended';
CREATE TABLE IF NOT EXISTS encounter_events (
  encounter_id TEXT NOT NULL REFERENCES encounters(id),
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  gm_only BOOLEAN NOT NULL DEFAULT false,
  data TEXT,
  PRIMARY KEY (encounter_id, seq)
);
CREATE OR REPLACE TRIGGER encounter_events_append_only BEFORE UPDATE OR DELETE ON encounter_events
FOR EACH ROW EXECUTE FUNCTION fw_forbid('encounter events are append-only');
CREATE TABLE IF NOT EXISTS encounter_requests (
  encounter_id TEXT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (encounter_id, request_id)
);
CREATE TABLE IF NOT EXISTS combat_prefs (
  user_id TEXT PRIMARY KEY,
  prefs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS combat_vitals (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  character_id TEXT NOT NULL,
  hp INTEGER NOT NULL,
  PRIMARY KEY (room_id, character_id)
);
CREATE TABLE IF NOT EXISTS room_patterns (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  name TEXT NOT NULL,
  emitters TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export const ENCOUNTER_LIMITS = { patterns: 40, events: 300 };

/** A pack without combat.json still gets a combat tracker: initiative, HP and the basic dodge patterns. */
export const EMPTY_COMBAT: PackCombat = { rules: DEFAULT_RULES, weapons: [], spells: [], monsters: [], patterns: BASIC_PATTERNS, encounters: [] };

export interface EncounterBundle {
  encounter: EncounterView | null;
  events: EncounterEvent[];
  /** HP characters carry between fights. */
  vitals: Record<string, number>;
}


interface Row { id: string; room_id: string; map_id: string; status: string; state: string; seq: number }

export class EncounterStore {
  private constructor(private db: Database, private table: TableStore, private rng: Rng) {}

  static async open(db: Database, table: TableStore, rng: Rng) {
    await db.migrate(SCHEMA);
    return new EncounterStore(db, table, rng);
  }

  /** The running encounter as this member may see it, the recent events, and carried-over HP. */
  async current(roomId: string, userId: string, after = 0): Promise<EncounterBundle> {
    const me = await this.table.requireRole(roomId, userId, 'player');
    const row = await this.db.one<Row>(`SELECT * FROM encounters WHERE room_id = $1 ORDER BY (status = 'ended'), updated_at DESC LIMIT 1`, [roomId]);
    const vitals = await this.vitals(roomId);
    if (!row) return { encounter: null, events: [], vitals };
    const state = JSON.parse(row.state) as EncounterState;
    const prefs = await this.prefs(userId);
    return { encounter: viewFor(state, userId, me.role === 'gm', prefs), events: await this.eventsOf(row.id, me.role === 'gm', after), vitals };
  }

  async start(roomId: string, userId: string, input: StartInput, now = new Date()): Promise<EncounterBundle> {
    await this.table.requireRole(roomId, userId, 'gm');
    const mapId = (await this.db.one<{ active_map_id: string | null }>('SELECT active_map_id FROM rooms WHERE id = $1', [roomId]))?.active_map_id;
    if (!mapId) throw new TableError(400, 'no-map', '先打開一張地圖，戰鬥會在上面進行');
    await this.db.tx(async () => {
      await this.db.query('SELECT 1 FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
      if (await this.db.one(`SELECT 1 FROM encounters WHERE room_id = $1 AND status <> 'ended'`, [roomId])) throw new TableError(409, 'running', '已經有一場戰鬥在進行，先結束它');
      const ctx = await this.context(roomId, mapId, now);
      const entries = [...(input.entries ?? [])];
      if (input.template) entries.push(...(await this.placeTemplate(ctx, mapId, input.template, now)));
      if (entries.length === 0) throw new TableError(400, 'bad-request', '至少要選一個代幣加入戰鬥');
      const vitals = await this.vitals(roomId);
      for (const e of entries) {
        const t = ctx.tokens.get(e.tokenId);
        if (t?.characterId && vitals[t.characterId] !== undefined) e.hpNow = vitals[t.characterId];
      }
      const out = this.guard(() => createEncounter(ctx, roomId, mapId, entries, { mode: input.mode, autoNpc: input.autoNpc, showFoeHp: input.showFoeHp, autoEnd: input.autoEnd }));
      await this.db.run(`INSERT INTO encounters (id, room_id, map_id, status, state, seq, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 0, $6, $6)`,
        [out.state.id, roomId, mapId, out.state.status, JSON.stringify(out.state), now.toISOString()]);
      await this.save(out, now);
    });
    return this.current(roomId, userId);
  }

  /** One command from a member. A repeated requestId (a resend on a flaky phone) does nothing the second time. */
  async command(roomId: string, userId: string, requestId: unknown, cmd: Command, now = new Date()): Promise<EncounterBundle> {
    if (typeof requestId !== 'string' || !/^[\w-]{8,64}$/.test(requestId)) throw new TableError(400, 'bad-request', '缺少 requestId');
    if (!cmd || typeof cmd !== 'object' || typeof (cmd as { type?: unknown }).type !== 'string') throw new TableError(400, 'bad-request', '指令格式錯誤');
    const me = await this.table.requireRole(roomId, userId, 'player');
    await this.db.tx(async () => {
      const row = await this.lockRunning(roomId);
      const seen = await this.db.one('SELECT 1 FROM encounter_requests WHERE encounter_id = $1 AND request_id = $2', [row.id, requestId]);
      if (seen) return;
      const ctx = await this.context(roomId, row.map_id, now);
      const out = this.guard(() => runCommand(JSON.parse(row.state), ctx, { userId, gm: me.role === 'gm' }, cmd));
      await this.db.run('INSERT INTO encounter_requests (encounter_id, request_id, user_id) VALUES ($1, $2, $3)', [row.id, requestId, userId]);
      await this.save(out, now);
    });
    return this.current(roomId, userId);
  }

  /**
   * Called before a token moves. During a fight a combatant's token walks by the rules (its turn, its speed, around
   * walls); the engine moves it and this returns true. Tokens outside the fight are left to the map as usual.
   */
  async move(roomId: string, userId: string, tokenId: string, to: { x: number; y: number }, now = new Date()): Promise<boolean> {
    const me = await this.table.requireRole(roomId, userId, 'player');
    return this.db.tx(async () => {
      const row = await this.db.one<Row>(`SELECT * FROM encounters WHERE room_id = $1 AND status <> 'ended' FOR UPDATE`, [roomId]);
      if (!row) return false;
      const state = JSON.parse(row.state) as EncounterState;
      if (!Object.values(state.combatants).some((c) => c.tokenId === tokenId)) return false;
      const ctx = await this.context(roomId, row.map_id, now);
      const out = this.guard(() => runMove(state, ctx, { userId, gm: me.role === 'gm' }, tokenId, to));
      // A GM placing a creature off its turn moves the token like any other edit.
      if (out.moves.length === 0) return false;
      await this.save(out, now);
      return true;
    });
  }

  /** Runs what the clock says is due, in every room. Called every second by the server. */
  async tick(now = new Date()): Promise<{ roomId: string; mapId: string }[]> {
    const due = await this.db.query<{ id: string; room_id: string; map_id: string }>(`SELECT id, room_id, map_id FROM encounters WHERE status <> 'ended' AND deadline IS NOT NULL AND deadline <= $1 LIMIT 20`, [now.toISOString()]);
    const rooms: { roomId: string; mapId: string }[] = [];
    for (const d of due) {
      try {
        const changed = await this.db.tx(async () => {
          const row = await this.db.one<Row>(`SELECT * FROM encounters WHERE id = $1 AND status <> 'ended' FOR UPDATE SKIP LOCKED`, [d.id]);
          if (!row) return false;
          const ctx = await this.context(row.room_id, row.map_id, now);
          const out = runClock(JSON.parse(row.state), ctx);
          if (!out) {
            await this.db.run('UPDATE encounters SET deadline = NULL WHERE id = $1', [row.id]);
            return false;
          }
          await this.save(out, now);
          return true;
        });
        if (changed) rooms.push({ roomId: d.room_id, mapId: d.map_id });
      } catch (e) {
        console.error('encounter clock', d.id, e);
        // A broken encounter must not be retried every second forever; the GM can still act on it.
        await this.db.run('UPDATE encounters SET deadline = NULL WHERE id = $1', [d.id]);
      }
    }
    return rooms;
  }

  async events(roomId: string, userId: string, after: number): Promise<EncounterEvent[]> {
    const me = await this.table.requireRole(roomId, userId, 'player');
    const row = await this.db.one<{ id: string }>(`SELECT id FROM encounters WHERE room_id = $1 ORDER BY (status = 'ended'), updated_at DESC LIMIT 1`, [roomId]);
    return row ? this.eventsOf(row.id, me.role === 'gm', after) : [];
  }

  // ---------- preferences, carried HP, patterns ----------

  async prefs(userId: string): Promise<CombatPrefs> {
    const row = await this.db.one<{ prefs: string }>('SELECT prefs FROM combat_prefs WHERE user_id = $1', [userId]);
    return { ...DEFAULT_PREFS, ...(row ? JSON.parse(row.prefs) : {}) };
  }

  async setPrefs(userId: string, input: Partial<CombatPrefs>): Promise<CombatPrefs> {
    const p = { ...(await this.prefs(userId)) };
    if (input.interaction !== undefined) {
      if (!['full', 'reduced', 'off'].includes(input.interaction)) throw new TableError(400, 'bad-request', '互動程度只能是完整、減量或關閉');
      p.interaction = input.interaction;
    }
    for (const k of ['skipAnimations', 'watchReplays', 'highContrast', 'oneKey'] as const) if (input[k] !== undefined) p[k] = !!input[k];
    await this.db.run(`INSERT INTO combat_prefs (user_id, prefs) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs`, [userId, JSON.stringify(p)]);
    return p;
  }

  /** A long rest: every character is back to full HP for the next fight. */
  async rest(roomId: string, userId: string, now = new Date()) {
    await this.table.requireRole(roomId, userId, 'gm');
    await this.db.run('DELETE FROM combat_vitals WHERE room_id = $1', [roomId]);
    await this.table.system(roomId, 'GM 讓大家長休：所有角色生命回滿', now);
  }

  async patterns(roomId: string, userId: string): Promise<PatternDef[]> {
    await this.table.requireRole(roomId, userId, 'player');
    return this.roomPatterns(roomId);
  }

  async savePattern(roomId: string, userId: string, input: { id?: string; name?: unknown; emitters?: unknown }, now = new Date()): Promise<PatternDef> {
    await this.table.requireRole(roomId, userId, 'gm');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 30) throw new TableError(400, 'bad-request', '彈幕名稱要有 1 到 30 字');
    const problems: string[] = [];
    const emitters = emittersOf(input.emitters, '彈幕', (_f, path, msg) => problems.push(`${path.replace('彈幕.emitters', '發射器')}：${msg}`));
    if (problems.length) throw new TableError(400, 'bad-pattern', problems.slice(0, 5).join('；'));
    const existing = input.id ? await this.db.one('SELECT 1 FROM room_patterns WHERE id = $1 AND room_id = $2', [input.id, roomId]) : undefined;
    if (existing) {
      await this.db.run('UPDATE room_patterns SET name = $2, emitters = $3 WHERE id = $1', [input.id, name, JSON.stringify(emitters)]);
      return { id: input.id!, name, emitters };
    }
    const n = await this.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM room_patterns WHERE room_id = $1', [roomId]);
    if (Number(n?.n) >= ENCOUNTER_LIMITS.patterns) throw new TableError(400, 'bad-request', `一個房間最多 ${ENCOUNTER_LIMITS.patterns} 個自訂彈幕`);
    const id = `room-${randomUUID().slice(0, 8)}`;
    await this.db.run('INSERT INTO room_patterns (id, room_id, name, emitters, created_at) VALUES ($1, $2, $3, $4, $5)', [id, roomId, name, JSON.stringify(emitters), now.toISOString()]);
    return { id, name, emitters };
  }

  async removePattern(roomId: string, userId: string, id: string) {
    await this.table.requireRole(roomId, userId, 'gm');
    await this.db.run('DELETE FROM room_patterns WHERE id = $1 AND room_id = $2', [id, roomId]);
  }

  // ---------- internals ----------

  private async lockRunning(roomId: string): Promise<Row> {
    const row = await this.db.one<Row>(`SELECT * FROM encounters WHERE room_id = $1 AND status <> 'ended' FOR UPDATE`, [roomId]);
    if (!row) throw new TableError(404, 'no-encounter', '現在沒有進行中的戰鬥');
    return row;
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof CombatError) throw new TableError(e.status, e.code, e.message);
      throw e;
    }
  }

  /** Everything the engine reads: the pack, the map's grid and walls, the tokens, sheets and members' settings. */
  private async context(roomId: string, mapId: string, now: Date): Promise<Ctx> {
    const { pack, members, characters } = await this.table.combatContext(roomId);
    const map = await this.db.one<{ cols: number; rows: number; cell_distance: number }>('SELECT cols, rows, cell_distance FROM room_maps WHERE id = $1 AND room_id = $2', [mapId, roomId]);
    if (!map) throw new TableError(404, 'not-found', '戰鬥用的地圖不見了');
    const tokens = await this.db.query<{ id: string; name: string; x: number; y: number; size: number; elevation: number; hidden: boolean; character_id: string | null; owner_user_id: string }>(
      'SELECT id, name, x, y, size, elevation, hidden, character_id, owner_user_id FROM map_tokens WHERE map_id = $1', [mapId]);
    const objects = await this.db.query<{ kind: MapObjectKind; x: number; y: number; w: number; h: number; open: boolean; height: number | null }>(
      'SELECT kind, x, y, w, h, open, height FROM map_objects WHERE map_id = $1', [mapId]);
    const prefRows = await this.db.query<{ user_id: string; prefs: string }>('SELECT user_id, prefs FROM combat_prefs WHERE user_id = ANY($1)', [members.map((m) => m.userId)]);
    const prefs = new Map(prefRows.map((r) => [r.user_id, { ...DEFAULT_PREFS, ...JSON.parse(r.prefs) } as CombatPrefs]));
    const combat = pack.combat ?? EMPTY_COMBAT;
    const grid: Grid = { cols: map.cols, rows: map.rows, cellDistance: Number(map.cell_distance), rule: combat.rules.distance };
    return {
      pack, combat, patterns: [...combat.patterns, ...(await this.roomPatterns(roomId))], rng: this.rng, now,
      toss: (sides, launch, lane) => {
        if (![4, 6, 8, 10, 12, 20].includes(sides)) return null;
        const toss = { seed: randomInt(1, 2 ** 31 - 1), lane, ...(launch ? { launch } : {}) };
        return { value: throwDie(sides, toss), toss };
      },
      id: () => randomUUID(), seed: () => randomInt(1, 2 ** 31 - 1), grid,
      blocks: blockMap(grid, objects.map((o) => ({ ...o, open: !!o.open }))),
      tokens: new Map(tokens.map((t): [string, TokenInfo] => [t.id, { id: t.id, name: t.name, x: t.x, y: t.y, size: t.size, elevation: t.elevation ?? 0, hidden: t.hidden, characterId: t.character_id, ownerUserId: t.owner_user_id }])),
      sheets: new Map(characters.map((c) => [c.id, c.sheet])),
      prefs: (u) => prefs.get(u) ?? DEFAULT_PREFS,
      name: (u) => members.find((m) => m.userId === u)?.name ?? u,
    };
  }

  private async placeTemplate(ctx: Ctx, mapId: string, t: { id: string; x: number; y: number }, now: Date): Promise<SetupEntry[]> {
    const tpl = ctx.combat.encounters.find((e) => e.id === t.id);
    if (!tpl) throw new TableError(404, 'not-found', '沒有這個遭遇範本');
    const out: SetupEntry[] = [];
    for (const e of tpl.entries) {
      const m = ctx.combat.monsters.find((x) => x.id === e.monsterId)!;
      const x = Math.max(0, Math.min(ctx.grid.cols - m.size, Math.round(t.x) + e.dx)), y = Math.max(0, Math.min(ctx.grid.rows - m.size, Math.round(t.y) + e.dy));
      const id = randomUUID();
      const name = (e.name ?? m.name).slice(0, 24);
      await this.db.run(`INSERT INTO map_tokens (id, map_id, name, color, x, y, size, character_id, owner_user_id, hidden, created_at, elevation)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'gm', $8, $9, 0)`, [id, mapId, name, '#b5533c', x, y, m.size, !!e.hidden, now.toISOString()]);
      ctx.tokens.set(id, { id, name, x, y, size: m.size, elevation: 0, hidden: !!e.hidden, characterId: null, ownerUserId: 'gm' });
      out.push({ tokenId: id, monsterId: m.id, side: 'foe', ...(e.tier ? { tier: e.tier } : {}), hidden: !!e.hidden });
    }
    return out;
  }

  /** Writes an engine result: the new state, its events, token moves and reveals, carried HP, and log lines. */
  private async save(out: Outcome, now: Date) {
    const s = out.state;
    const row = await this.db.one<{ seq: number }>('SELECT seq FROM encounters WHERE id = $1', [s.id]);
    let seq = row?.seq ?? 0;
    for (const e of out.events) {
      seq++;
      await this.db.run('INSERT INTO encounter_events (encounter_id, seq, at, kind, text, gm_only, data) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [s.id, seq, now.toISOString(), e.kind, e.text, !!e.gmOnly, e.data === undefined ? null : JSON.stringify(e.data)]);
      if (e.log && !e.gmOnly) await this.table.system(s.roomId, e.text, now);
    }
    s.seq = seq;
    const deadline = s.status === 'paused' || s.status === 'ended' ? null : s.step?.deadline ?? null;
    await this.db.run('UPDATE encounters SET status = $2, state = $3, seq = $4, deadline = $5, updated_at = $6 WHERE id = $1',
      [s.id, s.status, JSON.stringify(s), seq, deadline, now.toISOString()]);
    for (const m of out.moves) await this.db.run('UPDATE map_tokens SET x = $2, y = $3 WHERE id = $1', [m.tokenId, m.x, m.y]);
    for (const t of out.reveals) await this.db.run('UPDATE map_tokens SET hidden = false WHERE id = $1', [t]);
    for (const v of out.vitals) {
      await this.db.run(`INSERT INTO combat_vitals (room_id, character_id, hp) VALUES ($1, $2, $3) ON CONFLICT (room_id, character_id) DO UPDATE SET hp = EXCLUDED.hp`, [s.roomId, v.characterId, v.hp]);
    }
  }

  private async eventsOf(encounterId: string, gm: boolean, after: number): Promise<EncounterEvent[]> {
    const rows = await this.db.query<{ seq: number; at: string; kind: string; text: string; gm_only: boolean; data: string | null }>(
      `SELECT * FROM (SELECT * FROM encounter_events WHERE encounter_id = $1 AND seq > $2 ${gm ? '' : 'AND NOT gm_only'} ORDER BY seq DESC LIMIT $3) t ORDER BY seq`,
      [encounterId, after, ENCOUNTER_LIMITS.events]);
    return rows.map((r) => ({ seq: r.seq, at: r.at, kind: r.kind, text: r.text, gmOnly: r.gm_only, ...(r.data ? { data: JSON.parse(r.data) } : {}) }));
  }

  private async vitals(roomId: string): Promise<Record<string, number>> {
    const rows = await this.db.query<{ character_id: string; hp: number }>('SELECT character_id, hp FROM combat_vitals WHERE room_id = $1', [roomId]);
    return Object.fromEntries(rows.map((r) => [r.character_id, r.hp]));
  }

  private async roomPatterns(roomId: string): Promise<PatternDef[]> {
    const rows = await this.db.query<{ id: string; name: string; emitters: string }>('SELECT id, name, emitters FROM room_patterns WHERE room_id = $1 ORDER BY created_at', [roomId]);
    return rows.map((r) => ({ id: r.id, name: r.name, emitters: JSON.parse(r.emitters) }));
  }
}
