import type { CharacterData, CheckMode, Pack, PackProblem, SheetValue } from '../../src/pack/pack';
import type { Character, LogEntry, MapInfo, MapSummary, MapView, Member, PackSummary, Role, Room, Token } from '../../src/table/types';

export type { CharacterData, CheckMode, LogEntry, MapInfo, MapSummary, MapView, Member, Pack, PackProblem, PackSummary, Role, Room, SheetValue, Token };

export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3000').replace(/\/$/, '');

export type RoomListItem = Room & { role: Role; packName: string };
/** Your own characters (and every character, for a GM) come with the sheet the server worked out. */
export type CharacterView = Character & { sheet: Record<string, SheetValue> };
export type CharacterRef = Pick<Character, 'id' | 'ownerUserId' | 'name'>;
export interface RoomView { room: Room; me: Member; members: Member[]; characters: (CharacterView | CharacterRef)[]; pack: PackSummary }
export type RollTarget =
  | { formula: string; label?: string; characterId?: string }
  | { characterId: string; check: { attribute: string } | { skill: string }; mode?: CheckMode }
  | { characterId: string; action: string };

export const hasSheet = (c: CharacterView | CharacterRef): c is CharacterView => 'sheet' in c;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public problems?: PackProblem[], public detail?: string) {
    super(message);
  }
}

/** Every call carries the signed-in player's token; the server decides what they may see and do. */
export type MapSettings = Partial<Pick<MapInfo, 'name' | 'cols' | 'rows' | 'cellDistance' | 'unit' | 'showGrid' | 'fogEnabled'>>;
export type TokenInput = Partial<Pick<Token, 'name' | 'color' | 'x' | 'y' | 'size' | 'characterId' | 'hidden'>>;

export class Api {
  constructor(readonly token: () => Promise<string>, private onUnauthorized?: () => void) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const raw = body instanceof Blob;
    let res: Response;
    try {
      res = await fetch(API_URL + path, {
        method,
        headers: {
          authorization: `Bearer ${await this.token()}`,
          ...(body === undefined ? {} : { 'content-type': raw ? (body.type || 'application/zip') : 'application/json' }),
        },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'offline', '連不上伺服器，剛才的動作沒有送出。伺服器閒置時會休眠，請等半分鐘再試一次。', undefined, `${method} ${path} → network error`);
    }
    if (res.ok && res.headers.get('content-type')?.startsWith('image/')) return await res.blob() as T;
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) this.onUnauthorized?.();
    if (!res.ok) {
      const detail = `${method} ${path} → ${res.status} ${data.error ?? ''} ${data.message ?? ''}`.trim();
      // The server's own words are written for players; anything else (a crash, a proxy page) gets a plain retry hint.
      const message = res.status < 500 && data.message ? data.message : '伺服器這次沒有處理好，剛才的動作沒有生效。請再試一次。';
      throw new ApiError(res.status, data.error ?? 'error', message, data.problems, detail);
    }
    return data as T;
  }

  packs() { return this.call<PackSummary[]>('GET', '/api/packs'); }
  pack(key: string) { return this.call<Pack>('GET', `/api/packs/${encodeURIComponent(key)}`); }
  uploadPack(zip: Blob) { return this.call<{ key: string; name: string }>('POST', '/api/packs', zip); }

  rooms() { return this.call<RoomListItem[]>('GET', '/api/rooms'); }
  createRoom(name: string, pack: string) { return this.call<Room>('POST', '/api/rooms', { name, pack }); }
  join(code: string) { return this.call<Room>('POST', '/api/rooms/join', { code }); }
  room(id: string) { return this.call<RoomView>('GET', `/api/rooms/${id}`); }
  log(id: string, after: number) { return this.call<LogEntry[]>('GET', `/api/rooms/${id}/log?after=${after}`); }
  setRole(id: string, userId: string, role: Role) { return this.call('POST', `/api/rooms/${id}/members/${encodeURIComponent(userId)}`, { role }); }
  chat(id: string, text: string) { return this.call<LogEntry>('POST', `/api/rooms/${id}/chat`, { text, requestId: crypto.randomUUID() }); }
  roll(id: string, target: RollTarget, secret = false) {
    return this.call<LogEntry>('POST', `/api/rooms/${id}/rolls`, { ...target, secret, requestId: crypto.randomUUID() });
  }
  createCharacter(id: string, name: string, data: CharacterData) { return this.call<Character>('POST', `/api/rooms/${id}/characters`, { name, data }); }
  updateCharacter(id: string, cid: string, version: number, change: { name?: string; data?: CharacterData }) {
    return this.call<Character>('PATCH', `/api/rooms/${id}/characters/${cid}`, { version, ...change });
  }

  maps(id: string) { return this.call<{ activeMapId: string | null; maps: MapSummary[] }>('GET', `/api/rooms/${id}/maps`); }
  createMap(id: string, s: MapSettings) { return this.call<MapInfo>('POST', `/api/rooms/${id}/maps`, s); }
  map(id: string, mid: string) { return this.call<MapView>('GET', `/api/rooms/${id}/maps/${mid}`); }
  updateMap(id: string, mid: string, s: MapSettings) { return this.call<MapInfo>('PATCH', `/api/rooms/${id}/maps/${mid}`, s); }
  deleteMap(id: string, mid: string) { return this.call('DELETE', `/api/rooms/${id}/maps/${mid}`); }
  activateMap(id: string, mid: string) { return this.call<MapInfo>('POST', `/api/rooms/${id}/maps/${mid}/activate`); }
  uploadMapImage(id: string, mid: string, image: Blob) { return this.call<MapInfo>('PUT', `/api/rooms/${id}/maps/${mid}/image`, image); }
  mapImage(id: string, mid: string) { return this.call<Blob>('GET', `/api/rooms/${id}/maps/${mid}/image`); }
  fog(id: string, mid: string, cells: number[] | 'all', covered: boolean) { return this.call<MapInfo>('POST', `/api/rooms/${id}/maps/${mid}/fog`, { cells, covered }); }
  addToken(id: string, mid: string, t: TokenInput) { return this.call<Token>('POST', `/api/rooms/${id}/maps/${mid}/tokens`, t); }
  updateToken(id: string, tid: string, t: TokenInput) { return this.call<Token>('PATCH', `/api/rooms/${id}/tokens/${tid}`, t); }
  removeToken(id: string, tid: string) { return this.call('DELETE', `/api/rooms/${id}/tokens/${tid}`); }
}
