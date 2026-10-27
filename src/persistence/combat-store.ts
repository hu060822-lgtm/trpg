import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { CombatError, applyTimeout, startCombat, submitAction, type SubmitResult } from '../combat/engine';
import type { Actor, CombatEvent, CombatState, CombatantSetup, Submission } from '../combat/types';
import type { Character } from '../character/create';
import type { Rng } from '../rules/dice';
import type { RulesConfig } from '../rules/types';

/**
 * Prototype persistence for Phase 2: characters, combats, combat events and death records.
 * SQLite stands in for PostgreSQL; every write that matters runs in one transaction with a version check.
 */
// Loaded through require because the test bundler does not yet recognise the node:sqlite builtin.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  hp INTEGER NOT NULL,
  condition TEXT NOT NULL DEFAULT 'healthy',
  status TEXT NOT NULL DEFAULT 'alive' CHECK (status IN ('alive', 'dead')),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS death_records (
  character_id TEXT PRIMARY KEY REFERENCES characters(id),
  combat_id TEXT,
  cause TEXT NOT NULL,
  at TEXT NOT NULL,
  event_seq INTEGER
);
CREATE TABLE IF NOT EXISTS combats (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  state TEXT NOT NULL,
  deadline TEXT,
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS combat_events (
  combat_id TEXT NOT NULL REFERENCES combats(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (combat_id, seq)
);
-- A dead character can never be set back to alive, whatever code path tries it.
CREATE TRIGGER IF NOT EXISTS no_resurrection
BEFORE UPDATE OF status ON characters
WHEN OLD.status = 'dead' AND NEW.status <> 'dead'
BEGIN
  SELECT RAISE(ABORT, 'permanent death: character cannot be revived');
END;
`;

export class StoreError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

interface CharacterRow { id: string; owner_user_id: string; data: string; hp: number; condition: string; status: string; version: number }
interface CombatRow { id: string; status: string; state: string; version: number }

export interface StoredCharacter extends Character {
  ownerUserId: string;
  condition: string;
  status: 'alive' | 'dead';
  version: number;
}

export class CombatStore {
  readonly db: DatabaseSyncType;

  constructor(path: string, private rules: RulesConfig) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- characters ----------

  saveNewCharacter(ownerUserId: string, c: Character) {
    this.db.prepare('INSERT INTO characters (id, owner_user_id, data, hp) VALUES (?, ?, ?, ?)')
      .run(c.id, ownerUserId, JSON.stringify(c), c.hp);
  }

  getCharacter(id: string): StoredCharacter {
    const row = this.db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as CharacterRow | undefined;
    if (!row) throw new StoreError('not-found', `character ${id} not found`);
    return {
      ...(JSON.parse(row.data) as Character), hp: row.hp, ownerUserId: row.owner_user_id,
      condition: row.condition, status: row.status as 'alive' | 'dead', version: row.version,
    };
  }

  /** The only general-purpose character edit. Dead characters and other players' characters are refused. */
  renameCharacter(actor: Actor, id: string, name: string) {
    const c = this.getCharacter(id);
    if (c.ownerUserId !== actor.userId) throw new StoreError('forbidden', '不能修改別人的角色');
    if (c.status === 'dead') throw new StoreError('character-dead', '角色已永久死亡');
    const row = this.db.prepare('SELECT data FROM characters WHERE id = ?').get(id) as { data: string };
    const data = { ...(JSON.parse(row.data) as Character), name };
    this.db.prepare('UPDATE characters SET data = ?, version = version + 1 WHERE id = ?').run(JSON.stringify(data), id);
  }

  deathRecord(characterId: string) {
    return this.db.prepare('SELECT * FROM death_records WHERE character_id = ?').get(characterId) as
      { character_id: string; combat_id: string; cause: string; at: string; event_seq: number } | undefined;
  }

  /** Builds a combatant from a stored character. Dead characters cannot enter combat. */
  combatantFor(characterId: string, o: Pick<CombatantSetup, 'id' | 'side' | 'band' | 'weaponId' | 'armorId'> & Partial<CombatantSetup>): CombatantSetup {
    const c = this.getCharacter(characterId);
    if (c.status === 'dead') throw new StoreError('character-dead', `${c.name} 已永久死亡，不能參與戰鬥`);
    return {
      name: c.name, controller: c.ownerUserId, characterId: c.id,
      attributes: c.attributes, skills: c.skills, maxHp: c.maxHp, hp: c.hp, ...o,
    };
  }

  // ---------- combats ----------

  createCombat(id: string, combatants: CombatantSetup[], rng: Rng, now: Date): CombatState {
    return this.tx(() => {
      for (const c of combatants) {
        if (c.characterId && this.getCharacter(c.characterId).status === 'dead') {
          throw new StoreError('character-dead', `${c.name} 已永久死亡，不能參與戰鬥`);
        }
      }
      const state = startCombat({ id, combatants, rules: this.rules, rng, now });
      this.db.prepare('INSERT INTO combats (id, status, state, deadline, version) VALUES (?, ?, ?, ?, 1)')
        .run(id, state.status, JSON.stringify(state), state.turn?.deadline ?? null);
      this.persistEvents(state, state.events);
      this.syncCharacters(state, state.events);
      return state;
    });
  }

  loadCombat(id: string): CombatState & { version: number } {
    const row = this.db.prepare('SELECT * FROM combats WHERE id = ?').get(id) as CombatRow | undefined;
    if (!row) throw new StoreError('not-found', `combat ${id} not found`);
    return { ...(JSON.parse(row.state) as CombatState), version: row.version };
  }

  events(combatId: string): CombatEvent[] {
    return (this.db.prepare('SELECT event FROM combat_events WHERE combat_id = ? ORDER BY seq').all(combatId) as { event: string }[])
      .map((r) => JSON.parse(r.event));
  }

  /** Applies a submission atomically: state, event log, character HP and any deaths commit together or not at all. */
  submit(combatId: string, sub: Submission, rng: Rng, now: Date): SubmitResult {
    return this.tx(() => this.apply(combatId, (s) => submitAction(s, sub, this.rules, rng, now)));
  }

  /** Scheduler entry point: resolves every active combat whose turn deadline has passed. */
  runTimeouts(rng: Rng, now: Date): string[] {
    const due = this.db.prepare("SELECT id FROM combats WHERE status = 'active' AND deadline <= ?").all(now.toISOString()) as { id: string }[];
    return due.filter(({ id }) => this.tx(() => this.apply(id, (s) => applyTimeout(s, this.rules, rng, now))).events.length > 0)
      .map((d) => d.id);
  }

  private apply(combatId: string, step: (s: CombatState) => SubmitResult): SubmitResult {
    const { version, ...state } = this.loadCombat(combatId);
    const res = step(state);
    if (res.duplicate || res.events.length === 0) return res;
    const upd = this.db.prepare('UPDATE combats SET status = ?, state = ?, deadline = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run(res.state.status, JSON.stringify(res.state), res.state.turn?.deadline ?? null, combatId, version);
    if (upd.changes !== 1) throw new CombatError('conflict', '戰鬥狀態已被其他操作更新，請重新讀取');
    this.persistEvents(res.state, res.events);
    this.syncCharacters(res.state, res.events);
    return res;
  }

  private persistEvents(state: CombatState, events: CombatEvent[]) {
    const ins = this.db.prepare('INSERT INTO combat_events (combat_id, seq, kind, event) VALUES (?, ?, ?, ?)');
    for (const e of events) ins.run(state.id, e.seq, e.kind, JSON.stringify(e));
  }

  /** Mirrors combatant HP/condition onto characters and writes permanent death records. */
  private syncCharacters(state: CombatState, events: CombatEvent[]) {
    const upd = this.db.prepare("UPDATE characters SET hp = ?, condition = ?, version = version + 1 WHERE id = ? AND status = 'alive'");
    for (const c of Object.values(state.combatants)) {
      if (c.characterId) upd.run(c.hp, c.condition, c.characterId);
    }
    for (const e of events.filter((ev) => ev.kind === 'death' && ev.data.characterId)) {
      const characterId = e.data.characterId as string;
      this.db.prepare("UPDATE characters SET status = 'dead', condition = 'dead', hp = 0, version = version + 1 WHERE id = ?").run(characterId);
      this.db.prepare('INSERT INTO death_records (character_id, combat_id, cause, at, event_seq) VALUES (?, ?, ?, ?, ?)')
        .run(characterId, state.id, String(e.data.cause), e.at, e.seq);
    }
  }
}
