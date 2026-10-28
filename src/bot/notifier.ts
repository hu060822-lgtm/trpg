import type { WorldEvent } from '../world/types';
import type { GameApi } from './api';

/**
 * Pushes world history to Discord as it happens:
 * public entries to the world channel, GM entries to the GM channel, and scene and private entries by DM
 * to the players whose characters were there or were addressed. One DM per player per entry.
 */
export type Destination = { kind: 'world' } | { kind: 'gm' } | { kind: 'dm'; discordId: string };
export interface Outgoing { to: Destination; seq: number; text: string }

export interface Feed { events: WorldEvent[]; owners: Record<string, string>; gms: Record<string, unknown> }

export function route(feed: Feed): Outgoing[] {
  const out: Outgoing[] = [];
  for (const e of feed.events) {
    const text = `第 ${e.day} 天｜${e.text}`;
    if (e.visibility === 'public') out.push({ to: { kind: 'world' }, seq: e.seq, text });
    else if (e.visibility === 'gm') out.push({ to: { kind: 'gm' }, seq: e.seq, text });
    else {
      const users = new Set(e.audience.map((c) => feed.owners[c]).filter((u): u is string => !!u && u.startsWith('discord:')));
      for (const u of users) out.push({ to: { kind: 'dm', discordId: u.slice('discord:'.length) }, seq: e.seq, text: `${e.visibility === 'scene' ? '【場景】' : '【私訊】'}${text}` });
    }
  }
  return out;
}

/** Polls the feed and delivers each entry once; the cursor is saved after each delivered batch. */
export class Notifier {
  constructor(
    private api: GameApi,
    private worldId: string,
    private send: (m: Outgoing) => Promise<void>,
    private cursor: { load(): number; save(seq: number): void },
  ) {}

  async poll(): Promise<number> {
    const after = this.cursor.load();
    const feed = await this.api.feed(this.worldId, after) as Feed;
    let last = after;
    for (const m of route(feed)) {
      // A DM can fail (the player blocks DMs); that must not stall everyone else's notifications.
      await this.send(m).catch((err) => console.error(`[notifier] #${m.seq} to ${JSON.stringify(m.to)}: ${(err as Error).message}`));
    }
    for (const e of feed.events) last = Math.max(last, e.seq);
    if (last !== after) this.cursor.save(last);
    return feed.events.length;
  }
}
