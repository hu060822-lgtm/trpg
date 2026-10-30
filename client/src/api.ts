import type { CharacterData, CheckMode, CheckTarget, Pack, PackProblem, SheetValue } from '../../src/pack/pack';
import type { Command } from '../../src/encounter/engine';
import type { CombatPrefs, EncounterEvent, EncounterView, PatternDef, Emitter, StartInput } from '../../src/encounter/types';
import type { Character, CharacterView, LogEntry, MapInfo, MapObject, MapObjectKind, MapSummary, MapView, Member, ObjectProps, PackSummary, Role, Room, Token } from '../../src/table/types';
import type { FieldResult, FieldStart } from '../../src/table/fieldRules';
import type { Launch } from '../../src/dice/physics';
import type { GestureInput } from '../../src/encounter/types';

export type { Command, CombatPrefs, EncounterEvent, EncounterView, PatternDef, Emitter, StartInput };
export type { CharacterData, CharacterView, CheckMode, CheckTarget, LogEntry, MapInfo, MapObject, MapObjectKind, MapSummary, MapView, Member, Pack, PackProblem, PackSummary, Role, Room, SheetValue, Token };

export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3000').replace(/\/$/, '');

export type RoomListItem = Room & { role: Role; packName: string };
export type CharacterRef = Pick<Character, 'id' | 'ownerUserId' | 'name'>;
export interface RoomView { room: Room; me: Member; members: Member[]; characters: (CharacterView | CharacterRef)[]; pack: PackSummary }
export type RollTarget =
  | { formula: string; label?: string; characterId?: string }
  | { characterId: string; check: CheckTarget; mode?: CheckMode }
  | { characterId: string; action: string };

export const hasSheet = (c: CharacterView | CharacterRef): c is CharacterView => 'sheet' in c;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public problems?: PackProblem[], public detail?: string) {
    super(message);
  }
}

/** Every call carries the signed-in player's token; the server decides what they may see and do. */
export interface MapTemplateInfo { id: string; name: string; blurb: string; group: string; cols: number; rows: number }
export type MapSettings = Partial<Pick<MapInfo, 'name' | 'cols' | 'rows' | 'cellDistance' | 'unit' | 'showGrid' | 'fogEnabled'>>;
export type ObjectInput = Partial<Pick<MapObject, 'kind' | 'name' | 'x' | 'y' | 'w' | 'h' | 'rotation' | 'hidden' | 'open'>> & { height?: number | null; props?: { [K in keyof ObjectProps]?: ObjectProps[K] | null } | null };
export type { FieldResult, FieldStart } from '../../src/table/fieldRules';
export type TokenInput = Partial<Pick<Token, 'name' | 'color' | 'x' | 'y' | 'size' | 'characterId' | 'hidden' | 'elevation'>>;
export interface EncounterBundle { encounter: EncounterView | null; events: EncounterEvent[]; vitals: Record<string, number> }

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
  deleteRoom(id: string, confirm: string) { return this.call('DELETE', `/api/rooms/${id}`, { confirm }); }
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
  createMap(id: string, s: MapSettings & { template?: string; seed?: number }) { return this.call<MapInfo>('POST', `/api/rooms/${id}/maps`, s); }
  mapTemplates() { return this.call<MapTemplateInfo[]>('GET', '/api/map-templates'); }
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
  uploadTokenImage(id: string, tid: string, image: Blob) { return this.call<Token>('PUT', `/api/rooms/${id}/tokens/${tid}/image`, image); }
  removeTokenImage(id: string, tid: string) { return this.call<Token>('DELETE', `/api/rooms/${id}/tokens/${tid}/image`); }
  tokenImage(id: string, tid: string) { return this.call<Blob>('GET', `/api/rooms/${id}/tokens/${tid}/image`); }
  addObject(id: string, mid: string, o: ObjectInput) { return this.call<MapObject>('POST', `/api/rooms/${id}/maps/${mid}/objects`, o); }
  updateObject(id: string, oid: string, o: ObjectInput) { return this.call<MapObject>('PATCH', `/api/rooms/${id}/objects/${oid}`, o); }
  removeObject(id: string, oid: string) { return this.call('DELETE', `/api/rooms/${id}/objects/${oid}`); }

  encounter(id: string, after = 0) { return this.call<EncounterBundle>('GET', `/api/rooms/${id}/encounter?after=${after}`); }
  fieldStart(id: string, input: { objectId: string; tokenId: string; action: string; launch?: Launch }) { return this.call<FieldStart>('POST', `/api/rooms/${id}/field`, input); }
  fieldFinish(id: string, fid: string, input: GestureInput | null) { return this.call<FieldResult>('POST', `/api/rooms/${id}/field/${fid}/finish`, { input }); }
  startEncounter(id: string, input: StartInput) { return this.call<EncounterBundle>('POST', `/api/rooms/${id}/encounter`, input); }
  /** Every command carries its own request id, so a resend after a dropped connection does nothing twice. */
  command(id: string, cmd: Command, requestId = crypto.randomUUID()) { return this.call<EncounterBundle>('POST', `/api/rooms/${id}/encounter/command`, { ...cmd, requestId }); }
  rest(id: string) { return this.call('POST', `/api/rooms/${id}/encounter/rest`); }
  patterns(id: string) { return this.call<PatternDef[]>('GET', `/api/rooms/${id}/patterns`); }
  savePattern(id: string, p: { id?: string; name: string; emitters: Emitter[] }) { return this.call<PatternDef>('POST', `/api/rooms/${id}/patterns`, p); }
  removePattern(id: string, pid: string) { return this.call('DELETE', `/api/rooms/${id}/patterns/${pid}`); }
  combatPrefs() { return this.call<CombatPrefs>('GET', '/api/combat-prefs'); }
  setCombatPrefs(p: Partial<CombatPrefs>) { return this.call<CombatPrefs>('PUT', '/api/combat-prefs', p); }
}
