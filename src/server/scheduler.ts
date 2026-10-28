import type { WorldStore } from '../persistence/world-store';
import type { Rng } from '../rules/dice';

/**
 * Background jobs, run once a minute: combat timeouts, afterimage expiry, commission and contract deadlines,
 * and the daily tick (1 game day = 1 real day, UTC). The daily tick is keyed by date in the database, so a
 * restart or a second server process never runs the same day twice.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduler_runs (world_id TEXT NOT NULL, job TEXT NOT NULL, run_key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (world_id, job, run_key));
`;

export interface TickReport { worldId: string; timedOut: string[]; daily: boolean; errors: string[] }

export class Scheduler {
  constructor(private store: WorldStore, private rng: Rng) {
    store.combat.db.exec(SCHEMA);
  }

  tick(now: Date): TickReport[] {
    return this.store.worldIds().map((worldId) => {
      const report: TickReport = { worldId, timedOut: [], daily: false, errors: [] };
      // Each job is its own transaction; one failing job must not stop the others.
      const run = (job: string, fn: () => void) => {
        try { fn(); } catch (e) { report.errors.push(`${job}: ${(e as Error).message}`); }
      };
      run('combat', () => { report.timedOut = this.store.runCombatTimeouts(worldId, this.rng, now); });
      run('afterimage', () => { this.store.runAfterimages(worldId, this.rng, now); });
      run('deadlines', () => { this.store.runDeadlines(worldId, this.rng, now); });
      run('daily', () => {
        const key = now.toISOString().slice(0, 10);
        this.store.combat.tx(() => {
          const done = this.store.combat.db.prepare("INSERT OR IGNORE INTO scheduler_runs VALUES (?, 'daily', ?, ?)").run(worldId, key, now.toISOString());
          if (done.changes !== 1) return;
          this.store.runDaily(worldId, this.rng, now);
          report.daily = true;
        });
      });
      return report;
    });
  }
}
