import { randomBytes, randomUUID } from 'node:crypto';
import { evaluate, ExprError, type Evaluation } from '../pack/expr';
import {
  checkFormula, computeSheet, labeller, natural, rollOnSheet, validateCharacter,
  type CharacterData, type CheckMode, type Pack, type SheetValue,
} from '../pack/pack';
import type { Database } from '../persistence/db';
import type { Rng } from '../rules/dice';
import type { Character, CharacterView, LogEntry, Member, PackSummary, Role, RollBody, RollRequest, Room } from './types';

/**
 * Rooms: a table where one or more GMs and their players meet, under one rule pack. Everything said and rolled is
 * an append-only log entry with a sequence number, so a player who was away reads what happened since their last
 * visit. Dice are rolled here, on the server, never in the browser.
 */
const SCHEMA = `
CREATE OR REPLACE FUNCTION fw_forbid() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION '%', TG_ARGV[0]; END $$;
CREATE TABLE IF NOT EXISTS packs (
  key TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  builtin BOOLEAN NOT NULL DEFAULT false,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pack_key TEXT NOT NULL REFERENCES packs(key),
  code TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('gm', 'player')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS room_characters (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_log (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  user_id TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (room_id, seq)
);
CREATE TABLE IF NOT EXISTS room_requests (
  room_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (room_id, request_id)
);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS active_map_id TEXT;
CREATE OR REPLACE TRIGGER room_log_append_only BEFORE UPDATE OR DELETE ON room_log
FOR EACH ROW EXECUTE FUNCTION fw_forbid('the room log is append-only');
`;

export class TableError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export type { Character, CharacterView, LogEntry, Member, PackSummary, Role, RollBody, RollRequest, Room } from './types';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_TEXT = 1000;

export class TableStore {
  private packs = new Map<string, Pack>();

  private constructor(private db: Database) {}

  static async open(db: Database) {
    await db.migrate(SCHEMA);
    return new TableStore(db);
  }

  // ---------- packs ----------

  /** Built-in packs are refreshed on every start; uploaded ones are immutable, so a room never changes under its players. */
  async savePack(pack: Pack, userId: string, builtin: boolean, now = new Date()): Promise<string> {
    const key = `${pack.manifest.id}@${pack.manifest.version}`;
    const content = JSON.stringify(pack);
    if (builtin) {
      await this.db.run(`INSERT INTO packs (key, id, version, name, content, builtin, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, true, $6, $7)
        ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, name = EXCLUDED.name, builtin = true`,
      [key, pack.manifest.id, pack.manifest.version, pack.manifest.name, content, userId, now.toISOString()]);
    } else {
      const added = await this.db.run(`INSERT INTO packs (key, id, version, name, content, builtin, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, false, $6, $7)
        ON CONFLICT DO NOTHING`, [key, pack.manifest.id, pack.manifest.version, pack.manifest.name, content, userId, now.toISOString()]);
      if (!added) throw new TableError(409, 'pack-exists', `規則包 ${pack.manifest.id} ${pack.manifest.version} 已經存在；修改內容後請把 manifest.json 的 version 加一`);
    }
    this.packs.set(key, pack);
    return key;
  }

  async listPacks(): Promise<PackSummary[]> {
    const rows = await this.db.query<{ key: string }>('SELECT key FROM packs ORDER BY builtin DESC, name, version');
    const out: PackSummary[] = [];
    for (const r of rows) out.push(await this.packSummary(r.key));
    return out;
  }

  async pack(key: string): Promise<Pack> {
    const cached = this.packs.get(key);
    if (cached) return cached;
    const row = await this.db.one<{ content: string }>('SELECT content FROM packs WHERE key = $1', [key]);
    if (!row) throw new TableError(404, 'not-found', `找不到規則包 ${key}`);
    const pack = JSON.parse(row.content) as Pack;
    this.packs.set(key, pack);
    return pack;
  }

