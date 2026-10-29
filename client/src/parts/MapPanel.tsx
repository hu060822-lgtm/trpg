import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Api, MapView, RoomView, Token } from '../api';
import { useAction } from '../hooks';
import { MapManager } from './MapManager';

/** Pixels per square at zoom 1. */
const CELL = 56;
const COLORS = ['#6cc4a1', '#f0b552', '#d4505e', '#7fa7e0', '#c48fe0', '#e8e2d0'];
type Tool = 'move' | 'ruler' | 'reveal' | 'cover';
interface View { x: number; y: number; z: number }
type Cell = { x: number; y: number };

const initial = (name: string) => [...name.trim()][0] ?? '?';
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The battle map: a picture under a square grid, tokens to drag, a ruler, and fog the GM paints away. One finger
 * or the mouse pans and drags; two fingers or the wheel zoom. Every change goes to the server, which tells the
 * others at the table.
 */
export function MapPanel({ api, view, mapId, version, onMaps }: {
  api: Api;
  view: RoomView;
  /** The map to show: the open one, or for a GM whichever they picked. */
  mapId: string | null;
  /** Bumps when the server says this map changed. */
  version: number;
  onMaps: (selected: string | null) => void;
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
  const act = useAction();
  const stage = useRef<HTMLDivElement>(null);
  const fogCanvas = useRef<HTMLCanvasElement>(null);
  const fitted = useRef<string | null>(null);

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
    if (map && fitted.current !== `${map.id}:${map.cols}x${map.rows}`) { fitted.current = `${map.id}:${map.cols}x${map.rows}`; fit(); }
  }, [map, fit]);

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

  // ---------- pointer handling ----------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: 'pan'; sx: number; sy: number; cam: View; moved: boolean }
    | { kind: 'pinch'; d: number; cam: View; mx: number; my: number }
    | { kind: 'token'; id: string; grab: Cell; moved: boolean }
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
        setSelected(t.id);
        if (canMove(t)) { gesture.current = { kind: 'token', id: t.id, grab: { x: c.x - t.x, y: c.y - t.y }, moved: false }; return; }
      }
    }
    if (tool === 'ruler') { gesture.current = { kind: 'ruler' }; setRuler({ a: c, b: c }); return; }
    if ((tool === 'reveal' || tool === 'cover') && gm) { gesture.current = { kind: 'fog' }; setBrush(new Set()); paint(c); return; }
    if (!tokenEl) setSelected(null);
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
      setCam({ ...g.cam, x: g.cam.x + e.clientX - g.sx, y: g.cam.y + e.clientY - g.sy });
    } else if (g.kind === 'token') {
      const t = tokens.find((x) => x.id === g.id)!;
      const c = cellAt(e.clientX, e.clientY);
      const x = clamp(c.x - g.grab.x, 0, map.cols - t.size), y = clamp(c.y - g.grab.y, 0, map.rows - t.size);
      if (x !== t.x || y !== t.y || drag) { g.moved = true; setDrag({ id: t.id, x, y }); }
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
        ) : <p className="muted">GM 還沒打開地圖。先在紀錄裡聊天、擲骰吧。</p>}
      </div>
    );
  }
  if (error && !data) return <div className="map-empty"><p className="error">{error}</p></div>;
  if (!map) return <div className="map-empty"><p className="muted">載入地圖中…</p></div>;

  const at = (t: Token) => (drag?.id === t.id ? drag : t);
  const dist = ruler ? Math.max(Math.abs(ruler.b.x - ruler.a.x), Math.abs(ruler.b.y - ruler.a.y)) : 0;
  const W = map.cols * CELL, H = map.rows * CELL;

  return (
    <div className="map">
      <div className="map-bar" role="toolbar" aria-label="地圖工具">
        <div className="seg">
          <button aria-pressed={tool === 'move'} onClick={() => setTool('move')} title="拖曳代幣、移動畫面">移動</button>
          <button aria-pressed={tool === 'ruler'} onClick={() => { setTool('ruler'); setRuler(null); }} title="按住拖曳量距離">量尺</button>
          {gm && map.fogEnabled && <>
            <button aria-pressed={tool === 'reveal'} onClick={() => setTool('reveal')} title="塗抹揭開迷霧">揭開</button>
            <button aria-pressed={tool === 'cover'} onClick={() => setTool('cover')} title="塗抹蓋上迷霧">遮蔽</button>
          </>}
        </div>
        <div className="seg">
          <button aria-label="縮小" onClick={() => zoomAt(stage.current!.clientWidth / 2, stage.current!.clientHeight / 2, cam.z / 1.25)}>−</button>
          <button aria-label="放大" onClick={() => zoomAt(stage.current!.clientWidth / 2, stage.current!.clientHeight / 2, cam.z * 1.25)}>＋</button>
          <button onClick={fit}>置中</button>
        </div>
        <span className="spacer" />
        {placeable.map((c) => <button key={c.id} className="primary" disabled={act.busy} onClick={() => placeCharacter(c.id)}>放上{c.name}</button>)}
        {gm && <button onClick={() => setAdding((v) => !v)} aria-expanded={adding}>新增代幣</button>}
        {gm && <button onClick={() => setManaging((v) => !v)} aria-expanded={managing}>地圖設定</button>}
      </div>

      <div className="map-title">
        <b>{map.name}</b>
        {gm && view.room.activeMapId !== map.id && <span className="badge">玩家看不到</span>}
        {tool === 'ruler' && ruler && <span className="ruler-read">{dist} 格・{+(dist * map.cellDistance).toFixed(2)} {map.unit}</span>}
      </div>

      <div ref={stage} className={`stage tool-${tool}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}>
        <div className="board" style={{ width: W, height: H, transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }}>
          {image ? <img src={image} alt="" draggable={false} /> : <div className="felt" />}
          {map.showGrid && <div className="grid" style={{ backgroundSize: `${CELL}px ${CELL}px` }} />}
          {tokens.map((t) => {
            const p = at(t);
            return (
              <div key={t.id} data-token={t.id} title={t.name}
                className={`token${t.id === selected ? ' selected' : ''}${t.hidden ? ' hidden' : ''}${canMove(t) ? ' movable' : ''}${drag?.id === t.id ? ' dragging' : ''}`}
                style={{ left: p.x * CELL, top: p.y * CELL, width: t.size * CELL, height: t.size * CELL, '--c': t.color } as React.CSSProperties}>
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

      {act.error && <p className="error map-toast">{act.error}</p>}
      {sel && <TokenCard api={api} roomId={roomId} token={sel} gm={gm} canEdit={canMove(sel)} mine={mine.has(sel.characterId ?? '')} onClose={() => setSelected(null)} onChanged={load} />}
      {adding && gm && <AddToken api={api} roomId={roomId} mapId={map.id} where={centre} onDone={async (id) => { setAdding(false); setSelected(id); await load(); }} />}
      {managing && gm && (
        <aside className="drawer">
          <div className="drawer-head"><h2>地圖設定</h2><button className="link" onClick={() => setManaging(false)}>關閉</button></div>
          <MapManager api={api} roomId={roomId} map={map} activeMapId={view.room.activeMapId} onDone={(id) => { onMaps(id); void load(); }} />
        </aside>
      )}
    </div>
  );
}

function TokenCard({ api, roomId, token, gm, canEdit, mine, onClose, onChanged }: {
  api: Api; roomId: string; token: Token; gm: boolean; canEdit: boolean; mine: boolean; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const act = useAction();
  const save = (change: Parameters<Api['updateToken']>[2]) => void act.run(async () => { await api.updateToken(roomId, token.id, change); await onChanged(); });
  return (
    <div className="token-card">
      <div className="row">
        <span className="swatch" style={{ background: token.color }} />
        <b>{token.name}</b>
        {mine && <span className="badge">我的角色</span>}
        {token.hidden && <span className="badge secret">只有 GM 看得到</span>}
        <span className="spacer" />
        <button className="link" onClick={onClose}>關閉</button>
      </div>
      {canEdit && (
        <div className="row">
          {COLORS.map((c) => <button key={c} className="swatch-btn" aria-label={`改成 ${c}`} aria-pressed={token.color === c} style={{ background: c }} onClick={() => save({ color: c })} />)}
          {gm && (
            <label className="tick">大小
              <select value={token.size} onChange={(e) => save({ size: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}×{n}</option>)}
              </select>
            </label>
          )}
          {gm && <label className="tick"><input type="checkbox" checked={token.hidden} onChange={(e) => save({ hidden: e.target.checked })} />隱藏</label>}
          <button className="danger" disabled={act.busy} onClick={() => void act.run(async () => { await api.removeToken(roomId, token.id); onClose(); await onChanged(); })}>移除</button>
        </div>
      )}
      {act.error && <p className="error">{act.error}</p>}
    </div>
  );
}

function AddToken({ api, roomId, mapId, where, onDone }: { api: Api; roomId: string; mapId: string; where: () => Cell; onDone: (id: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[2]);
  const [size, setSize] = useState(1);
  const [hidden, setHidden] = useState(false);
  const act = useAction();
  return (
    <form className="token-card" onSubmit={(e) => {
      e.preventDefault();
      void act.run(async () => { const t = await api.addToken(roomId, mapId, { name: name.trim(), color, size, hidden, ...where() }); await onDone(t.id); });
    }}>
      <div className="row">
        <input required maxLength={24} value={name} onChange={(e) => setName(e.target.value)} placeholder="代幣名稱，例如 哥布林" aria-label="代幣名稱" />
        {COLORS.map((c) => <button type="button" key={c} className="swatch-btn" aria-label={`顏色 ${c}`} aria-pressed={color === c} style={{ background: c }} onClick={() => setColor(c)} />)}
      </div>
      <div className="row">
        <label className="tick">大小
          <select value={size} onChange={(e) => setSize(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}×{n}</option>)}</select>
        </label>
        <label className="tick"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />先藏起來</label>
        <button className="primary" disabled={act.busy || !name.trim()}>放到畫面中央</button>
      </div>
      {act.error && <p className="error">{act.error}</p>}
    </form>
  );
}

