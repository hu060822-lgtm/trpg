import { useCallback, useEffect, useRef, useState } from 'react';

/** Hash routes keep static hosting simple: #/ for the lobby, #/room/<id> for a room. */
export function useRoute(): [string[], (path: string) => void] {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return [parts, (path: string) => { location.hash = `#/${path}`; }];
}

/**
 * Loads data now and again every `ms` while the tab is visible. Others act while you wait,
 * so the table refreshes itself; `reload` refreshes at once after your own action.
 */
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    setData(null);
    void reload();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, reload };
}

/** Runs an action, shows its error, and blocks double clicks while it is in flight. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: () => setError(null) };
}

export type RoomEvent = { type: 'log' } | { type: 'room' } | { type: 'map'; mapId: string } | { type: 'maps' };

/**
 * Listens for changes in a room over the server's WebSocket and reconnects with growing pauses when the line drops
 * (a sleeping free server takes a while to wake). `live` says whether updates are arriving at once right now.
 */
export function useRoomEvents(api: { token: () => Promise<string> }, apiUrl: string, roomId: string, on: (e: RoomEvent) => void) {
  const [live, setLive] = useState(false);
  const onRef = useRef(on);
  onRef.current = on;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let wait = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      const token = await api.token();
      if (stopped) return;
      ws = new WebSocket(apiUrl.replace(/^http/, 'ws') + '/ws');
      ws.onopen = () => ws!.send(JSON.stringify({ token, room: roomId }));
      ws.onmessage = (m) => {
        const e = JSON.parse(String(m.data)) as RoomEvent | { type: 'ready' };
        if (e.type === 'ready') { setLive(true); wait = 1000; return; }
        onRef.current(e);
      };
      ws.onclose = (e) => {
        setLive(false);
        if (stopped || e.code === 4001) return;
        timer = setTimeout(() => void connect(), wait);
        wait = Math.min(wait * 2, 30000);
      };
    };
    void connect();
    return () => { stopped = true; clearTimeout(timer); ws?.close(); };
  }, [api, apiUrl, roomId]);
  return live;
}
