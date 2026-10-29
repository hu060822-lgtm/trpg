import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Api, MapObject, MapObjectKind, MapView, RoomView, Token } from '../api';
import { useAction } from '../hooks';
import { MapManager } from './MapManager';
import { defaultsFor, ObjectArt, ObjectCard, ObjectPalette } from './MapObjects';
import { Bars, Confirm, ErrorNote, IconButton } from './ui';

/** Pixels per square at zoom 1. */
const CELL = 56;
const COLORS = ['#6cc4a1', '#f0b552', '#d4505e', '#7fa7e0', '#c48fe0', '#e8e2d0'];
type Tool = 'move' | 'ruler' | 'reveal' | 'cover';
interface View { x: number; y: number; z: number }
type Cell = { x: number; y: number };

const initial = (name: string) => [...name.trim()][0] ?? '?';
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ARROWS: Record<string, Cell> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };

/**
 * Keeps keyboard focus inside a panel laid over the map while it is open: it starts on the panel, Tab cycles
 * within it, Escape closes it, and focus goes back to whatever opened it.
 */
function useOverlay(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opener = document.activeElement as HTMLElement | null;
    el.focus();
    const key = (e: KeyboardEvent) => {
      // A confirm dialog opened from the panel handles its own keys.
      if ((e.target as HTMLElement).closest('dialog')) return;
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); return; }
      if (e.key !== 'Tab') return;
      const all = [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')];
      if (all.length === 0) return;
      const first = all[0], last = all[all.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener('keydown', key);
    return () => { el.removeEventListener('keydown', key); if (opener?.isConnected) opener.focus(); };
  }, [ref]);
}

/**
 * The battle map: a picture under a square grid, tokens to drag, a ruler, and fog the GM paints away. One finger
 * or the mouse pans and drags; two fingers or the wheel zoom. Every change goes to the server, which tells the
 * others at the table.
 */
