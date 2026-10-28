import type { WorldStore } from '../persistence/world-store';
import type { Rng } from '../rules/dice';

/**
 * Background jobs: combat timeouts, afterimage expiry, commission and contract deadlines, and the daily tick
 * (1 game day = 1 real day, UTC). The daily tick is keyed by date in the database, so a restart or a second server
 * process never runs the same day twice. A server that slept (Render's free tier) catches up on its next tick:
 * every job compares deadlines with the current time, so nothing that came due while it slept is skipped.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduler_runs (world_id TEXT NOT NULL, job TEXT NOT NULL, run_key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (world_id, job, run_key));
`;

export interface TickReport { worldId: string; timedOut: string[]; daily: boolean; errors: string[] }

export class Scheduler {
  private last = 0;
  private running?: Promise<TickReport[]>;

  private constructor(private store: WorldStore, private rng: Rng) {}

  static async open(store: WorldStore, rng: Rng) {
    await store.combat.db.migrate(SCHEMA);
    return new Scheduler(store, rng);
  }

  /** Ticks unless one ran within `minGapMs`; concurrent callers share the tick in progress. */
  async catchUp(now: Date, minGapMs = 30_000): Promise<void> {
    if (this.running) { await this.running; return; }
    if (now.getTime() - this.last < minGapMs) return;
    await this.tick(now);
  }

  tick(now: Date): Promise<TickReport[]> {
    this.last = now.getTime();
    this.running = this.runAll(now).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async runAll(now: Date): Promise<TickReport[]> {
    const reports: TickReport[] = [];
    for (const worldId of await this.store.worldIds()) {
      const report: TickReport = { worldId, timedOut: [], daily: false, errors: [] };
      // Each job is its own transaction; one failing job must not stop the others.
      const run = async (job: string, fn: () => Promise<unknown>) => {
        try { await fn(); } catch (e) { report.errors.push(`${job}: ${(e as Error).message}`); }
      };
      await run('combat', async () => { report.timedOut = await this.store.runCombatTimeouts(worldId, this.rng, now); });
      await run('afterimage', () => this.store.runAfterimages(worldId, this.rng, now));
      await run('deadlines', () => this.store.runDeadlines(worldId, this.rng, now));
      await run('daily', () => this.store.combat.tx(async () => {
        const key = now.toISOString().slice(0, 10);
        const done = await this.store.combat.db.run(
          "INSERT INTO scheduler_runs VALUES ($1, 'daily', $2, $3) ON CONFLICT DO NOTHING", [worldId, key, now.toISOString()]);
        if (done !== 1) return;
        await this.store.runDaily(worldId, this.rng, now);
        report.daily = true;
      }));
      reports.push(report);
    }
    return reports;
  }
}
