import type { CombatState, Submission } from '../combat/types';
import type { Rng } from '../rules/dice';
import type { RulesConfig } from '../rules/types';
import { WORLD_V03, WorldError, applyWorld, createWorld, joinWorld, type WorldResult, type WorldSeed } from '../world/engine';
import { auditFor, historyFor, viewFor } from '../world/view';
import type { Change, WorldActor, WorldCharacter, WorldConfig, WorldEvent, WorldState, WorldSubmission } from '../world/types';
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
CREATE TRIGGER IF NOT EXISTS npc_no_resurrection
BEFORE UPDATE OF status ON world_npcs WHEN OLD.status = 'dead' AND NEW.status <> 'dead'
BEGIN SELECT RAISE(ABORT, 'dead npc cannot be revived'); END;
CREATE TRIGGER IF NOT EXISTS items_never_deleted
BEFORE DELETE ON world_items
BEGIN SELECT RAISE(ABORT, 'world items are never deleted; destroy them with a status change'); END;
CREATE TRIGGER IF NOT EXISTS history_append_only
BEFORE UPDATE ON world_events
BEGIN SELECT RAISE(ABORT, 'world history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS history_no_delete
BEFORE DELETE ON world_events
BEGIN SELECT RAISE(ABORT, 'world history is append-only'); END;
`;

type Row = { id: string; data: string; version: number };

export interface WorldSubmitResult extends WorldResult {
  combat?: CombatState;
}

export class WorldStore {
  constructor(readonly combat: CombatStore, private rules: RulesConfig, private cfg: WorldConfig = WORLD_V03) {
    combat.db.exec(SCHEMA);
  }

  private get db() {
    return this.combat.db;
  }

  createWorld(seed: WorldSeed, gms: WorldState['gms']): WorldState {
    const s = createWorld(seed, gms);
    this.combat.tx(() => {
      this.db.prepare('INSERT INTO worlds (id, name, day, seq, gms, hostilities, version) VALUES (?, ?, ?, ?, ?, ?, 1)')
        .run(s.id, s.name, s.day, s.seq, JSON.stringify(s.gms), '[]');
      for (const l of Object.values(s.locations)) this.db.prepare('INSERT INTO world_locations VALUES (?, ?, ?, ?)').run(l.id, s.id, JSON.stringify(l), l.version);
      for (const n of Object.values(s.npcs)) this.db.prepare('INSERT INTO world_npcs VALUES (?, ?, ?, ?, ?)').run(n.id, s.id, JSON.stringify(n), n.status, n.version);
      for (const i of Object.values(s.items)) {
        this.db.prepare('INSERT INTO world_items VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(i.id, s.id, JSON.stringify(i), i.holder.type, i.holder.id, i.status, i.version);
      }
    });
    return s;
  }

  /** Brings a stored character into the world. Dead characters are refused. */
  join(worldId: string, characterId: string, locationId: string) {
    this.combat.tx(() => {
      const c = this.combat.getCharacter(characterId);
      if (c.status === 'dead') throw new StoreError('character-dead', `${c.name} 已永久死亡`);
      const s = joinWorld(this.load(worldId), {
        id: c.id, ownerUserId: c.ownerUserId, name: c.name, attributes: c.attributes, skills: c.skills, condition: c.condition,
      }, locationId);
      const wc = s.characters[c.id];
      this.db.prepare('INSERT INTO world_characters VALUES (?, ?, ?, ?)').run(wc.id, worldId, JSON.stringify(wc), wc.version);
    });
  }

  /** Full world state (server side). Life and death always come from the characters table. */
  load(worldId: string): WorldState {
    const w = this.db.prepare('SELECT * FROM worlds WHERE id = ?').get(worldId) as
      { id: string; name: string; day: number; seq: number; gms: string; hostilities: string; duels: string } | undefined;
    if (!w) throw new StoreError('not-found', `world ${worldId} not found`);
    const rows = (table: string) => this.db.prepare(`SELECT id, data, version FROM ${table} WHERE world_id = ?`).all(worldId) as Row[];
    const map = <T>(table: string) => Object.fromEntries(rows(table).map((r) => [r.id, { ...JSON.parse(r.data), version: r.version } as T]));
    const characters = map<WorldCharacter>('world_characters');
    for (const c of Object.values(characters)) {
      const stored = this.combat.getCharacter(c.id);
      c.status = stored.status;
      c.condition = stored.condition;
    }
    return {
      id: w.id, name: w.name, day: w.day, seq: w.seq, gms: JSON.parse(w.gms), hostilities: JSON.parse(w.hostilities), duels: JSON.parse(w.duels),
      locations: map('world_locations'), npcs: map('world_npcs'), items: map('world_items'), characters, rulings: map('world_rulings'),
    };
  }

  /** What one viewer may see: redacted state and the history entries they are allowed to read. */
  viewFor(worldId: string, viewer: WorldActor) {
    const s = this.load(worldId);
    return { world: viewFor(s, viewer), history: historyFor(s, viewer, this.events(worldId)), audit: auditFor(s, viewer, this.changes(worldId)) };
  }

  events(worldId: string): WorldEvent[] {
    return (this.db.prepare('SELECT event FROM world_events WHERE world_id = ? ORDER BY seq').all(worldId) as { event: string }[]).map((r) => JSON.parse(r.event));
  }

  changes(worldId: string): Change[] {
    return (this.db.prepare('SELECT change FROM world_changes WHERE world_id = ? ORDER BY seq').all(worldId) as { change: string }[]).map((r) => JSON.parse(r.change));
  }

  /**
   * Applies one command atomically. `snapshot` lets a caller apply a command to the state it read earlier
   * (as a slow client would); the row version checks then reject it if anything it touches has moved.
   */
  submit(worldId: string, sub: WorldSubmission, rng: Rng, now: Date, snapshot?: WorldState): WorldSubmitResult {
    // The system actor exists only for the scheduler hooks below; no request may claim it.
    if (sub.actor.role === 'system') throw new WorldError('forbidden', 'system actions come only from the scheduler');
    return this.run(worldId, sub, rng, now, snapshot);
  }

  private run(worldId: string, sub: WorldSubmission, rng: Rng, now: Date, snapshot?: WorldState): WorldSubmitResult {
    return this.combat.tx(() => {
      const before = snapshot ?? this.load(worldId);
      const res = applyWorld(before, sub, this.rules, rng, now, this.cfg);
      this.persist(before, res);
      this.applyDeathRulings(res, now);
      let combat: CombatState | undefined;
      if (res.pvp) combat = this.openPvp(res, now, rng);
      return { ...res, combat };
    });
  }

  /** A closed pvp-death ruling writes its outcome to the character: permanent death, or survival at 1 HP. */
  private applyDeathRulings(res: WorldResult, now: Date) {
    for (const c of res.changes) {
      if (c.entity !== 'ruling') continue;
      const r = res.state.rulings[c.entityId];
      if (r.kind !== 'pvp-death' || r.status === 'open' || (c.before as { status?: string } | null)?.status !== 'open') continue;
      if (r.status === 'confirmed') this.combat.recordDeath(r.characterId!, `pvp:${r.cause}`, r.combatId!, now.toISOString());
      else this.combat.sparePendingDeath(r.characterId!);
    }
  }

  /** A PvP combat command. Deaths it produces are held and turned into GM rulings in the same transaction. */
  submitCombat(worldId: string, combatId: string, sub: Submission, rng: Rng, now: Date) {
    return this.combat.tx(() => {
      const res = this.combat.submit(combatId, sub, rng, now);
      this.openPendingDeathRulings(worldId, now);
      return res;
    });
  }

  runCombatTimeouts(worldId: string, rng: Rng, now: Date) {
    return this.combat.tx(() => {
      const ids = this.combat.runTimeouts(rng, now);
      this.openPendingDeathRulings(worldId, now);
      return ids;
    });
  }

  private openPendingDeathRulings(worldId: string, now: Date) {
    const s = this.load(worldId);
    for (const c of Object.values(s.characters)) {
      if (c.condition !== 'deathPending') continue;
      if (Object.values(s.rulings).some((r) => r.kind === 'pvp-death' && r.characterId === c.id && r.status === 'open')) continue;
      const ev = this.db.prepare("SELECT combat_id, event FROM combat_events WHERE kind = 'deathPending' AND json_extract(event, '$.data.characterId') = ? ORDER BY rowid DESC LIMIT 1")
        .get(c.id) as { combat_id: string; event: string } | undefined;
      if (!ev) continue;
      const combat = this.combat.loadCombat(ev.combat_id);
      const attacker = Object.values(combat.combatants).find((x) => x.characterId && x.characterId !== c.id)?.characterId ?? 'unknown';
      this.run(worldId, {
        actor: { userId: 'system', role: 'system' },
        command: { type: 'openDeathRuling', characterId: c.id, attackerId: attacker, combatId: ev.combat_id, cause: String(JSON.parse(ev.event).data.cause) },
      }, () => 1, now);
    }
  }

  private persist(before: WorldState, res: WorldResult) {
    const s = res.state;
    const w = this.db.prepare('UPDATE worlds SET day = ?, seq = ?, hostilities = ?, duels = ?, version = version + 1 WHERE id = ? AND seq = ?')
      .run(s.day, s.seq, JSON.stringify(s.hostilities), JSON.stringify(s.duels), s.id, before.seq);
    if (w.changes !== 1) throw new WorldError('conflict', '世界狀態已被其他操作更新，請重新讀取');
    const write = (table: string, id: string, oldVersion: number | undefined, data: { version: number }, extra: Record<string, string> = {}) => {
      if (oldVersion === undefined) {
        const cols = Object.keys(extra);
        this.db.prepare(`INSERT INTO ${table} (id, world_id, data, version${cols.map((c) => `, ${c}`).join('')}) VALUES (?, ?, ?, ?${cols.map(() => ', ?').join('')})`)
          .run(id, s.id, JSON.stringify(data), data.version, ...Object.values(extra));
        return;
      }
      const sets = Object.keys(extra).map((c) => `, ${c} = ?`).join('');
      const r = this.db.prepare(`UPDATE ${table} SET data = ?, version = ?${sets} WHERE id = ? AND version = ?`)
        .run(JSON.stringify(data), data.version, ...Object.values(extra), id, oldVersion);
      if (r.changes !== 1) throw new WorldError('conflict', `${id} 已被其他操作更新，請重新讀取`);
    };
    const touched = new Set(res.changes.map((c) => `${c.entity}:${c.entityId}`));
    for (const key of touched) {
      const [entity, id] = key.split(':');
      if (entity === 'location') write('world_locations', id, before.locations[id]?.version, s.locations[id]);
      if (entity === 'npc') write('world_npcs', id, before.npcs[id]?.version, s.npcs[id], { status: s.npcs[id].status });
      if (entity === 'character') write('world_characters', id, before.characters[id]?.version, s.characters[id]);
      if (entity === 'ruling') write('world_rulings', id, before.rulings[id]?.version, s.rulings[id], { status: s.rulings[id].status });
      if (entity === 'item') {
        const i = s.items[id];
        write('world_items', id, before.items[id]?.version, i, { holder_type: i.holder.type, holder_id: i.holder.id, status: i.status });
      }
    }
    const ev = this.db.prepare('INSERT INTO world_events (world_id, seq, kind, visibility, location_id, event) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of res.events) ev.run(s.id, e.seq, e.kind, e.visibility, e.locationId ?? null, JSON.stringify(e));
    const ch = this.db.prepare('INSERT INTO world_changes (world_id, seq, entity, entity_id, change) VALUES (?, ?, ?, ?, ?)');
    for (const c of res.changes) ch.run(s.id, c.seq, c.entity, c.entityId, JSON.stringify(c));
  }

  /** A legal attack opens a real combat; a non-lethal target is death-protected (stabilizes instead of dying). */
  private openPvp(res: WorldResult, now: Date, rng: Rng): CombatState {
    const { attackerId, targetId, legality } = res.pvp!;
    const id = `pvp-${res.state.id}-${res.state.seq}`;
    return this.combat.createCombat(id, [
      // Every PvP death waits for a GM ruling; a non-lethal target cannot reach death at all.
      this.combat.combatantFor(attackerId, { id: attackerId, side: `pvp-${attackerId}`, band: 1, weaponId: 'fists', armorId: 'none', deathNeedsRuling: true }),
      this.combat.combatantFor(targetId, {
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
}
