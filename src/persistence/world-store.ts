import type { CombatState, Submission } from '../combat/types';
import type { Rng } from '../rules/dice';
import type { RulesConfig } from '../rules/types';
import { WORLD_V03, WorldError, applyWorld, createWorld, joinWorld, type WorldResult, type WorldSeed } from '../world/engine';
import { ECONOMY_COLLECTIONS, ECONOMY_COMMANDS } from '../world/economy';
import { auditFor, historyFor, ledgerFor, viewFor } from '../world/view';
import type {
  Change, Economy, EconomyKind, LedgerEntry, WorldActor, WorldCharacter, WorldConfig, WorldEvent, WorldState, WorldSubmission,
} from '../world/types';
import { CombatStore, StoreError } from './combat-store';

/**
 * Phase 3 persistence: one shared world in the same database as characters and combats.
 * Every entity is its own row with a version; a command commits all its row updates, history and audit
 * entries in one transaction, and any row whose version moved underneath it aborts the whole command.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  day INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  gms TEXT NOT NULL,
  hostilities TEXT NOT NULL,
  duels TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS world_locations (id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id), data TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS world_npcs (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id), data TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('alive', 'dead')), version INTEGER NOT NULL
);
-- One row per unique item: moving it updates the row, so it can never exist twice.
CREATE TABLE IF NOT EXISTS world_items (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id), data TEXT NOT NULL,
  holder_type TEXT NOT NULL, holder_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS world_characters (
  id TEXT PRIMARY KEY REFERENCES characters(id), world_id TEXT NOT NULL REFERENCES worlds(id), data TEXT NOT NULL, version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS world_rulings (id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id), data TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS world_events (
  world_id TEXT NOT NULL REFERENCES worlds(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, visibility TEXT NOT NULL,
  location_id TEXT, event TEXT NOT NULL, PRIMARY KEY (world_id, seq)
);
CREATE TABLE IF NOT EXISTS world_changes (
  world_id TEXT NOT NULL REFERENCES worlds(id), seq INTEGER NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  change TEXT NOT NULL, PRIMARY KEY (world_id, seq)
);
-- Phase 4: shops, trades, commissions, contracts, locks and disputes, one versioned row each.
CREATE TABLE IF NOT EXISTS world_records (
  world_id TEXT NOT NULL REFERENCES worlds(id), kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
  status TEXT, version INTEGER NOT NULL, PRIMARY KEY (world_id, kind, id)
);
-- Every coin and economy item movement. Balances can be recomputed from it; it is never edited.
CREATE TABLE IF NOT EXISTS world_ledger (
  world_id TEXT NOT NULL REFERENCES worlds(id), seq INTEGER NOT NULL, tx TEXT NOT NULL,
  from_type TEXT NOT NULL, from_id TEXT NOT NULL, to_type TEXT NOT NULL, to_id TEXT NOT NULL,
  coins INTEGER CHECK (coins IS NULL OR coins > 0), item_id TEXT, reason TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (world_id, seq)
);
-- A request id is applied once; a retry gets the stored result back instead of paying twice.
CREATE TABLE IF NOT EXISTS world_requests (
  world_id TEXT NOT NULL REFERENCES worlds(id), request_id TEXT NOT NULL, user_id TEXT NOT NULL, command TEXT NOT NULL,
  result TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (world_id, request_id)
);
CREATE OR REPLACE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON world_ledger
FOR EACH ROW EXECUTE FUNCTION fw_forbid('the ledger is append-only');
CREATE OR REPLACE TRIGGER records_never_deleted BEFORE DELETE ON world_records
FOR EACH ROW EXECUTE FUNCTION fw_forbid('economy records are closed with a status, never deleted');
CREATE OR REPLACE TRIGGER npc_no_resurrection BEFORE UPDATE OF status ON world_npcs
FOR EACH ROW WHEN (OLD.status = 'dead' AND NEW.status <> 'dead') EXECUTE FUNCTION fw_forbid('dead npc cannot be revived');
CREATE OR REPLACE TRIGGER items_never_deleted BEFORE DELETE ON world_items
FOR EACH ROW EXECUTE FUNCTION fw_forbid('world items are never deleted; destroy them with a status change');
CREATE OR REPLACE TRIGGER history_append_only BEFORE UPDATE OR DELETE ON world_events
FOR EACH ROW EXECUTE FUNCTION fw_forbid('world history is append-only');
`;

type Row = { id: string; data: string; version: number };

export interface WorldSubmitResult extends WorldResult {
  combat?: CombatState;
  /** True when this request id was already applied: nothing ran again and the stored outcome is returned. */
  replayed?: boolean;
}

