import { randomUUID } from 'node:crypto';
import type { Database } from '../persistence/db';
import { TableError, type TableStore } from './store';
import { MAP_OBJECT_KINDS, type MapInfo, type MapObject, type MapObjectKind, type MapSummary, type MapView, type Token } from './types';

/**
 * Battle maps for a room: a square grid, an optional picture under it, tokens on it and fog over it. GMs build and
 * run the maps; players see the map the GM has opened, move their own tokens, and never receive hidden tokens or
 * tokens standing under fog.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS room_maps (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  name TEXT NOT NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  cell_distance DOUBLE PRECISION NOT NULL DEFAULT 5,
  unit TEXT NOT NULL DEFAULT '呎',
  show_grid BOOLEAN NOT NULL DEFAULT true,
  fog_enabled BOOLEAN NOT NULL DEFAULT false,
  fog TEXT NOT NULL,
  image_version INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS map_images (
  map_id TEXT PRIMARY KEY REFERENCES room_maps(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS map_tokens (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES room_maps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  size INTEGER NOT NULL,
  character_id TEXT,
  owner_user_id TEXT NOT NULL,
  hidden BOOLEAN NOT NULL DEFAULT false,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS map_tokens_map ON map_tokens(map_id);
CREATE TABLE IF NOT EXISTS map_objects (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES room_maps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  w INTEGER NOT NULL,
  h INTEGER NOT NULL,
  rotation INTEGER NOT NULL DEFAULT 0,
  hidden BOOLEAN NOT NULL DEFAULT false,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS map_objects_map ON map_objects(map_id);
ALTER TABLE map_tokens ADD COLUMN IF NOT EXISTS elevation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE map_objects ADD COLUMN IF NOT EXISTS open BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE map_objects ADD COLUMN IF NOT EXISTS height INTEGER;
ALTER TABLE map_tokens ADD COLUMN IF NOT EXISTS image_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS token_images (
  token_id TEXT PRIMARY KEY REFERENCES map_tokens(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
`;

export const MAP_LIMITS = { side: 100, tokens: 200, objects: 500, imageBytes: 4 * 1024 * 1024, tokenImageBytes: 512 * 1024 };
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const COLOR = /^#[0-9a-f]{6}$/i;

interface MapRow {
  id: string; room_id: string; name: string; cols: number; rows: number; cell_distance: number; unit: string;
  show_grid: boolean; fog_enabled: boolean; fog: string; image_version: number; version: number;
}
interface TokenRow { id: string; map_id: string; name: string; color: string; x: number; y: number; size: number; character_id: string | null; owner_user_id: string; hidden: boolean; elevation: number; image_version: number }

interface ObjectRow { id: string; map_id: string; kind: string; name: string; x: number; y: number; w: number; h: number; rotation: number; hidden: boolean; open: boolean; height: number | null }
const objectOf = (r: ObjectRow): MapObject => ({
  id: r.id, mapId: r.map_id, kind: r.kind as MapObjectKind, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h, rotation: r.rotation, hidden: r.hidden,
  open: !!r.open, height: r.height ?? null,
});

const mapOf = (r: MapRow): MapInfo => ({
  id: r.id, name: r.name, cols: r.cols, rows: r.rows, cellDistance: Number(r.cell_distance), unit: r.unit,
  showGrid: r.show_grid, fogEnabled: r.fog_enabled, fog: r.fog, imageVersion: r.image_version, version: r.version,
});
const tokenOf = (r: TokenRow): Token => ({
  id: r.id, mapId: r.map_id, name: r.name, color: r.color, x: r.x, y: r.y, size: r.size,
  characterId: r.character_id, ownerUserId: r.owner_user_id, hidden: r.hidden, elevation: r.elevation ?? 0, imageVersion: r.image_version ?? 0,
});

export interface MapSettings { name?: string; cols?: number; rows?: number; cellDistance?: number; unit?: string; showGrid?: boolean; fogEnabled?: boolean }
export interface ObjectInput { kind?: string; name?: string; x?: number; y?: number; w?: number; h?: number; rotation?: number; hidden?: boolean; open?: boolean; height?: number | null }
export interface TokenInput { name?: string; color?: string; x?: number; y?: number; size?: number; characterId?: string | null; hidden?: boolean; elevation?: number }

export class MapStore {
  private constructor(private db: Database, private table: TableStore) {}

  static async open(db: Database, table: TableStore) {
    await db.migrate(SCHEMA);
    return new MapStore(db, table);
  }

  async list(roomId: string, userId: string): Promise<{ activeMapId: string | null; maps: MapSummary[] }> {
    const me = await this.table.requireRole(roomId, userId, 'player');
    const active = await this.activeId(roomId);
    const rows = await this.db.query<MapRow>('SELECT * FROM room_maps WHERE room_id = $1 ORDER BY created_at', [roomId]);
    const maps = rows.filter((r) => me.role === 'gm' || r.id === active)
      .map((r) => ({ id: r.id, name: r.name, cols: r.cols, rows: r.rows, imageVersion: r.image_version }));
    return { activeMapId: active, maps };
  }

  async create(roomId: string, userId: string, input: MapSettings, now = new Date()): Promise<MapInfo> {
    await this.table.requireRole(roomId, userId, 'gm');
    const cols = side(input.cols ?? 20, '寬度'), rows = side(input.rows ?? 15, '高度');
    const id = randomUUID();
    await this.db.tx(async () => {
      await this.db.run(`INSERT INTO room_maps (id, room_id, name, cols, rows, fog, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, roomId, words(input.name ?? '新地圖', 40, '地圖名稱'), cols, rows, '1'.repeat(cols * rows), now.toISOString()]);
      if (!(await this.activeId(roomId))) await this.db.run('UPDATE rooms SET active_map_id = $2 WHERE id = $1', [roomId, id]);
    });
    if (Object.keys(input).some((k) => !['name', 'cols', 'rows'].includes(k))) return this.update(roomId, userId, id, input);
    return (await this.view(roomId, userId, id)).map;
  }

  /** The map with what this member may see of it. Players may only open the map the GM has opened. */
  async view(roomId: string, userId: string, mapId: string): Promise<MapView> {
    const me = await this.table.requireRole(roomId, userId, 'player');
    const row = await this.row(roomId, mapId);
    if (me.role !== 'gm' && (await this.activeId(roomId)) !== mapId) throw new TableError(403, 'forbidden', 'GM 還沒打開這張地圖');
    const tokens = (await this.db.query<TokenRow>('SELECT * FROM map_tokens WHERE map_id = $1 ORDER BY created_at', [mapId])).map(tokenOf);
    const objects = (await this.db.query<ObjectRow>('SELECT * FROM map_objects WHERE map_id = $1 ORDER BY created_at', [mapId])).map(objectOf);
    if (me.role === 'gm') return { map: mapOf(row), tokens, objects };
    const covered = (x: number, y: number) => row.fog_enabled && row.fog[y * row.cols + x] === '1';
    // Scenery stays secret until some part of it is out of the fog, so players cannot read the layout from the page.
    const fogged = (o: MapObject) => {
      for (let y = o.y; y < Math.min(o.y + o.h, row.rows); y++) for (let x = o.x; x < Math.min(o.x + o.w, row.cols); x++) if (!covered(x, y)) return false;
      return true;
    };
    return {
      map: mapOf(row),
      tokens: tokens.filter((t) => t.ownerUserId === userId || (!t.hidden && !covered(t.x, t.y))),
      objects: objects.filter((o) => !o.hidden && !fogged(o)),
    };
  }

  async update(roomId: string, userId: string, mapId: string, s: MapSettings): Promise<MapInfo> {
    await this.table.requireRole(roomId, userId, 'gm');
    await this.db.tx(async () => {
      const row = await this.db.one<MapRow>('SELECT * FROM room_maps WHERE id = $1 AND room_id = $2 FOR UPDATE', [mapId, roomId]);
      if (!row) throw new TableError(404, 'not-found', '找不到這張地圖');
      const cols = s.cols !== undefined ? side(s.cols, '寬度') : row.cols;
      const rows = s.rows !== undefined ? side(s.rows, '高度') : row.rows;
      // A resized grid keeps the fog it had where the old and new grids overlap; new squares start covered.
      let fog = row.fog;
      if (cols !== row.cols || rows !== row.rows) {
        fog = '';
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) fog += x < row.cols && y < row.rows ? row.fog[y * row.cols + x] : '1';
      }
      const distance = s.cellDistance !== undefined ? Number(s.cellDistance) : Number(row.cell_distance);
      if (!Number.isFinite(distance) || distance <= 0 || distance > 1000) throw new TableError(400, 'bad-request', '每格距離要大於 0');
      await this.db.run(`UPDATE room_maps SET name = $2, cols = $3, rows = $4, cell_distance = $5, unit = $6, show_grid = $7, fog_enabled = $8, fog = $9,
        version = version + 1 WHERE id = $1`, [
        mapId, s.name !== undefined ? words(s.name, 40, '地圖名稱') : row.name, cols, rows, distance,
        s.unit !== undefined ? words(s.unit, 8, '距離單位') : row.unit,
        s.showGrid !== undefined ? !!s.showGrid : row.show_grid, s.fogEnabled !== undefined ? !!s.fogEnabled : row.fog_enabled, fog,
      ]);
      await this.db.run('UPDATE map_tokens SET x = LEAST(x, $2 - 1), y = LEAST(y, $3 - 1) WHERE map_id = $1', [mapId, cols, rows]);
      await this.db.run(`UPDATE map_objects SET w = LEAST(w, $2), h = LEAST(h, $3) WHERE map_id = $1`, [mapId, cols, rows]);
      await this.db.run(`UPDATE map_objects SET x = LEAST(x, $2 - w), y = LEAST(y, $3 - h) WHERE map_id = $1`, [mapId, cols, rows]);
    });
    return (await this.view(roomId, userId, mapId)).map;
  }

  async remove(roomId: string, userId: string, mapId: string) {
    await this.table.requireRole(roomId, userId, 'gm');
    await this.db.tx(async () => {
      await this.row(roomId, mapId);
      await this.db.run('UPDATE rooms SET active_map_id = NULL WHERE id = $1 AND active_map_id = $2', [roomId, mapId]);
      await this.db.run('DELETE FROM room_maps WHERE id = $1', [mapId]);
    });
  }

  async activate(roomId: string, userId: string, mapId: string): Promise<MapInfo> {
    await this.table.requireRole(roomId, userId, 'gm');
    const row = await this.row(roomId, mapId);
    await this.db.run('UPDATE rooms SET active_map_id = $2 WHERE id = $1', [roomId, mapId]);
    return mapOf(row);
  }

  async setImage(roomId: string, userId: string, mapId: string, type: string, bytes: Buffer): Promise<MapInfo> {
    await this.table.requireRole(roomId, userId, 'gm');
    if (!IMAGE_TYPES.includes(type)) throw new TableError(400, 'bad-request', '地圖圖片只能是 PNG、JPEG、WebP 或 GIF');
    if (bytes.length === 0) throw new TableError(400, 'bad-request', '請選一張圖片');
    if (bytes.length > MAP_LIMITS.imageBytes) throw new TableError(413, 'too-large', '圖片太大（上限 4 MB）');
    await this.db.tx(async () => {
      await this.row(roomId, mapId);
      await this.db.run(`INSERT INTO map_images (map_id, type, data) VALUES ($1, $2, $3)
        ON CONFLICT (map_id) DO UPDATE SET type = EXCLUDED.type, data = EXCLUDED.data`, [mapId, type, bytes.toString('base64')]);
      await this.db.run('UPDATE room_maps SET image_version = image_version + 1, version = version + 1 WHERE id = $1', [mapId]);
    });
    return (await this.view(roomId, userId, mapId)).map;
  }

  async image(roomId: string, userId: string, mapId: string): Promise<{ type: string; bytes: Buffer }> {
    await this.view(roomId, userId, mapId);
    const row = await this.db.one<{ type: string; data: string }>('SELECT type, data FROM map_images WHERE map_id = $1', [mapId]);
    if (!row) throw new TableError(404, 'not-found', '這張地圖沒有圖片');
    return { type: row.type, bytes: Buffer.from(row.data, 'base64') };
  }

  /** Covers or uncovers squares (by index, row by row), or the whole map when `cells` is 'all'. */
  async fog(roomId: string, userId: string, mapId: string, cells: number[] | 'all', covered: boolean): Promise<MapInfo> {
    await this.table.requireRole(roomId, userId, 'gm');
    await this.db.tx(async () => {
      const row = await this.db.one<MapRow>('SELECT * FROM room_maps WHERE id = $1 AND room_id = $2 FOR UPDATE', [mapId, roomId]);
      if (!row) throw new TableError(404, 'not-found', '找不到這張地圖');
      const n = row.cols * row.rows;
      let fog: string;
      if (cells === 'all') fog = (covered ? '1' : '0').repeat(n);
      else {
        if (!Array.isArray(cells) || cells.length > n) throw new TableError(400, 'bad-request', '迷霧格子格式錯誤');
        const chars = row.fog.split('');
        for (const c of cells) {
          if (!Number.isInteger(c) || c < 0 || c >= n) throw new TableError(400, 'bad-request', '迷霧格子超出地圖');
          chars[c] = covered ? '1' : '0';
        }
        fog = chars.join('');
      }
      await this.db.run('UPDATE room_maps SET fog = $2, version = version + 1 WHERE id = $1', [mapId, fog]);
    });
    return (await this.view(roomId, userId, mapId)).map;
  }

  // ---------- tokens ----------

  /** GMs place any token. A player places a token only for one of their own characters, once per map. */
  async addToken(roomId: string, userId: string, mapId: string, input: TokenInput, now = new Date()): Promise<Token> {
    const me = await this.table.requireRole(roomId, userId, 'player');
    const row = await this.row(roomId, mapId);
    if (me.role !== 'gm' && (await this.activeId(roomId)) !== mapId) throw new TableError(403, 'forbidden', 'GM 還沒打開這張地圖');
    const count = await this.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM map_tokens WHERE map_id = $1', [mapId]);
    if (Number(count?.n) >= MAP_LIMITS.tokens) throw new TableError(400, 'bad-request', `一張地圖最多 ${MAP_LIMITS.tokens} 個代幣`);
    let name = input.name, owner = userId;
    const characterId = input.characterId ?? null;
    if (characterId) {
      const c = await this.db.one<{ name: string; owner_user_id: string }>('SELECT name, owner_user_id FROM room_characters WHERE id = $1 AND room_id = $2', [characterId, roomId]);
      if (!c) throw new TableError(404, 'not-found', '找不到這個角色');
      if (c.owner_user_id !== userId && me.role !== 'gm') throw new TableError(403, 'forbidden', '只能放自己的角色');
      if (await this.db.one('SELECT 1 FROM map_tokens WHERE map_id = $1 AND character_id = $2', [mapId, characterId])) throw new TableError(409, 'exists', '這個角色已經在地圖上了');
      name ??= c.name;
      owner = c.owner_user_id;
    } else if (me.role !== 'gm') throw new TableError(403, 'forbidden', '玩家只能放自己角色的代幣');
    const size = tokenSize(input.size ?? 1);
    const t: Token = {
      id: randomUUID(), mapId, name: words(name ?? '代幣', 24, '代幣名稱'), color: color(input.color ?? '#6cc4a1'),
      x: cell(input.x ?? 0, row.cols - size + 1), y: cell(input.y ?? 0, row.rows - size + 1), size,
      characterId, ownerUserId: owner, hidden: me.role === 'gm' && !!input.hidden, elevation: elevation(input.elevation ?? 0), imageVersion: 0,
    };
    await this.db.run(`INSERT INTO map_tokens (id, map_id, name, color, x, y, size, character_id, owner_user_id, hidden, created_at, elevation)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [t.id, mapId, t.name, t.color, t.x, t.y, t.size, t.characterId, t.ownerUserId, t.hidden, now.toISOString(), t.elevation]);
    return t;
  }

  /** Moves or edits a token. Its owner may move it and rename or recolour it; only a GM may hide it or resize it. */
  async updateToken(roomId: string, userId: string, tokenId: string, input: TokenInput): Promise<Token> {
    const me = await this.table.requireRole(roomId, userId, 'player');
    return this.db.tx(async () => {
      const { token, map } = await this.tokenWithMap(roomId, tokenId, true);
      const gm = me.role === 'gm';
      if (!gm && token.owner_user_id !== userId) throw new TableError(403, 'forbidden', '只能移動自己的代幣');
      if (!gm && (input.hidden !== undefined || input.size !== undefined)) throw new TableError(403, 'forbidden', '只有 GM 能隱藏代幣或改大小');
      const size = input.size !== undefined ? tokenSize(input.size) : token.size;
      const next = {
        name: input.name !== undefined ? words(input.name, 24, '代幣名稱') : token.name,
        color: input.color !== undefined ? color(input.color) : token.color,
        x: cell(input.x ?? token.x, map.cols - size + 1), y: cell(input.y ?? token.y, map.rows - size + 1), size,
        hidden: input.hidden !== undefined ? !!input.hidden : token.hidden,
        elevation: input.elevation !== undefined ? elevation(input.elevation) : token.elevation ?? 0,
      };
      await this.db.run('UPDATE map_tokens SET name = $2, color = $3, x = $4, y = $5, size = $6, hidden = $7, elevation = $8 WHERE id = $1',
        [tokenId, next.name, next.color, next.x, next.y, next.size, next.hidden, next.elevation]);
      return { ...tokenOf(token), ...next };
    });
  }

  /** One token, if this member may see it. */
  async token(roomId: string, userId: string, tokenId: string): Promise<Token> {
    await this.table.requireRole(roomId, userId, 'player');
    const { token } = await this.tokenWithMap(roomId, tokenId, false);
    return tokenOf(token);
  }

  /** A picture for a token (a portrait, a monster). Its owner or a GM sets it; the browser shrinks it before sending. */
  async setTokenImage(roomId: string, userId: string, tokenId: string, type: string, bytes: Buffer | null): Promise<Token> {
    const me = await this.table.requireRole(roomId, userId, 'player');
    if (bytes) {
      if (!IMAGE_TYPES.includes(type)) throw new TableError(400, 'bad-request', '代幣圖片只能是 PNG、JPEG、WebP 或 GIF');
      if (bytes.length === 0) throw new TableError(400, 'bad-request', '請選一張圖片');
      if (bytes.length > MAP_LIMITS.tokenImageBytes) throw new TableError(413, 'too-large', '代幣圖片太大（上限 512 KB）');
    }
    return this.db.tx(async () => {
      const { token } = await this.tokenWithMap(roomId, tokenId, true);
      if (me.role !== 'gm' && token.owner_user_id !== userId) throw new TableError(403, 'forbidden', '只能換自己代幣的圖片');
      if (bytes) {
        await this.db.run(`INSERT INTO token_images (token_id, type, data) VALUES ($1, $2, $3)
          ON CONFLICT (token_id) DO UPDATE SET type = EXCLUDED.type, data = EXCLUDED.data`, [tokenId, type, bytes.toString('base64')]);
      } else await this.db.run('DELETE FROM token_images WHERE token_id = $1', [tokenId]);
      // A new version number tells browsers to fetch the new picture; 0 means none.
      const next = bytes ? Math.max(1, (token.image_version ?? 0) + 1) : 0;
      await this.db.run('UPDATE map_tokens SET image_version = $2 WHERE id = $1', [tokenId, next]);
      return { ...tokenOf(token), imageVersion: next };
    });
  }

  /** A token's picture, for members who can see the token. */
  async tokenImage(roomId: string, userId: string, tokenId: string): Promise<{ type: string; bytes: Buffer }> {
    const { token } = await this.tokenWithMap(roomId, tokenId, false);
    const seen = await this.view(roomId, userId, token.map_id);
    if (!seen.tokens.some((t) => t.id === tokenId)) throw new TableError(404, 'not-found', '找不到這個代幣');
    const row = await this.db.one<{ type: string; data: string }>('SELECT type, data FROM token_images WHERE token_id = $1', [tokenId]);
    if (!row) throw new TableError(404, 'not-found', '這個代幣沒有圖片');
    return { type: row.type, bytes: Buffer.from(row.data, 'base64') };
  }

  async removeToken(roomId: string, userId: string, tokenId: string): Promise<string> {
    const me = await this.table.requireRole(roomId, userId, 'player');
    const { token } = await this.tokenWithMap(roomId, tokenId, false);
    if (me.role !== 'gm' && token.owner_user_id !== userId) throw new TableError(403, 'forbidden', '只能移除自己的代幣');
    await this.db.run('DELETE FROM map_tokens WHERE id = $1', [tokenId]);
    return token.map_id;
  }

  // ---------- scenery ----------

  /** Only GMs lay out scenery. Objects are clamped onto the grid. */
  async addObject(roomId: string, userId: string, mapId: string, input: ObjectInput, now = new Date()): Promise<MapObject> {
    await this.table.requireRole(roomId, userId, 'gm');
    const row = await this.row(roomId, mapId);
    const count = await this.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM map_objects WHERE map_id = $1', [mapId]);
    if (Number(count?.n) >= MAP_LIMITS.objects) throw new TableError(400, 'bad-request', `一張地圖最多 ${MAP_LIMITS.objects} 個物件`);
    if (!MAP_OBJECT_KINDS.includes(input.kind as MapObjectKind)) throw new TableError(400, 'bad-request', '沒有這種物件');
    const o = placeObject(row, { id: randomUUID(), mapId, kind: input.kind as MapObjectKind, name: '', x: 0, y: 0, w: 1, h: 1, rotation: 0, hidden: false, open: false, height: null }, input);
    await this.db.run(`INSERT INTO map_objects (id, map_id, kind, name, x, y, w, h, rotation, hidden, created_at, open, height) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [o.id, mapId, o.kind, o.name, o.x, o.y, o.w, o.h, o.rotation, o.hidden, now.toISOString(), o.open, o.height]);
    return o;
  }

  async updateObject(roomId: string, userId: string, objectId: string, input: ObjectInput): Promise<MapObject> {
    await this.table.requireRole(roomId, userId, 'gm');
    return this.db.tx(async () => {
      const { object, map } = await this.objectWithMap(roomId, objectId, true);
      if (input.kind !== undefined && !MAP_OBJECT_KINDS.includes(input.kind as MapObjectKind)) throw new TableError(400, 'bad-request', '沒有這種物件');
      const o = placeObject(map, objectOf(object), input);
      await this.db.run('UPDATE map_objects SET kind = $2, name = $3, x = $4, y = $5, w = $6, h = $7, rotation = $8, hidden = $9, open = $10, height = $11 WHERE id = $1',
        [objectId, o.kind, o.name, o.x, o.y, o.w, o.h, o.rotation, o.hidden, o.open, o.height]);
      return o;
    });
  }

  async removeObject(roomId: string, userId: string, objectId: string): Promise<string> {
    await this.table.requireRole(roomId, userId, 'gm');
    const { object } = await this.objectWithMap(roomId, objectId, false);
    await this.db.run('DELETE FROM map_objects WHERE id = $1', [objectId]);
    return object.map_id;
  }

  // ---------- internals ----------

  private async activeId(roomId: string): Promise<string | null> {
    return (await this.db.one<{ active_map_id: string | null }>('SELECT active_map_id FROM rooms WHERE id = $1', [roomId]))?.active_map_id ?? null;
  }

  private async row(roomId: string, mapId: string): Promise<MapRow> {
    const row = await this.db.one<MapRow>('SELECT * FROM room_maps WHERE id = $1 AND room_id = $2', [mapId, roomId]);
    if (!row) throw new TableError(404, 'not-found', '找不到這張地圖');
    return row;
  }

  private async objectWithMap(roomId: string, objectId: string, lock: boolean) {
    const object = await this.db.one<ObjectRow>(`SELECT o.* FROM map_objects o JOIN room_maps m ON m.id = o.map_id
      WHERE o.id = $1 AND m.room_id = $2${lock ? ' FOR UPDATE OF o' : ''}`, [objectId, roomId]);
    if (!object) throw new TableError(404, 'not-found', '找不到這個物件');
    const map = await this.row(roomId, object.map_id);
    return { object, map };
  }

  private async tokenWithMap(roomId: string, tokenId: string, lock: boolean) {
    const token = await this.db.one<TokenRow>(`SELECT t.* FROM map_tokens t JOIN room_maps m ON m.id = t.map_id
      WHERE t.id = $1 AND m.room_id = $2${lock ? ' FOR UPDATE OF t' : ''}`, [tokenId, roomId]);
    if (!token) throw new TableError(404, 'not-found', '找不到這個代幣');
    const map = await this.row(roomId, token.map_id);
    return { token, map };
  }
}