export function MapPanel({ api, view, mapId, version, onMaps, onChat }: {
  api: Api;
  view: RoomView;
  /** The map to show: the open one, or for a GM whichever they picked. */
  mapId: string | null;
  /** Bumps when the server says this map changed. */
  version: number;
  onMaps: (selected: string | null) => void;
  /** Takes a player to the chat while there is no map to look at. */
  onChat: () => void;
}) {
  const gm = view.me.role === 'gm';
  const roomId = view.room.id;
  const [data, setData] = useState<MapView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('move');
  const [cam, setCam] = useState<View>({ x: 0, y: 0, z: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [ruler, setRuler] = useState<{ a: Cell; b: Cell } | null>(null);
  const [brush, setBrush] = useState<Set<number>>(new Set());
  const [managing, setManaging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [selectedObj, setSelectedObj] = useState<string | null>(null);
  const [objDrag, setObjDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const act = useAction();
  const stage = useRef<HTMLDivElement>(null);
  const fogCanvas = useRef<HTMLCanvasElement>(null);
  const fitted = useRef<string | null>(null);
  // Until someone pans or zooms, the map keeps fitting the stage as the window or phone changes size.
  const steered = useRef(false);
  const drawer = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    if (!mapId) { setData(null); return; }
    try {
      setData(await api.map(roomId, mapId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, roomId, mapId]);
  useEffect(() => { void load(); }, [load, version]);

  const map = data?.map;
  // The picture is fetched with the player's token, so it is only shown to people who may see the map.
  useEffect(() => {
    if (!map?.imageVersion) { setImage(null); return; }
    let url: string | null = null;
    let live = true;
    void api.mapImage(roomId, map.id).then((blob) => { if (live) setImage((url = URL.createObjectURL(blob))); }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [api, roomId, map?.id, map?.imageVersion]);

  const fit = useCallback(() => {
    const el = stage.current;
    if (!el || !map) return;
    const w = el.clientWidth, h = el.clientHeight;
    const z = clamp(Math.min((w - 32) / (map.cols * CELL), (h - 32) / (map.rows * CELL)), 0.2, 1.6);
    setCam({ z, x: (w - map.cols * CELL * z) / 2, y: (h - map.rows * CELL * z) / 2 });
  }, [map]);
  useLayoutEffect(() => {
    if (map && fitted.current !== `${map.id}:${map.cols}x${map.rows}`) { fitted.current = `${map.id}:${map.cols}x${map.rows}`; steered.current = false; fit(); }
  }, [map, fit]);
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => { if (!steered.current) fit(); });
    watch.observe(el);
    return () => watch.disconnect();
  }, [fit, map?.id]);

  // Fog: one canvas pixel per square, stretched over the board. Squares being painted show the stroke at once.
  useEffect(() => {
    const c = fogCanvas.current;
    if (!c || !map) return;
    c.width = map.cols;
    c.height = map.rows;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, map.cols, map.rows);
    if (!map.fogEnabled) return;
    g.fillStyle = gm ? 'rgba(6, 5, 12, 0.66)' : '#0c0a08';
    for (let i = 0; i < map.fog.length; i++) {
      const painted = brush.has(i);
      const covered = painted ? tool === 'cover' : map.fog[i] === '1';
      if (covered) g.fillRect(i % map.cols, Math.floor(i / map.cols), 1, 1);
    }
  }, [map, brush, tool, gm]);

  const mine = useMemo(() => new Set(view.characters.filter((c) => c.ownerUserId === view.me.userId).map((c) => c.id)), [view]);
  const canMove = (t: Token) => gm || t.ownerUserId === view.me.userId;
  const tokens = data?.tokens ?? [];
  const sel = tokens.find((t) => t.id === selected) ?? null;
  const objects = data?.objects ?? [];
  const selObj = gm ? objects.find((o) => o.id === selectedObj) ?? null : null;
  const pick = (token: string | null, object: string | null) => { setSelected(token); setSelectedObj(object); };

  // ---------- pointer handling ----------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: 'pan'; sx: number; sy: number; cam: View; moved: boolean }
    | { kind: 'pinch'; d: number; cam: View; mx: number; my: number }
    | { kind: 'token'; id: string; grab: Cell; moved: boolean }
    | { kind: 'object'; id: string; grab: Cell; moved: boolean }
    | { kind: 'ruler' } | { kind: 'fog' } | null
  >(null);

  const cellAt = (cx: number, cy: number): Cell => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.floor((cx - r.left - cam.x) / cam.z / CELL), y: Math.floor((cy - r.top - cam.y) / cam.z / CELL) };
  };
  const inside = (c: Cell) => !!map && c.x >= 0 && c.y >= 0 && c.x < map.cols && c.y < map.rows;
  const paint = (c: Cell) => {
    if (!map || !inside(c)) return;
    setBrush((b) => (b.has(c.y * map.cols + c.x) ? b : new Set(b).add(c.y * map.cols + c.x)));
  };
  const zoomAt = (px: number, py: number, z: number, from: View = cam) => {
    steered.current = true;
    const nz = clamp(z, 0.2, 3);
    setCam({ z: nz, x: px - (px - from.x) * (nz / from.z), y: py - (py - from.y) * (nz / from.z) });
  };

  const down = (e: React.PointerEvent) => {
    if (!map) return;
    stage.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const r = stage.current!.getBoundingClientRect();
      gesture.current = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), cam, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top };
      setDrag(null);
      return;
    }
    const c = cellAt(e.clientX, e.clientY);
    const tokenEl = (e.target as HTMLElement).closest<HTMLElement>('[data-token]');
    if (tool === 'move' && tokenEl) {
      const t = tokens.find((x) => x.id === tokenEl.dataset.token);
      if (t) {
        pick(t.id, null);
        if (canMove(t)) { gesture.current = { kind: 'token', id: t.id, grab: { x: c.x - t.x, y: c.y - t.y }, moved: false }; return; }
      }
    }
    // Scenery sits under the tokens and only GMs can grab it; for players it is part of the board.
    const objectEl = gm && !tokenEl ? (e.target as HTMLElement).closest<HTMLElement>('[data-object]') : null;
    if (tool === 'move' && objectEl) {
      const o = objects.find((x) => x.id === objectEl.dataset.object);
      if (o) { pick(null, o.id); gesture.current = { kind: 'object', id: o.id, grab: { x: c.x - o.x, y: c.y - o.y }, moved: false }; return; }
    }
    if (tool === 'ruler') { gesture.current = { kind: 'ruler' }; setRuler({ a: c, b: c }); return; }
    if ((tool === 'reveal' || tool === 'cover') && gm) { gesture.current = { kind: 'fog' }; setBrush(new Set()); paint(c); return; }
    if (!tokenEl) pick(null, null);
    gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, cam, moved: false };
  };

  const move = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g || !map) return;
    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      zoomAt(g.mx, g.my, g.cam.z * (Math.hypot(a.x - b.x, a.y - b.y) / g.d), g.cam);
    } else if (g.kind === 'pan') {
      g.moved ||= Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 3;
      steered.current = true;
      setCam({ ...g.cam, x: g.cam.x + e.clientX - g.sx, y: g.cam.y + e.clientY - g.sy });
    } else if (g.kind === 'token') {
      const t = tokens.find((x) => x.id === g.id)!;
      const c = cellAt(e.clientX, e.clientY);
      const x = clamp(c.x - g.grab.x, 0, map.cols - t.size), y = clamp(c.y - g.grab.y, 0, map.rows - t.size);
      if (x !== t.x || y !== t.y || drag) { g.moved = true; setDrag({ id: t.id, x, y }); }
    } else if (g.kind === 'object') {
      const o = objects.find((x) => x.id === g.id)!;
      const c = cellAt(e.clientX, e.clientY);
      const x = clamp(c.x - g.grab.x, 0, map.cols - o.w), y = clamp(c.y - g.grab.y, 0, map.rows - o.h);
      if (x !== o.x || y !== o.y || objDrag) { g.moved = true; setObjDrag({ id: o.id, x, y }); }
    } else if (g.kind === 'ruler') {
      const b = cellAt(e.clientX, e.clientY);
      setRuler((r) => (r ? { ...r, b } : r));
    } else if (g.kind === 'fog') paint(cellAt(e.clientX, e.clientY));
  };

  const up = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size > 0) { if (g?.kind === 'pinch') gesture.current = null; return; }
    gesture.current = null;
    if (!g || !map) return;
    if (g.kind === 'token' && drag && g.moved) {
      const { id, x, y } = drag;
      setData((d) => (d ? { ...d, tokens: d.tokens.map((t) => (t.id === id ? { ...t, x, y } : t)) } : d));
      setDrag(null);
      void act.run(async () => { await api.updateToken(roomId, id, { x, y }); }).then((ok) => { if (!ok) void load(); });
    } else if (g.kind === 'object' && objDrag && g.moved) {
      const { id, x, y } = objDrag;
      setData((d) => (d ? { ...d, objects: d.objects.map((o) => (o.id === id ? { ...o, x, y } : o)) } : d));
      setObjDrag(null);
      void act.run(async () => { await api.updateObject(roomId, id, { x, y }); }).then((ok) => { if (!ok) void load(); });
    } else if (g.kind === 'fog' && brush.size) {
      const cells = [...brush], covered = tool === 'cover';
      setData((d) => {
        if (!d) return d;
        const fog = d.map.fog.split('');
        for (const i of cells) fog[i] = covered ? '1' : '0';
        return { ...d, map: { ...d.map, fog: fog.join('') } };
      });
      setBrush(new Set());
      void act.run(async () => { await api.fog(roomId, map.id, cells, covered); }).then((ok) => { if (!ok) void load(); });
    }
  };

  /** Arrow keys move a focused token one square, the same as dragging it there. */
  const nudge = (e: React.KeyboardEvent, t: Token) => {
    const step = ARROWS[e.key];
    if (e.key === 'Escape') { setSelected(null); return; }
    if (!step || !map || !canMove(t)) return;
    e.preventDefault();
    const x = clamp(t.x + step.x, 0, map.cols - t.size), y = clamp(t.y + step.y, 0, map.rows - t.size);
    if (x === t.x && y === t.y) return;
    setData((d) => (d ? { ...d, tokens: d.tokens.map((o) => (o.id === t.id ? { ...o, x, y } : o)) } : d));
    void act.run(async () => { await api.updateToken(roomId, t.id, { x, y }); }).then((ok) => { if (!ok) void load(); });
  };

  const nudgeObject = (e: React.KeyboardEvent, o: MapObject) => {
    const step = ARROWS[e.key];
    if (e.key === 'Escape') { setSelectedObj(null); return; }
    if (!step || !map) return;
    e.preventDefault();
    const x = clamp(o.x + step.x, 0, map.cols - o.w), y = clamp(o.y + step.y, 0, map.rows - o.h);
    if (x === o.x && y === o.y) return;
    setData((d) => (d ? { ...d, objects: d.objects.map((v) => (v.id === o.id ? { ...v, x, y } : v)) } : d));
    void act.run(async () => { await api.updateObject(roomId, o.id, { x, y }); }).then((ok) => { if (!ok) void load(); });
  };

  const wheel = (e: React.WheelEvent) => {
    const r = stage.current!.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, cam.z * Math.exp(-e.deltaY * 0.0015));
  };

  /** The square in the middle of what is on screen, where new tokens appear. */
  const centre = (): Cell => {
    const el = stage.current!;
    return { x: Math.floor((el.clientWidth / 2 - cam.x) / cam.z / CELL), y: Math.floor((el.clientHeight / 2 - cam.y) / cam.z / CELL) };
  };
  const placeable = view.characters.filter((c) => mine.has(c.id) && !tokens.some((t) => t.characterId === c.id));
  const placeCharacter = (characterId: string) => void act.run(async () => {
    const t = await api.addToken(roomId, map!.id, { characterId, ...centre(), color: COLORS[tokens.length % COLORS.length] });
    setSelected(t.id);
    await load();
  });

  const placeObject = (kind: MapObjectKind, from?: MapObject) => void act.run(async () => {
    const c = centre();
    const base = from ? { kind: from.kind, name: from.name, w: from.w, h: from.h, rotation: from.rotation, hidden: from.hidden, x: from.x + 1, y: from.y } : { ...defaultsFor(kind), ...c };
    const o = await api.addObject(roomId, map!.id, base);
    pick(null, o.id);
    await load();
  });

  // ---------- empty states ----------
  if (!mapId) {
    return (
      <div className="map-empty">
        {gm ? (
          <div className="card stack">
            <h2>放上第一張地圖</h2>
            <p className="muted small">先做一張空白格線地圖，之後可以上傳圖片當底圖。玩家會看到你打開的那張。</p>
            <MapManager api={api} roomId={roomId} map={null} activeMapId={null} onDone={(id) => onMaps(id)} compact />
          </div>
        ) : (
          <div className="card stack">
            <h2>還沒有地圖</h2>
            <p className="muted small">GM 打開地圖後，你的角色代幣和戰場會出現在這裡。等待時可以先聊天、擲骰。</p>
            <button className="primary" onClick={onChat}>到紀錄聊天</button>
          </div>
        )}
      </div>
    );
  }
  if (error && !data) return <div className="map-empty"><div className="card stack"><ErrorNote of={error} /><button onClick={() => void load()}>再試一次</button></div></div>;
  if (!map) return <div className="map" aria-busy="true"><div className="map-bar"><Bars lines={1} className="bar-line" /></div><div className="stage"><div className="skeleton board-ghost" /></div></div>;

  const at = (t: Token) => (drag?.id === t.id ? drag : t);
  const dist = ruler ? Math.max(Math.abs(ruler.b.x - ruler.a.x), Math.abs(ruler.b.y - ruler.a.y)) : 0;
  const W = map.cols * CELL, H = map.rows * CELL;

  return (
    <div className="map">
      <div className="map-bar" role="toolbar" aria-label="地圖工具">
        <div className="seg">
          <button aria-pressed={tool === 'move'} onClick={() => setTool('move')}>移動</button>
          <button aria-pressed={tool === 'ruler'} onClick={() => { setTool('ruler'); setRuler(null); }}>量尺</button>
          {gm && map.fogEnabled && <>
            <button aria-pressed={tool === 'reveal'} onClick={() => setTool('reveal')}>揭開</button>
            <button aria-pressed={tool === 'cover'} onClick={() => setTool('cover')}>遮蔽</button>
          </>}
        </div>
        <div className="seg">
          <IconButton label="縮小地圖" onClick={() => zoomAt(stage.current!.clientWidth / 2, stage.current!.clientHeight / 2, cam.z / 1.25)}>−</IconButton>
          <IconButton label="放大地圖" onClick={() => zoomAt(stage.current!.clientWidth / 2, stage.current!.clientHeight / 2, cam.z * 1.25)}>＋</IconButton>
          <IconButton label="整張地圖置中" onClick={() => { steered.current = false; fit(); }}>⤢</IconButton>
        </div>
        <span className="spacer" />
        {placeable.map((c) => <button key={c.id} className="primary" disabled={act.busy} onClick={() => placeCharacter(c.id)}>放上{c.name}</button>)}
        {gm && (
          <div className="gm-tools" role="group" aria-label="GM 工具">
            <span className="gm-mark" aria-hidden>GM</span>
            <button onClick={() => { setAdding((v) => !v); setPlacing(false); }} aria-expanded={adding}>新增代幣</button>
            <button onClick={() => { setPlacing((v) => !v); setAdding(false); setTool('move'); }} aria-expanded={placing}>布置物件</button>
            <button onClick={() => setManaging((v) => !v)} aria-expanded={managing}>設定地圖</button>
          </div>
        )}
      </div>

      <div className="stage-wrap">
      <div className="map-title">
        <b>{map.name}</b>
        {gm && view.room.activeMapId !== map.id && <span className="badge">玩家看不到</span>}
        {tool === 'ruler' && ruler && <span className="ruler-read">{dist} 格・{+(dist * map.cellDistance).toFixed(2)} {map.unit}</span>}
      </div>
      <p className="tool-hint" aria-live="polite">{{
        move: gm ? '拖曳代幣或物件移動；拖曳空白處平移，滾輪或兩指縮放。選中後也能用方向鍵移動。' : '拖曳代幣移動；拖曳空白處平移，滾輪或兩指縮放。選中代幣後也能用方向鍵移動。',
        ruler: '按住拖曳，量兩格之間的距離。',
        reveal: '在地圖上塗抹，揭開迷霧。',
        cover: '在地圖上塗抹，蓋回迷霧。',
      }[tool]}</p>

      <div ref={stage} className={`stage tool-${tool}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}>
        <div className="board" style={{ width: W, height: H, transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }}>
          {image ? <img src={image} alt="" draggable={false} /> : <div className="felt" />}
          {map.showGrid && <div className="grid" style={{ backgroundSize: `${CELL}px ${CELL}px` }} />}
          {objects.map((o) => {
            const p = objDrag?.id === o.id ? { ...o, ...objDrag } : o;
            return (
              <div key={o.id} data-object={o.id} {...(gm ? { role: 'button', tabIndex: 0, 'aria-label': `${o.name || o.kind}，第 ${o.x + 1} 欄第 ${o.y + 1} 列，方向鍵移動`, 'aria-pressed': o.id === selectedObj,
                onFocus: () => pick(null, o.id), onKeyDown: (e: React.KeyboardEvent) => nudgeObject(e, o) } : { 'aria-hidden': true })}
                className={`object kind-${o.kind}${o.id === selectedObj ? ' selected' : ''}${o.hidden ? ' hidden' : ''}${gm ? ' movable' : ''}${objDrag?.id === o.id ? ' dragging' : ''}`}
                style={{ transform: `translate(${p.x * CELL}px, ${p.y * CELL}px)`, width: o.w * CELL, height: o.h * CELL }}>
                <ObjectArt o={o} cell={CELL} />
                {gm && o.name && o.kind !== 'label' && <span className="tag">{o.name}</span>}
              </div>
            );
          })}
          {tokens.map((t) => {
            const p = at(t);
            return (
              <div key={t.id} data-token={t.id} role="button" tabIndex={0}
                aria-label={`${t.name}，第 ${t.x + 1} 欄第 ${t.y + 1} 列${canMove(t) ? '，方向鍵移動' : ''}`} aria-pressed={t.id === selected}
                onFocus={() => pick(t.id, null)} onKeyDown={(e) => nudge(e, t)}
                className={`token${t.id === selected ? ' selected' : ''}${t.hidden ? ' hidden' : ''}${canMove(t) ? ' movable' : ''}${drag?.id === t.id ? ' dragging' : ''}`}
                style={{ transform: `translate(${p.x * CELL}px, ${p.y * CELL}px)`, width: t.size * CELL, height: t.size * CELL, '--c': t.color } as React.CSSProperties}>
                <span className="disc" style={{ fontSize: Math.max(14, t.size * CELL * 0.38) }}>{initial(t.name)}</span>
                <span className="tag">{t.name}</span>
              </div>
            );
          })}
          <canvas ref={fogCanvas} className={`fog${gm ? ' gm' : ''}`} />
          {ruler && (
            <svg className="ruler" width={W} height={H}>
              <line x1={(ruler.a.x + 0.5) * CELL} y1={(ruler.a.y + 0.5) * CELL} x2={(ruler.b.x + 0.5) * CELL} y2={(ruler.b.y + 0.5) * CELL} />
              <circle cx={(ruler.a.x + 0.5) * CELL} cy={(ruler.a.y + 0.5) * CELL} r={6} />
              <circle cx={(ruler.b.x + 0.5) * CELL} cy={(ruler.b.y + 0.5) * CELL} r={6} />
              <text x={(ruler.b.x + 0.5) * CELL + 12} y={(ruler.b.y + 0.5) * CELL - 12} style={{ fontSize: 16 / Math.max(cam.z, 0.5) }}>
                {dist} 格・{+(dist * map.cellDistance).toFixed(2)} {map.unit}
              </text>
            </svg>
          )}
        </div>
      </div>
      </div>

      <ErrorNote of={act} className="map-toast" />
      {sel && <TokenCard api={api} roomId={roomId} token={sel} gm={gm} canEdit={canMove(sel)} mine={mine.has(sel.characterId ?? '')} onClose={() => setSelected(null)} onChanged={load} />}
      {selObj && <ObjectCard key={selObj.id} api={api} roomId={roomId} object={selObj} onClose={() => setSelectedObj(null)} onChanged={load} onCopy={() => placeObject(selObj.kind, selObj)} />}
      {placing && gm && !selObj && <ObjectPalette busy={act.busy} onPick={(k) => placeObject(k)} onClose={() => setPlacing(false)} />}
      {adding && gm && <AddToken api={api} roomId={roomId} mapId={map.id} where={centre} onDone={async (id) => { setAdding(false); setSelected(id); await load(); }} />}
      {managing && gm && (
        <Drawer panel={drawer} onClose={() => setManaging(false)}>
          <div className="drawer-head"><h2>設定地圖</h2><button className="link" onClick={() => setManaging(false)}>關閉設定</button></div>
          <MapManager api={api} roomId={roomId} map={map} activeMapId={view.room.activeMapId} onDone={(id) => { onMaps(id); void load(); }} />
        </Drawer>
      )}
    </div>
  );
}

function Drawer({ panel, onClose, children }: { panel: React.RefObject<HTMLElement | null>; onClose: () => void; children: React.ReactNode }) {
  useOverlay(panel, onClose);
  return <aside ref={panel} className="drawer" tabIndex={-1} aria-label="設定地圖">{children}</aside>;
}

function TokenCard({ api, roomId, token, gm, canEdit, mine, onClose, onChanged }: {
  api: Api; roomId: string; token: Token; gm: boolean; canEdit: boolean; mine: boolean; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const act = useAction();
  const [asking, setAsking] = useState(false);
  const save = (change: Parameters<Api['updateToken']>[2]) => void act.run(async () => { await api.updateToken(roomId, token.id, change); await onChanged(); });
  return (
    <div className="token-card" onKeyDown={(e) => { if (e.key === 'Escape' && !asking) onClose(); }}>
      <div className="row">
        <span className="swatch" style={{ background: token.color }} />
        <b>{token.name}</b>
        {mine && <span className="badge">我的角色</span>}
        {token.hidden && <span className="badge secret">只有 GM 看得到</span>}
        <span className="spacer" />
        <button className="link" onClick={onClose}>收起</button>
      </div>
      {canEdit && (
        <div className="row">
          {COLORS.map((c) => <button key={c} className="swatch-btn" aria-label={`代幣改成這個顏色 ${c}`} aria-pressed={token.color === c} style={{ background: c }} onClick={() => save({ color: c })} />)}
          {gm && (
            <label className="tick">大小
              <select value={token.size} onChange={(e) => save({ size: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}×{n}</option>)}
              </select>
            </label>
          )}
          {gm && <label className="tick"><input type="checkbox" checked={token.hidden} onChange={(e) => save({ hidden: e.target.checked })} />隱藏</label>}
          <button className="danger" disabled={act.busy} onClick={() => setAsking(true)}>移除代幣</button>
        </div>
      )}
      <ErrorNote of={act} />
      {asking && (
        <Confirm title={`移除代幣「${token.name}」？`} action="移除代幣" onClose={() => setAsking(false)}
          body={token.characterId ? '代幣會從這張地圖拿掉，角色卡不受影響，之後可以再放上來。' : '代幣會從這張地圖拿掉，名字、顏色和位置都不會保留。'}
          onConfirm={() => void act.run(async () => { await api.removeToken(roomId, token.id); onClose(); await onChanged(); })} />
      )}
    </div>
  );
}

function AddToken({ api, roomId, mapId, where, onDone }: { api: Api; roomId: string; mapId: string; where: () => Cell; onDone: (id: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[2]);
  const [size, setSize] = useState(1);
  const [hidden, setHidden] = useState(false);
  const [nameLeft, setNameLeft] = useState(false);
  const act = useAction();
  const missing = nameLeft && !name.trim();
  return (
    <form className="token-card" noValidate onSubmit={(e) => {
      e.preventDefault();
      if (!name.trim()) { setNameLeft(true); return; }
      void act.run(async () => { const t = await api.addToken(roomId, mapId, { name: name.trim(), color, size, hidden, ...where() }); await onDone(t.id); });
    }}>
      <div className="row">
        <label className="grow">代幣名稱
          <input required maxLength={24} value={name} placeholder="哥布林" aria-invalid={missing || undefined}
            onChange={(e) => setName(e.target.value)} onFocus={() => setNameLeft(false)} onBlur={() => setNameLeft(true)} />
        </label>
        <div className="row" role="group" aria-label="代幣顏色">
          {COLORS.map((c) => <button type="button" key={c} className="swatch-btn" aria-label={`顏色 ${c}`} aria-pressed={color === c} style={{ background: c }} onClick={() => setColor(c)} />)}
        </div>
      </div>
      {missing && <p className="field-error">替代幣取個名字，滑鼠移上去或點選時會看到。</p>}
      <div className="row">
        <label className="tick">大小
          <select value={size} onChange={(e) => setSize(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}×{n}</option>)}</select>
        </label>
        <label className="tick"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />先藏起來</label>
        <button className="primary" disabled={act.busy}>放到畫面中央</button>
      </div>
      <ErrorNote of={act} />
    </form>
  );
}

