import type { CharacterDraft } from '../../src/character/create';
import type { CombatAction, CombatEvent, CombatState } from '../../src/combat/types';
import type { Change, GmGrant, LedgerEntry, WorldCommand, WorldEvent, WorldState } from '../../src/world/types';

export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3000').replace(/\/$/, '');

export interface StoredCharacter {
  id: string; name: string; classId: string; ownerUserId: string; attributes: Record<string, number>; skills: Record<string, number>;
  hp: number; maxHp: number; condition: string; status: 'alive' | 'dead';
}
export interface Me { userId: string; name: string | null; characters: StoredCharacter[]; gmOf: ({ worldId: string } & GmGrant)[] }
export interface WorldSummary { id: string; name: string; day: number; characters: number; outposts: { id: string; name: string }[] }
export interface View { world: WorldState; history: WorldEvent[]; audit: Change[]; ledger: LedgerEntry[] }
export type Combat = CombatState & { events?: CombatEvent[] };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Every call carries the signed-in player's token; the server decides what they may see and do. */
export class Api {
  constructor(private token: () => Promise<string>) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(API_URL + path, {
        method,
        headers: { authorization: `Bearer ${await this.token()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'offline', '連不上遊戲伺服器。伺服器閒置時會休眠，請等半分鐘再試一次。');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? `伺服器回應 ${res.status}`);
    return data as T;
  }

  me() { return this.call<Me>('GET', '/api/me'); }
  worlds() { return this.call<WorldSummary[]>('GET', '/api/worlds'); }
  createCharacter(draft: CharacterDraft) { return this.call<StoredCharacter>('POST', '/api/characters', { draft }); }
  join(worldId: string, characterId: string, locationId: string) {
    return this.call('POST', `/api/worlds/${worldId}/join`, { characterId, locationId });
  }
  view(worldId: string, asGm = false) { return this.call<View>('GET', `/api/worlds/${worldId}/view${asGm ? '?as=gm' : ''}`); }
  command(worldId: string, command: WorldCommand, opts: { asGm?: boolean; requestId?: string } = {}) {
    return this.call<{ replayed: boolean; events: WorldEvent[]; combatId: string | null }>('POST', `/api/worlds/${worldId}/commands`, {
      command, as: opts.asGm ? 'gm' : 'player', requestId: opts.requestId ?? crypto.randomUUID(),
    });
  }
  combats(worldId: string) { return this.call<Combat[]>('GET', `/api/worlds/${worldId}/combats`); }
  combat(worldId: string, id: string) { return this.call<Combat>('GET', `/api/worlds/${worldId}/combats/${id}`); }
  startFight(worldId: string, body: { locationId: string; characters: { id: string; weaponId: string; armorId: string }[]; monsters: { bestiaryId: string }[] }) {
    return this.call<Combat>('POST', `/api/worlds/${worldId}/combats`, body);
  }
  act(worldId: string, combat: CombatState, combatantId: string, action: CombatAction) {
    return this.call('POST', `/api/worlds/${worldId}/combats/${combat.id}/actions`, {
      actionId: crypto.randomUUID(), combatantId, round: combat.round, action,
    });
  }
}