/** Applies a change to an object and keeps it on the grid: size first (no larger than the map), then position. */
function placeObject(map: MapRow, o: MapObject, input: ObjectInput): MapObject {
  const span = (v: unknown, limit: number, what: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > MAP_LIMITS.side) throw new TableError(400, 'bad-request', `物件${what}要是 1 到 ${MAP_LIMITS.side} 格`);
    return Math.min(n, limit);
  };
  const w = input.w !== undefined ? span(input.w, map.cols, '寬度') : Math.min(o.w, map.cols);
  const h = input.h !== undefined ? span(input.h, map.rows, '高度') : Math.min(o.h, map.rows);
  const rotation = input.rotation !== undefined ? Number(input.rotation) : o.rotation;
  if (![0, 90, 180, 270].includes(rotation)) throw new TableError(400, 'bad-request', '旋轉角度只能是 0、90、180、270');
  const name = input.name !== undefined ? (typeof input.name === 'string' ? input.name.trim() : '') : o.name;
  if (name.length > 40) throw new TableError(400, 'bad-request', '物件名稱最多 40 字');
  return {
    ...o, kind: (input.kind as MapObjectKind | undefined) ?? o.kind, name, w, h, rotation,
    x: cell(input.x ?? o.x, map.cols - w + 1), y: cell(input.y ?? o.y, map.rows - h + 1),
    hidden: input.hidden !== undefined ? !!input.hidden : o.hidden,
    open: input.open !== undefined ? !!input.open : o.open,
    height: input.height !== undefined ? (input.height === null ? null : heightFeet(input.height)) : o.height,
  };
}
function heightFeet(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 200) throw new TableError(400, 'bad-request', '物件高度要是 0 到 200 呎');
  return n;
}
function elevation(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < -100 || n > 500) throw new TableError(400, 'bad-request', '高度要是 -100 到 500 的整數');
  return n;
}

function side(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAP_LIMITS.side) throw new TableError(400, 'bad-request', `地圖${what}要是 1 到 ${MAP_LIMITS.side} 格`);
  return n;
}
function cell(v: unknown, limit: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TableError(400, 'bad-request', '代幣位置要是數字');
  return Math.max(0, Math.min(Math.max(0, limit - 1), Math.round(n)));
}
function tokenSize(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 6) throw new TableError(400, 'bad-request', '代幣大小要是 1 到 6 格');
  return n;
}
function color(v: unknown): string {
  if (typeof v !== 'string' || !COLOR.test(v)) throw new TableError(400, 'bad-request', '顏色要寫成 #rrggbb');
  return v.toLowerCase();
}
function words(v: unknown, max: number, what: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new TableError(400, 'bad-request', `${what}不能空白`);
  if (s.length > max) throw new TableError(400, 'bad-request', `${what}最多 ${max} 字`);
  return s;
}