  private async packSummary(key: string): Promise<PackSummary> {
    const p = await this.pack(key);
    const row = await this.db.one<{ builtin: boolean }>('SELECT builtin FROM packs WHERE key = $1', [key]);
    const { id, version, name, license, attribution, description } = p.manifest;
    return { key, id, version, name, license, builtin: !!row?.builtin, ...(attribution ? { attribution } : {}), ...(description ? { description } : {}) };
  }

  // ---------- rooms and members ----------

  async createRoom(userId: string, userName: string, name: string, packKey: string, now = new Date()): Promise<Room> {
    name = text(name, 40, '房間名稱');
    await this.pack(packKey);
    return this.db.tx(async () => {
      const room: Room = { id: randomUUID(), name, packKey, code: roomCode(), createdBy: userId, createdAt: now.toISOString(), activeMapId: null };
      await this.db.run('INSERT INTO rooms (id, name, pack_key, code, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [room.id, room.name, room.packKey, room.code, userId, room.createdAt]);
      await this.db.run('INSERT INTO room_members (room_id, user_id, name, role, joined_at) VALUES ($1, $2, $3, $4, $5)', [room.id, userId, userName, 'gm', room.createdAt]);
      await this.append(room.id, userId, userName, 'system', { text: `${userName} 建立了房間，擔任 GM` }, now);
      return room;
    });
  }

  async roomsOf(userId: string): Promise<(Room & { role: Role; packName: string })[]> {
    const rows = await this.db.query<RoomRow & { role: Role; pack_name: string }>(`SELECT r.*, m.role, p.name AS pack_name FROM rooms r
      JOIN room_members m ON m.room_id = r.id JOIN packs p ON p.key = r.pack_key WHERE m.user_id = $1 ORDER BY r.created_at DESC`, [userId]);
    return rows.map((r) => ({ ...roomOf(r), role: r.role, packName: r.pack_name }));
  }

  async join(userId: string, userName: string, code: string, now = new Date()): Promise<Room> {
    const row = await this.db.one<RoomRow>('SELECT * FROM rooms WHERE code = $1', [String(code ?? '').trim().toUpperCase()]);
    if (!row) throw new TableError(404, 'not-found', '找不到這個房間代碼');
    await this.db.tx(async () => {
      const added = await this.db.run('INSERT INTO room_members (room_id, user_id, name, role, joined_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [row.id, userId, userName, 'player', now.toISOString()]);
      if (added) await this.append(row.id, userId, userName, 'system', { text: `${userName} 加入了房間` }, now);
    });
    return roomOf(row);
  }

  async setRole(roomId: string, by: string, userId: string, role: Role, now = new Date()) {
    await this.requireRole(roomId, by, 'gm');
    if (role !== 'gm' && role !== 'player') throw new TableError(400, 'bad-role', '身分只能是 gm 或 player');
    await this.db.tx(async () => {
      const target = await this.member(roomId, userId);
      if (!target) throw new TableError(404, 'not-found', '這個人不在房間裡');
      if (target.role === 'gm' && role === 'player') {
        const gms = await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM room_members WHERE room_id = $1 AND role = 'gm'`, [roomId]);
        if (Number(gms?.n) <= 1) throw new TableError(400, 'last-gm', '房間至少要有一位 GM');
      }
      await this.db.run('UPDATE room_members SET role = $3 WHERE room_id = $1 AND user_id = $2', [roomId, userId, role]);
      const actor = await this.member(roomId, by);
      await this.append(roomId, by, actor!.name, 'system', { text: `${actor!.name} 讓 ${target.name} 成為${role === 'gm' ? ' GM' : '玩家'}` }, now);
    });
  }

  /** Everything a member needs to draw the room. GMs see every sheet; players see their own sheets and others' names. */
  async view(roomId: string, userId: string) {
    const me = await this.requireRole(roomId, userId, 'player');
    const row = await this.db.one<RoomRow>('SELECT * FROM rooms WHERE id = $1', [roomId]);
    const pack = await this.pack(row!.pack_key);
    const members = (await this.db.query<{ user_id: string; name: string; role: Role }>('SELECT user_id, name, role FROM room_members WHERE room_id = $1 ORDER BY joined_at', [roomId]))
      .map((m): Member => ({ userId: m.user_id, name: m.name, role: m.role }));
    const characters = (await this.characters(roomId)).map((c): CharacterView | Pick<Character, 'id' | 'ownerUserId' | 'name'> =>
      me.role === 'gm' || c.ownerUserId === userId ? { ...c, sheet: computeSheet(pack, c.data).shown } : { id: c.id, ownerUserId: c.ownerUserId, name: c.name });
    return { room: roomOf(row!), me, members, characters, pack: await this.packSummary(row!.pack_key) };
  }

  async log(roomId: string, userId: string, after = 0, limit = 200): Promise<LogEntry[]> {
    const me = await this.requireRole(roomId, userId, 'player');
    const rows = await this.db.query<{ seq: number; at: string; user_id: string; author: string; kind: LogEntry['kind']; body: string }>(
      'SELECT * FROM room_log WHERE room_id = $1 AND seq > $2 ORDER BY seq LIMIT $3', [roomId, after, Math.min(limit, 500)]);
    return rows.flatMap((r) => {
      const body = JSON.parse(r.body);
      if (r.kind === 'roll' && body.secret && me.role !== 'gm' && r.user_id !== userId) return [];
      return [{ seq: r.seq, at: r.at, userId: r.user_id, author: r.author, kind: r.kind, body } as LogEntry];
    });
  }

  // ---------- chat and dice ----------

  async say(roomId: string, userId: string, requestId: string, words: string, now = new Date()): Promise<LogEntry> {
    const t = text(words, MAX_TEXT, '訊息');
    return this.once(roomId, userId, requestId, async (me) => this.append(roomId, userId, me.name, 'chat', { text: t }, now));
  }

  async roll(roomId: string, userId: string, requestId: string, req: RollRequest, rng: Rng, now = new Date()): Promise<LogEntry> {
    return this.once(roomId, userId, requestId, async (me) => {
      const pack = await this.pack((await this.db.one<{ pack_key: string }>('SELECT pack_key FROM rooms WHERE id = $1', [roomId]))!.pack_key);
      let character: Character | undefined;
      if (req.characterId) {
        character = (await this.characters(roomId)).find((c) => c.id === req.characterId);
        if (!character) throw new TableError(404, 'not-found', '找不到這個角色');
        if (character.ownerUserId !== userId && me.role !== 'gm') throw new TableError(403, 'forbidden', '只能替自己的角色擲骰');
      }
      const sheet = character ? computeSheet(pack, character.data) : undefined;
      const label = labeller(pack);
      const run = (formula: string): Evaluation => {
        try {
          return sheet ? rollOnSheet(pack, sheet, formula, rng) : evaluate(formula, () => undefined, rng, label);
        } catch (e) {
          if (e instanceof ExprError) throw new TableError(400, 'bad-formula', e.message);
          throw e;
        }
      };
      const who = character ? `${character.name}：` : '';
      let body: RollBody;
      if ('action' in req) {
        const action = pack.actions.find((a) => a.id === req.action);
        if (!action) throw new TableError(404, 'not-found', `沒有「${req.action}」這個動作`);
        const r = run(action.roll);
        body = { label: `${who}${action.label}`, text: r.text, total: r.total, natural: natural(pack, r) };
        if (action.damage) {
          const d = run(action.damage);
          body.damage = { text: d.text, total: d.total };
        }
      } else if ('check' in req) {
        if (!sheet) throw new TableError(400, 'bad-request', '檢定要指定角色');
        let formula: string;
        try { formula = checkFormula(pack, req.check, req.mode); } catch (e) { throw new TableError(400, 'bad-request', (e as Error).message); }
        const r = run(formula);
        const name = 'skill' in req.check ? pack.skills.find((s) => s.id === (req.check as { skill: string }).skill)!.name
          : pack.attributes.find((a) => a.id === (req.check as { attribute: string }).attribute)!.name;
        const mode = req.mode === 'advantage' ? '（優勢）' : req.mode === 'disadvantage' ? '（劣勢）' : '';
        body = { label: `${who}${name}檢定${mode}`, text: r.text, total: r.total, natural: natural(pack, r) };
      } else {
        const r = run(text(req.formula, 200, '公式'));
        body = { label: `${who}${req.label ? text(req.label, 40, '說明') : '擲骰'}`, text: r.text, total: r.total };
      }
      if (character) body.characterId = character.id;
      if (req.secret) body.secret = true;
      return this.append(roomId, userId, me.name, 'roll', body, now);
    });
  }

  /** A line from the table itself in the log, e.g. "the GM opened the map 「Crypt」". */
  async note(roomId: string, userId: string, words: string, now = new Date()): Promise<LogEntry> {
    return this.db.tx(async () => {
      const me = await this.requireRole(roomId, userId, 'player');
      return this.append(roomId, userId, me.name, 'system', { text: words }, now);
    });
  }

  // ---------- characters ----------

  async createCharacter(roomId: string, userId: string, name: string, data: CharacterData, now = new Date()): Promise<Character> {
    await this.requireRole(roomId, userId, 'player');
    const pack = await this.packOfRoom(roomId);
    const clean = cleanData(data);
    const problems = validateCharacter(pack, clean, true);
    if (problems.length) throw new TableError(400, 'invalid-character', problems.join('；'));
    const c: Character = { id: randomUUID(), ownerUserId: userId, name: text(name, 40, '角色名稱'), data: clean, version: 1 };
    await this.db.tx(async () => {
      await this.db.run('INSERT INTO room_characters (id, room_id, owner_user_id, name, data, version, created_at) VALUES ($1, $2, $3, $4, $5, 1, $6)',
        [c.id, roomId, userId, c.name, JSON.stringify(c.data), now.toISOString()]);
      const me = await this.member(roomId, userId);
      await this.append(roomId, userId, me!.name, 'system', { text: `${me!.name} 建立了角色「${c.name}」` }, now);
    });
    return c;
  }

  /** The owner or a GM changes a sheet. `version` must match, so two edits never silently overwrite each other. */
  async updateCharacter(roomId: string, userId: string, id: string, version: number, change: { name?: string; data?: CharacterData }): Promise<Character> {
    const me = await this.requireRole(roomId, userId, 'player');
    const pack = await this.packOfRoom(roomId);
    return this.db.tx(async () => {
      const row = await this.db.one<CharacterRow>('SELECT * FROM room_characters WHERE id = $1 AND room_id = $2 FOR UPDATE', [id, roomId]);
      if (!row) throw new TableError(404, 'not-found', '找不到這個角色');
      if (row.owner_user_id !== userId && me.role !== 'gm') throw new TableError(403, 'forbidden', '只能修改自己的角色');
      if (row.version !== version) throw new TableError(409, 'stale', '角色卡已經被別人改過，請重新整理');
      const data = change.data ? cleanData(change.data) : JSON.parse(row.data) as CharacterData;
      const problems = validateCharacter(pack, data, false);
      if (problems.length) throw new TableError(400, 'invalid-character', problems.join('；'));
      const name = change.name !== undefined ? text(change.name, 40, '角色名稱') : row.name;
      await this.db.run('UPDATE room_characters SET name = $2, data = $3, version = version + 1 WHERE id = $1', [id, name, JSON.stringify(data)]);
      return { id, ownerUserId: row.owner_user_id, name, data, version: version + 1 };
    });
  }

  // ---------- internals ----------

  private async characters(roomId: string): Promise<Character[]> {
    const rows = await this.db.query<CharacterRow>('SELECT * FROM room_characters WHERE room_id = $1 ORDER BY created_at', [roomId]);
    return rows.map((r) => ({ id: r.id, ownerUserId: r.owner_user_id, name: r.name, data: JSON.parse(r.data), version: r.version }));
  }

  private async packOfRoom(roomId: string) {
    const row = await this.db.one<{ pack_key: string }>('SELECT pack_key FROM rooms WHERE id = $1', [roomId]);
    if (!row) throw new TableError(404, 'not-found', '找不到這個房間');
    return this.pack(row.pack_key);
  }

  private async member(roomId: string, userId: string): Promise<Member | undefined> {
    const m = await this.db.one<{ user_id: string; name: string; role: Role }>('SELECT user_id, name, role FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
    return m && { userId: m.user_id, name: m.name, role: m.role };
  }

  /** The caller's membership, or a 403/404 when they are not a member or lack the role. */
  async requireRole(roomId: string, userId: string, role: Role): Promise<Member> {
    const m = await this.member(roomId, userId);
    if (!m) {
      const exists = await this.db.one('SELECT 1 FROM rooms WHERE id = $1', [roomId]);
      throw exists ? new TableError(403, 'not-member', '你不在這個房間裡，請用房間代碼加入') : new TableError(404, 'not-found', '找不到這個房間');
    }
    if (role === 'gm' && m.role !== 'gm') throw new TableError(403, 'forbidden', '只有 GM 可以這麼做');
    return m;
  }

  /** Runs a write once per request id: a resend (a flaky phone connection) returns the first result instead of rolling again. */
  private async once(roomId: string, userId: string, requestId: string, fn: (me: Member) => Promise<LogEntry>): Promise<LogEntry> {
    if (typeof requestId !== 'string' || !/^[\w-]{8,64}$/.test(requestId)) throw new TableError(400, 'bad-request', '缺少 requestId');
    const me = await this.requireRole(roomId, userId, 'player');
    return this.db.tx(async () => {
      await this.db.query('SELECT seq FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
      const seen = await this.db.one<{ seq: number; user_id: string }>('SELECT seq, user_id FROM room_requests WHERE room_id = $1 AND request_id = $2', [roomId, requestId]);
      if (seen) {
        if (seen.user_id !== userId) throw new TableError(409, 'request-reused', '這個 requestId 已經被用過了');
        return (await this.log(roomId, userId, seen.seq - 1, 1))[0];
      }
      const entry = await fn(me);
      await this.db.run('INSERT INTO room_requests (room_id, request_id, user_id, seq) VALUES ($1, $2, $3, $4)', [roomId, requestId, userId, entry.seq]);
      return entry;
    });
  }

  private async append<K extends LogEntry['kind']>(roomId: string, userId: string, author: string, kind: K, body: Extract<LogEntry, { kind: K }>['body'], now: Date): Promise<LogEntry> {
    const row = await this.db.one<{ seq: number }>('UPDATE rooms SET seq = seq + 1 WHERE id = $1 RETURNING seq', [roomId]);
    const at = now.toISOString();
    await this.db.run('INSERT INTO room_log (room_id, seq, at, user_id, author, kind, body) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [roomId, row!.seq, at, userId, author, kind, JSON.stringify(body)]);
    return { seq: row!.seq, at, userId, author, kind, body } as LogEntry;
  }
}

interface RoomRow { id: string; name: string; pack_key: string; code: string; created_by: string; created_at: string; active_map_id: string | null }
interface CharacterRow { id: string; owner_user_id: string; name: string; data: string; version: number }

const roomOf = (r: RoomRow): Room => ({ id: r.id, name: r.name, packKey: r.pack_key, code: r.code, createdBy: r.created_by, createdAt: r.created_at, activeMapId: r.active_map_id ?? null });

function roomCode() {
  return [...randomBytes(6)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function text(v: unknown, max: number, what: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new TableError(400, 'bad-request', `${what}不能空白`);
  if (s.length > max) throw new TableError(400, 'bad-request', `${what}最多 ${max} 字`);
  return s;
}

/** Keeps only plain numbers keyed by plain names, whatever a client sent. */
function cleanData(d: unknown): CharacterData {
  const part = (v: unknown) => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {})
    .filter(([k, n]) => /^[a-z][a-z0-9_]{0,31}$/.test(k) && typeof n === 'number' && Number.isFinite(n)));
  const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  return { scores: part(o.scores), ranks: part(o.ranks), inputs: part(o.inputs) };
}
