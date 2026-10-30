import { CombatError, applyTimeout, startCombat, submitAction, type SubmitResult } from '../combat/engine';
import type { Actor, CombatEvent, CombatState, CombatantSetup, Submission } from '../combat/types';
import type { Character } from '../character/create';
import type { Rng } from '../rules/dice';
import type { RulesConfig } from '../rules/types';
import type { Database } from './db';

/**
 * Prototype persistence for Phase 2: characters, combats, combat events and death records.
 * Every write that matters runs in one PostgreSQL transaction with a version check.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  hp INTEGER NOT NULL,
  condition TEXT NOT NULL DEFAULT 'healthy',
  status TEXT NOT NULL DEFAULT 'alive' CHECK (status IN ('alive', 'dead')),
  version INTEGER NOT NULL DEFAULT 1,
  created INTEGER GENERATED ALWAYS AS IDENTITY
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
  created INTEGER GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (combat_id, seq)
);
-- Raises the message given to the trigger: used to make rows append-only or irreversible.
CREATE OR REPLACE FUNCTION fw_forbid() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION '%', TG_ARGV[0]; END $$;
-- A dead character can never be set back to alive, whatever code path tries it.
CREATE OR REPLACE TRIGGER no_resurrection
BEFORE UPDATE OF status ON characters FOR EACH ROW
WHEN (OLD.status = 'dead' AND NEW.status <> 'dead')
EXECUTE FUNCTION fw_forbid('permanent death: character cannot be revived');
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
  private constructor(readonly db: Database, private rules: RulesConfig) {}

  static async open(db: Database, rules: RulesConfig) {
    await db.migrate(SCHEMA);
    return new CombatStore(db, rules);
  }

  close() {
    return this.db.close();
  }

  /** Runs fn in one transaction; nested calls (e.g. a world command opening a combat) join the outer one. */
  tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.tx(fn);
  }

  // ---------- characters ----------

  async saveNewCharacter(ownerUserId: string, c: Character) {
    await this.db.run('INSERT INTO characters (id, owner_user_id, data, hp) VALUES ($1, $2, $3, $4)', [c.id, ownerUserId, JSON.stringify(c), c.hp]);
  }

  async getCharacter(id: string): Promise<StoredCharacter> {
    const row = await this.db.one<CharacterRow>('SELECT * FROM characters WHERE id = $1', [id]);
    if (!row) throw new StoreError('not-found', `character ${id} not found`);
    return {
      ...(JSON.parse(row.data) as Character), hp: row.hp, ownerUserId: row.owner_user_id,
      condition: row.condition, status: row.status as 'alive' | 'dead', version: row.version,
    };
  }

  async charactersOf(ownerUserId: string): Promise<StoredCharacter[]> {
    const ids = await this.db.query<{ id: string }>('SELECT id FROM characters WHERE owner_user_id = $1 ORDER BY created', [ownerUserId]);
    return Promise.all(ids.map((r) => this.getCharacter(r.id)));
  }

  /** The only general-purpose character edit. Dead characters and other players' characters are refused. */
  async renameCharacter(actor: Actor, id: string, name: string) {
    const c = await this.getCharacter(id);
    if (c.ownerUserId !== actor.userId) throw new StoreError('forbidden', '不能修改別人的角色');
    if (c.status === 'dead') throw new StoreError('character-dead', '角色已永久死亡');
    const row = (await this.db.one<{ data: string }>('SELECT data FROM characters WHERE id = $1', [id]))!;
    const data = { ...(JSON.parse(row.data) as Character), name };
    await this.db.run('UPDATE characters SET data = $1, version = version + 1 WHERE id = $2', [JSON.stringify(data), id]);
  }

  deathRecord(characterId: string) {
    return this.db.one<{ character_id: string; combat_id: string; cause: string; at: string; event_seq: number }>(
      'SELECT * FROM death_records WHERE character_id = $1', [characterId]);
  }

  /** Builds a combatant from a stored character. Dead characters cannot enter combat. */
  async combatantFor(characterId: string, o: Pick<CombatantSetup, 'id' | 'side' | 'band' | 'weaponId' | 'armorId'> & Partial<CombatantSetup>): Promise<CombatantSetup> {
    const c = await this.getCharacter(characterId);
    if (c.status === 'dead') throw new StoreError('character-dead', `${c.name} 已永久死亡，不能參與戰鬥`);
    return {
      name: c.name, controller: c.ownerUserId, characterId: c.id,
      attributes: c.attributes, skills: c.skills, maxHp: c.maxHp, hp: c.hp, ...o,
    };
  }

  // ---------- combats ----------

  createCombat(id: string, combatants: CombatantSetup[], rng: Rng, now: Date, opts: { resolveDying?: boolean } = {}): Promise<CombatState> {
    return this.tx(async () => {
      for (const c of combatants) {
        if (c.characterId && (await this.getCharacter(c.characterId)).status === 'dead') {
          throw new StoreError('character-dead', `${c.name} 已永久死亡，不能參與戰鬥`);
        }
      }
      const state = startCombat({ id, combatants, rules: this.rules, rng, now, ...opts });
      await this.db.run('INSERT INTO combats (id, status, state, deadline, version) VALUES ($1, $2, $3, $4, 1)',
        [id, state.status, JSON.stringify(state), state.turn?.deadline ?? null]);
      await this.persistEvents(state, state.events);
      await this.syncCharacters(state, state.events);
      return state;
    });
  }

  /** `lock` holds the row until the transaction ends, so two submissions to one combat queue instead of racing. */
  async loadCombat(id: string, lock = false): Promise<CombatState & { version: number }> {
    const row = await this.db.one<CombatRow>(`SELECT * FROM combats WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!row) throw new StoreError('not-found', `combat ${id} not found`);
    return { ...(JSON.parse(row.state) as CombatState), version: row.version };
  }

  /** Ids of combats still running, optionally only those whose id starts with one of the prefixes. */
  async activeCombatIds(prefixes: string[] = ['']): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>("SELECT id FROM combats WHERE status = 'active' ORDER BY id");
    return rows.map((r) => r.id).filter((id) => prefixes.some((p) => id.startsWith(p)));
  }

  async events(combatId: string): Promise<CombatEvent[]> {
    return (await this.db.query<{ event: string }>('SELECT event FROM combat_events WHERE combat_id = $1 ORDER BY seq', [combatId]))
      .map((r) => JSON.parse(r.event));
  }

  /** Applies a submission atomically: state, event log, character HP and any deaths commit together or not at all. */
  submit(combatId: string, sub: Submission, rng: Rng, now: Date): Promise<SubmitResult> {
    return this.tx(() => this.apply(combatId, (s) => submitAction(s, sub, this.rules, rng, now)));
  }

  /** Scheduler entry point: resolves every active combat whose turn deadline has passed. */
  async runTimeouts(rng: Rng, now: Date): Promise<string[]> {
    const due = await this.db.query<{ id: string }>("SELECT id FROM combats WHERE status = 'active' AND deadline <= $1 ORDER BY id", [now.toISOString()]);
    const out: string[] = [];
    for (const { id } of due) {
      const res = await this.tx(() => this.apply(id, (s) => applyTimeout(s, this.rules, rng, now)));
      if (res.events.length > 0) out.push(id);
    }
    return out;
  }

  private async apply(combatId: string, step: (s: CombatState) => SubmitResult): Promise<SubmitResult> {
    const { version, ...state } = await this.loadCombat(combatId, true);
    const res = step(state);
    if (res.duplicate || res.events.length === 0) return res;
    const changed = await this.db.run('UPDATE combats SET status = $1, state = $2, deadline = $3, version = version + 1 WHERE id = $4 AND version = $5',
      [res.state.status, JSON.stringify(res.state), res.state.turn?.deadline ?? null, combatId, version]);
    if (changed !== 1) throw new CombatError('conflict', '戰鬥狀態已被其他操作更新，請重新讀取');
    await this.persistEvents(res.state, res.events);
    await this.syncCharacters(res.state, res.events);
    return res;
  }

  private async persistEvents(state: CombatState, events: CombatEvent[]) {
    for (const e of events) {
      await this.db.run('INSERT INTO combat_events (combat_id, seq, kind, event) VALUES ($1, $2, $3, $4)', [state.id, e.seq, e.kind, JSON.stringify(e)]);
    }
  }

  /** Mirrors combatant HP/condition onto characters and writes permanent death records. */
  private async syncCharacters(state: CombatState, events: CombatEvent[]) {
    for (const c of Object.values(state.combatants)) {
      if (!c.characterId) continue;
      await this.db.run("UPDATE characters SET hp = $1, condition = $2, version = version + 1 WHERE id = $3 AND status = 'alive'",
        [c.hp, c.pendingDeath ? 'deathPending' : c.condition, c.characterId]);
    }
    for (const e of events.filter((ev) => ev.kind === 'death' && ev.data.characterId)) {
      await this.recordDeath(e.data.characterId as string, String(e.data.cause), state.id, e.at, e.seq);
    }
  }

  /** Writes a permanent death: the character row and its death record commit together. */
  recordDeath(characterId: string, cause: string, combatId: string | null, at: string, eventSeq: number | null = null) {
    return this.tx(async () => {
      await this.db.run("UPDATE characters SET status = 'dead', condition = 'dead', hp = 0, version = version + 1 WHERE id = $1", [characterId]);
      await this.db.run('INSERT INTO death_records (character_id, combat_id, cause, at, event_seq) VALUES ($1, $2, $3, $4, $5)',
        [characterId, combatId, cause, at, eventSeq]);
    });
  }

  /** A GM overturned a pending PvP death: the character survives, unconscious at 1 HP. */
  async sparePendingDeath(characterId: string) {
    const changed = await this.db.run("UPDATE characters SET condition = 'stable', hp = 1, version = version + 1 WHERE id = $1 AND condition = 'deathPending'", [characterId]);
    if (changed !== 1) throw new StoreError('not-pending', '這個角色沒有待確認的死亡');
  }
}
