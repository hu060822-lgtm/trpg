import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { TableStore } from '../table/store';
import type { Auth } from './auth';

/** What changed in a room. Clients refetch the part named, so each member still gets only what they may see. */
export type RoomEvent = { type: 'log' } | { type: 'room' } | { type: 'map'; mapId: string } | { type: 'maps' } | { type: 'encounter' };

/** Fans room events out to the browsers watching that room, in this process. */
export class RoomHub {
  private rooms = new Map<string, Set<(e: RoomEvent) => void>>();

  publish(roomId: string, e: RoomEvent) {
    for (const send of this.rooms.get(roomId) ?? []) send(e);
  }

  subscribe(roomId: string, send: (e: RoomEvent) => void): () => void {
    let set = this.rooms.get(roomId);
    if (!set) this.rooms.set(roomId, (set = new Set()));
    set.add(send);
    return () => {
      set.delete(send);
      if (set.size === 0) this.rooms.delete(roomId);
    };
  }
}

/**
 * Live updates over a WebSocket at /ws. The browser's first message is `{ token, room }`; the server checks the
 * token and the room membership, answers `{ type: 'ready' }`, then sends a RoomEvent whenever something changes.
 * Polling still works without it; this only makes changes show up at once.
 */
export function attachRealtime(server: Server, auth: Auth, table: TableStore, hub: RoomHub) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
  wss.on('connection', (ws: WebSocket & { alive?: boolean }) => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    let stop: (() => void) | undefined;
    const close = (reason: string) => { ws.close(4001, reason); };
    const timer = setTimeout(() => close('沒有收到登入資訊'), 10000);
    ws.once('message', async (raw) => {
      clearTimeout(timer);
      try {
        const { token, room } = JSON.parse(String(raw)) as { token?: string; room?: string };
        const principal = await auth.verify(token);
        if (!principal || typeof room !== 'string') return close('請先登入');
        await table.requireRole(room, principal.userId, 'player');
        if (ws.readyState !== ws.OPEN) return;
        stop = hub.subscribe(room, (e) => ws.send(JSON.stringify(e)));
        ws.send(JSON.stringify({ type: 'ready' }));
      } catch {
        close('不是這個房間的成員');
      }
    });
    ws.on('close', () => { clearTimeout(timer); stop?.(); });
  });
  // Proxies drop quiet connections; a ping every 25 seconds keeps them open and clears out dead ones.
  const beat = setInterval(() => {
    for (const ws of wss.clients as Set<WebSocket & { alive?: boolean }>) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 25000);
  wss.on('close', () => clearInterval(beat));
  server.on('close', () => { clearInterval(beat); wss.close(); });
  return wss;
}
