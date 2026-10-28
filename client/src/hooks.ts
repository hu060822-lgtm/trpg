import { useCallback, useEffect, useRef, useState } from 'react';

/** Hash routes keep GitHub Pages happy: #/, #/create, #/play/<world>/<character>, #/gm/<world>. */
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