type StoredOutcome = Pick<WorldResult, 'events' | 'changes' | 'ledger'> & { combatId?: string };

export class WorldStore {
  private constructor(readonly combat: CombatStore, private rules: RulesConfig, private cfg: WorldConfig) {}

  /** Opens the world store on top of the combat store's database, creating the world tables if needed. */
  static async open(combat: CombatStore, rules: RulesConfig, cfg: WorldConfig = WORLD_V03) {
    await combat.db.migrate(SCHEMA);
    return new WorldStore(combat, rules, cfg);
  }

  private get db() {
    return this.combat.db;
  }

  async createWorld(seed: WorldSeed, gms: WorldState['gms']): Promise<WorldState> {
    const s = createWorld(seed, gms);
    await this.combat.tx(async () => {
      await this.db.run('INSERT INTO worlds (id, name, day, seq, gms, hostilities, version) VALUES ($1, $2, $3, $4, $5, $6, 1)',
        [s.id, s.name, s.day, s.seq, JSON.stringify(s.gms), '[]']);
      for (const l of Object.values(s.locations)) {
        await this.db.run('INSERT INTO world_locations VALUES ($1, $2, $3, $4)', [l.id, s.id, JSON.stringify(l), l.version]);
      }
      for (const n of Object.values(s.npcs)) {
        await this.db.run('INSERT INTO world_npcs VALUES ($1, $2, $3, $4, $5)', [n.id, s.id, JSON.stringify(n), n.status, n.version]);
      }
      for (const i of Object.values(s.items)) {
        await this.db.run('INSERT INTO world_items VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [i.id, s.id, JSON.stringify(i), i.holder.type, i.holder.id, i.status, i.version]);
      }
    });
    return s;
  }

  /** Brings a stored character into the world. Dead characters are refused. */
  async join(worldId: string, characterId: string, locationId: string) {
    await this.combat.tx(async () => {
      const c = await this.combat.getCharacter(characterId);
      if (c.status === 'dead') throw new StoreError('character-dead', `${c.name} 已永久死亡`);
      const s = joinWorld(await this.load(worldId, true), {
        id: c.id, ownerUserId: c.ownerUserId, name: c.name, attributes: c.attributes, skills: c.skills, condition: c.condition,
      }, locationId);
      const wc = s.characters[c.id];
      await this.db.run('INSERT INTO world_characters VALUES ($1, $2, $3, $4)', [wc.id, worldId, JSON.stringify(wc), wc.version]);
    });
  }

  /**
   * Full world state (server side). Life and death always come from the characters table.
   * `lock` holds the world row until the transaction ends, so commands on one world run one after another.
   */
  async load(worldId: string, lock = false): Promise<WorldState> {
    const w = await this.db.one<{ id: string; name: string; day: number; seq: number; gms: string; hostilities: string; duels: string }>(
      `SELECT * FROM worlds WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [worldId]);
    if (!w) throw new StoreError('not-found', `world ${worldId} not found`);
    const map = async <T>(table: string) => Object.fromEntries(
      (await this.db.query<Row>(`SELECT id, data, version FROM ${table} WHERE world_id = $1`, [worldId]))
        .map((r) => [r.id, { ...JSON.parse(r.data), version: r.version } as T]),
    );
    const characters = await map<WorldCharacter>('world_characters');
    const life = await this.db.query<{ id: string; status: 'alive' | 'dead'; condition: string }>(
      'SELECT c.id, c.status, c.condition FROM characters c JOIN world_characters w ON w.id = c.id WHERE w.world_id = $1', [worldId]);
    for (const l of life) {
      characters[l.id].status = l.status;
      characters[l.id].condition = l.condition as WorldCharacter['condition'];
    }
    const economy: Economy = { teams: {}, shops: {}, trades: {}, commissions: {}, contracts: {}, locks: {}, disputes: {} };
    const records = await this.db.query<Row & { kind: EconomyKind }>('SELECT kind, id, data, version FROM world_records WHERE world_id = $1', [worldId]);
    for (const r of records) (economy[ECONOMY_COLLECTIONS[r.kind]] as Record<string, unknown>)[r.id] = { ...JSON.parse(r.data), version: r.version };
    return {
      id: w.id, name: w.name, day: w.day, seq: w.seq, gms: JSON.parse(w.gms), hostilities: JSON.parse(w.hostilities), duels: JSON.parse(w.duels),
      locations: await map('world_locations'), npcs: await map('world_npcs'), items: await map('world_items'), characters,
      rulings: await map('world_rulings'), economy,
    };
  }

  async ledger(worldId: string): Promise<LedgerEntry[]> {
    const rows = await this.db.query<{
      seq: number; tx: string; from_type: string; from_id: string; to_type: string; to_id: string; coins: number | null; item_id: string | null; reason: string; at: string;
    }>('SELECT * FROM world_ledger WHERE world_id = $1 ORDER BY seq', [worldId]);
    return rows.map((r) => ({
      seq: r.seq, at: r.at, tx: r.tx, from: { type: r.from_type, id: r.from_id } as LedgerEntry['from'], to: { type: r.to_type, id: r.to_id } as LedgerEntry['to'],
      ...(r.coins !== null ? { coins: r.coins } : {}), ...(r.item_id !== null ? { itemId: r.item_id } : {}), reason: r.reason,
    }));
  }

  async worldIds(): Promise<string[]> {
    return (await this.db.query<{ id: string }>('SELECT id FROM worlds ORDER BY id')).map((r) => r.id);
  }

  /** Main-GM tool: grants or removes a GM role in a world. The grant table is the only source of GM power. */
  async setGm(worldId: string, userId: string, grant: WorldState['gms'][string] | null) {
    await this.combat.tx(async () => {
      const s = await this.load(worldId, true);
      const gms = { ...s.gms };
      if (grant) gms[userId] = grant;
      else delete gms[userId];
      await this.db.run('UPDATE worlds SET gms = $1, version = version + 1 WHERE id = $2', [JSON.stringify(gms), worldId]);
    });
  }

  /** What one viewer may see: redacted state and the history entries they are allowed to read. */
  async viewFor(worldId: string, viewer: WorldActor) {
    const s = await this.load(worldId);
    return {
      world: viewFor(s, viewer), history: historyFor(s, viewer, await this.events(worldId)), audit: auditFor(s, viewer, await this.changes(worldId)),
      ledger: ledgerFor(s, viewer, await this.ledger(worldId)),
    };
  }

  async events(worldId: string, after = 0): Promise<WorldEvent[]> {
    return (await this.db.query<{ event: string }>('SELECT event FROM world_events WHERE world_id = $1 AND seq > $2 ORDER BY seq', [worldId, after]))
      .map((r) => JSON.parse(r.event));
  }

  async changes(worldId: string): Promise<Change[]> {
    return (await this.db.query<{ change: string }>('SELECT change FROM world_changes WHERE world_id = $1 ORDER BY seq', [worldId])).map((r) => JSON.parse(r.change));
  }

  /**
   * Applies one command atomically. `snapshot` lets a caller apply a command to the state it read earlier
   * (as a slow client would); the row version checks then reject it if anything it touches has moved.
   */
  async submit(worldId: string, sub: WorldSubmission, rng: Rng, now: Date, snapshot?: WorldState): Promise<WorldSubmitResult> {
    // The system actor exists only for the scheduler hooks below; no request may claim it.
    if (sub.actor.role === 'system') throw new WorldError('forbidden', 'system actions come only from the scheduler');
    // Anything that moves value must be retry-safe: the client names the request and the store applies it once.
    if (ECONOMY_COMMANDS.has(sub.command.type) && !sub.requestId) throw new WorldError('request-id-required', '交易類操作必須附上 requestId');
    return this.run(worldId, sub, rng, now, snapshot);
  }

  private run(worldId: string, sub: WorldSubmission, rng: Rng, now: Date, snapshot?: WorldState): Promise<WorldSubmitResult> {
    return this.combat.tx(async () => {
      const current = await this.load(worldId, true);
      if (sub.requestId) {
        const done = await this.db.one<{ user_id: string; command: string; result: string }>(
          'SELECT user_id, command, result FROM world_requests WHERE world_id = $1 AND request_id = $2', [worldId, sub.requestId]);
        if (done) {
          if (done.user_id !== sub.actor.userId || done.command !== JSON.stringify(sub.command)) {
            throw new WorldError('request-reused', '這個 requestId 已經用在另一個操作上');
          }
          const out = JSON.parse(done.result) as StoredOutcome;
          return { ...out, state: current, replayed: true, combat: out.combatId ? await this.combat.loadCombat(out.combatId) : undefined };
        }
      }
      const before = snapshot ?? current;
      const res = applyWorld(before, sub, this.rules, rng, now, this.cfg);
      await this.persist(before, res);
      await this.applyDeathRulings(res, now);
      let combat: CombatState | undefined;
      if (res.pvp) combat = await this.openPvp(res, now, rng);
      if (sub.requestId) {
        const out: StoredOutcome = { events: res.events, changes: res.changes, ledger: res.ledger, combatId: combat?.id };
        await this.db.run('INSERT INTO world_requests (world_id, request_id, user_id, command, result, at) VALUES ($1, $2, $3, $4, $5, $6)',
          [worldId, sub.requestId, sub.actor.userId, JSON.stringify(sub.command), JSON.stringify(out), now.toISOString()]);
      }
      return { ...res, combat };
    });
  }

  /** A closed pvp-death ruling writes its outcome to the character: permanent death, or survival at 1 HP. */
  private async applyDeathRulings(res: WorldResult, now: Date) {
    for (const c of res.changes) {
      if (c.entity !== 'ruling') continue;
      const r = res.state.rulings[c.entityId];
      if (r.kind !== 'pvp-death' || r.status === 'open' || (c.before as { status?: string } | null)?.status !== 'open') continue;
      if (r.status === 'confirmed') await this.combat.recordDeath(r.characterId!, `pvp:${r.cause}`, r.combatId!, now.toISOString());
      else await this.combat.sparePendingDeath(r.characterId!);
    }
  }

  /** A PvP combat command. Deaths it produces are held and turned into GM rulings in the same transaction. */
  submitCombat(worldId: string, combatId: string, sub: Submission, rng: Rng, now: Date) {
    return this.combat.tx(async () => {
      await this.load(worldId, true);
      const res = await this.combat.submit(combatId, sub, rng, now);
      await this.openPendingDeathRulings(worldId, now);
      return res;
    });
  }

  runCombatTimeouts(worldId: string, rng: Rng, now: Date) {
    return this.combat.tx(async () => {
      await this.load(worldId, true);
      const ids = await this.combat.runTimeouts(rng, now);
      await this.openPendingDeathRulings(worldId, now);
      return ids;
    });
  }

  private async openPendingDeathRulings(worldId: string, now: Date) {
    const s = await this.load(worldId);
    for (const c of Object.values(s.characters)) {
      if (c.condition !== 'deathPending') continue;
      if (Object.values(s.rulings).some((r) => r.kind === 'pvp-death' && r.characterId === c.id && r.status === 'open')) continue;
      const ev = await this.db.one<{ combat_id: string; event: string }>(
        "SELECT combat_id, event FROM combat_events WHERE kind = 'deathPending' AND (event::jsonb -> 'data' ->> 'characterId') = $1 ORDER BY created DESC LIMIT 1", [c.id]);
      if (!ev) continue;
      const combat = await this.combat.loadCombat(ev.combat_id);
      const attacker = Object.values(combat.combatants).find((x) => x.characterId && x.characterId !== c.id)?.characterId ?? 'unknown';
      await this.run(worldId, {
        actor: { userId: 'system', role: 'system' },
        command: { type: 'openDeathRuling', characterId: c.id, attackerId: attacker, combatId: ev.combat_id, cause: String(JSON.parse(ev.event).data.cause) },
      }, () => 1, now);
    }
  }

  private async persist(before: WorldState, res: WorldResult) {
    const s = res.state;
    const w = await this.db.run('UPDATE worlds SET day = $1, seq = $2, hostilities = $3, duels = $4, version = version + 1 WHERE id = $5 AND seq = $6',
      [s.day, s.seq, JSON.stringify(s.hostilities), JSON.stringify(s.duels), s.id, before.seq]);
    if (w !== 1) throw new WorldError('conflict', '世界狀態已被其他操作更新，請重新讀取');
    const write = async (table: string, id: string, oldVersion: number | undefined, data: { version: number }, extra: Record<string, string> = {}) => {
      const cols = Object.keys(extra);
      if (oldVersion === undefined) {
        await this.db.run(`INSERT INTO ${table} (id, world_id, data, version${cols.map((c) => `, ${c}`).join('')}) VALUES ($1, $2, $3, $4${cols.map((_, i) => `, $${i + 5}`).join('')})`,
          [id, s.id, JSON.stringify(data), data.version, ...Object.values(extra)]);
        return;
      }
      const sets = cols.map((c, i) => `, ${c} = $${i + 3}`).join('');
      const n = cols.length + 3;
      const r = await this.db.run(`UPDATE ${table} SET data = $1, version = $2${sets} WHERE id = $${n} AND version = $${n + 1}`,
        [JSON.stringify(data), data.version, ...Object.values(extra), id, oldVersion]);
      if (r !== 1) throw new WorldError('conflict', `${id} 已被其他操作更新，請重新讀取`);
    };
    const touched = new Set(res.changes.map((c) => `${c.entity}:${c.entityId}`));
    for (const key of touched) {
      const [entity, id] = key.split(':');
      if (entity === 'location') await write('world_locations', id, before.locations[id]?.version, s.locations[id]);
      if (entity === 'npc') await write('world_npcs', id, before.npcs[id]?.version, s.npcs[id], { status: s.npcs[id].status });
      if (entity === 'character') await write('world_characters', id, before.characters[id]?.version, s.characters[id]);
      if (entity === 'ruling') await write('world_rulings', id, before.rulings[id]?.version, s.rulings[id], { status: s.rulings[id].status });
      if (entity === 'item') {
        const i = s.items[id];
        await write('world_items', id, before.items[id]?.version, i, { holder_type: i.holder.type, holder_id: i.holder.id, status: i.status });
      }
      if (entity in ECONOMY_COLLECTIONS) {
        const col = ECONOMY_COLLECTIONS[entity as EconomyKind];
        const rec = (s.economy[col] as Record<string, { version: number; status?: string }>)[id];
        const old = (before.economy[col] as Record<string, { version: number }>)[id]?.version;
        if (old === undefined) {
          await this.db.run('INSERT INTO world_records (world_id, kind, id, data, status, version) VALUES ($1, $2, $3, $4, $5, $6)',
            [s.id, entity, id, JSON.stringify(rec), rec.status ?? null, rec.version]);
        } else {
          const r = await this.db.run('UPDATE world_records SET data = $1, status = $2, version = $3 WHERE world_id = $4 AND kind = $5 AND id = $6 AND version = $7',
            [JSON.stringify(rec), rec.status ?? null, rec.version, s.id, entity, id, old]);
          if (r !== 1) throw new WorldError('conflict', `${id} 已被其他操作更新，請重新讀取`);
        }
      }
    }
    for (const e of res.ledger) {
      await this.db.run(`INSERT INTO world_ledger (world_id, seq, tx, from_type, from_id, to_type, to_id, coins, item_id, reason, at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [s.id, e.seq, e.tx, e.from.type, e.from.id, e.to.type, e.to.id, e.coins ?? null, e.itemId ?? null, e.reason, e.at]);
    }
    for (const e of res.events) {
      await this.db.run('INSERT INTO world_events (world_id, seq, kind, visibility, location_id, event) VALUES ($1, $2, $3, $4, $5, $6)',
        [s.id, e.seq, e.kind, e.visibility, e.locationId ?? null, JSON.stringify(e)]);
    }
    for (const c of res.changes) {
      await this.db.run('INSERT INTO world_changes (world_id, seq, entity, entity_id, change) VALUES ($1, $2, $3, $4, $5)',
        [s.id, c.seq, c.entity, c.entityId, JSON.stringify(c)]);
    }
  }

  /** A legal attack opens a real combat; a non-lethal target is death-protected (stabilizes instead of dying). */
  private async openPvp(res: WorldResult, now: Date, rng: Rng): Promise<CombatState> {
    const { attackerId, targetId, legality } = res.pvp!;
    const id = `pvp-${res.state.id}-${res.state.seq}`;
    return this.combat.createCombat(id, [
      // Every PvP death waits for a GM ruling; a non-lethal target cannot reach death at all.
      await this.combat.combatantFor(attackerId, { id: attackerId, side: `pvp-${attackerId}`, band: 1, weaponId: 'fists', armorId: 'none', deathNeedsRuling: true }),
      await this.combat.combatantFor(targetId, {
        id: targetId, side: `pvp-${targetId}`, band: 1, weaponId: 'fists', armorId: 'none', deathProtected: !legality.lethal, deathNeedsRuling: true,
      }),
    ], rng, now, { resolveDying: true });
  }

  /** Scheduler hooks: daily tick (1 game day = 1 real day) and afterimage expiry. */
  runDaily(worldId: string, rng: Rng, now: Date) {
    return this.run(worldId, { actor: { userId: 'scheduler', role: 'system' }, command: { type: 'advanceDay' } }, rng, now);
  }

  runAfterimages(worldId: string, rng: Rng, now: Date) {
    return this.run(worldId, { actor: { userId: 'scheduler', role: 'system' }, command: { type: 'expireAfterimages' } }, rng, now);
  }

  /** Scheduler hook: expired commissions refund, unsigned contracts lapse, overdue active contracts are breached. */
  runDeadlines(worldId: string, rng: Rng, now: Date) {
    return this.run(worldId, { actor: { userId: 'scheduler', role: 'system' }, command: { type: 'settleDeadlines' } }, rng, now);
  }
}
