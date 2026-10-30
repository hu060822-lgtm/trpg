import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, Command, CombatPrefs, EncounterBundle, EncounterEvent, EncounterView } from '../api';
import { DEFAULT_PREFS, type AttackSource } from '../../../src/encounter/types';

export type Cell = { x: number; y: number };

/** What the player is choosing on the map right now, during their turn. */
export type Picking =
  | { kind: 'target'; source: AttackSource; combatantId: string }
  | { kind: 'area'; source: AttackSource; combatantId: string; point?: Cell };

/**
 * The running fight as this member sees it, kept fresh by the room's live updates (and a slow poll as a safety
 * net), plus every command they can send. Commands return the new state at once, so the screen never waits for
 * the WebSocket after the player's own action; `send` resolves to the events the command caused, or null if it failed.
 */
export function useEncounter(api: Api, roomId: string, version: number, live: boolean) {
  const [bundle, setBundle] = useState<EncounterBundle | null>(null);
  const [events, setEvents] = useState<EncounterEvent[]>([]);
  const [prefs, setPrefs] = useState<CombatPrefs>(DEFAULT_PREFS);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<Picking | null>(null);
  const encounterId = useRef<string | null>(null);
  const lastSeq = useRef(0);

  const take = useCallback((b: EncounterBundle) => {
    const id = b.encounter?.id ?? null;
    if (id !== encounterId.current) { encounterId.current = id; lastSeq.current = 0; setEvents([]); }
    const fresh = b.events.filter((e) => e.seq > lastSeq.current);
    if (fresh.length) {
      lastSeq.current = fresh.at(-1)!.seq;
      setEvents((old) => [...old, ...fresh].slice(-200));
    }
    setBundle(b);
    if (b.encounter) setPrefs(b.encounter.you.prefs);
  }, []);

  const reload = useCallback(async () => {
    try {
      take(await api.encounter(roomId, lastSeq.current));
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  }, [api, roomId, take]);

  useEffect(() => { void reload(); }, [reload, version]);
  useEffect(() => {
    // A step has a deadline; polling a little faster while something is running keeps timers honest without the socket.
    const running = bundle?.encounter && bundle.encounter.status !== 'ended';
    const t = setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, live ? 20000 : running ? 2500 : 10000);
    return () => clearInterval(t);
  }, [reload, live, bundle?.encounter?.status]);
  useEffect(() => { void api.combatPrefs().then(setPrefs).catch(() => {}); }, [api]);

  const send = useCallback(async (cmd: Command) => {
    setBusy(true);
    setError(null);
    try {
      const before = lastSeq.current;
      const b = await api.command(roomId, cmd);
      take(b);
      // What this command caused, so the screen can show it (the dice in the tray land on these faces).
      return b.events.filter((e) => e.seq > before);
    } catch (e) {
      setError(e as Error);
      // The step may have moved on (someone else acted, a timeout); show what is true now.
      void reload();
      return null;
    } finally {
      setBusy(false);
    }
  }, [api, roomId, take, reload]);

  const savePrefs = useCallback(async (p: Partial<CombatPrefs>) => {
    setPrefs((old) => ({ ...old, ...p }));
    try { setPrefs(await api.setCombatPrefs(p)); } catch (e) { setError(e as Error); }
  }, [api]);

  return {
    api,
    encounter: bundle?.encounter ?? null as EncounterView | null,
    vitals: bundle?.vitals ?? {},
    events, prefs, error, busy, picking, setPicking,
    send, reload, take, savePrefs, clearError: () => setError(null),
  };
}

export type Combat = ReturnType<typeof useEncounter>;

/** Milliseconds left on the step, ticking down once a second; null when there is no step. */
export function useCountdown(deadline: string | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [deadline]);
  return deadline ? Math.max(0, Date.parse(deadline) - now) : null;
}
