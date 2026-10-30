import { useCallback, useEffect, useRef, useState } from 'react';
import type { MapInfo, MapObject, Token } from '../api';
import { heightOf } from '../../../src/encounter/geometry';
import type { Cell } from './state';
import type { MapOverlay } from './Combat';

/**
 * The tilted (2.5D) view of the same map. It is only another way to draw the grid: every position, range and line
 * of sight still comes from the square grid, so the two views can never disagree. Floors and pictures are drawn
 * with one affine transform; walls and furniture stand up as boxes as tall as their height; tokens stand at their
 * elevation. Four rotations, so nothing hides behind a wall for good.
 */

const FACE: Partial<Record<MapObject['kind'], [string, string, string]>> = {
  // top, right face, left face
  wall: ['#8f8577', '#6d655a', '#5a534a'], door: ['#9b6b3f', '#7a522f', '#664427'], window: ['#9bb8c9', '#7d98a8', '#6a8291'],
  pillar: ['#a59a88', '#81786a', '#6c645a'], bookshelf: ['#7b5634', '#5e4128', '#4d3520'], statue: ['#b9b2a6', '#958f84', '#7d776e'],
  tree: ['#3f7a4a', '#2f5e38', '#264d2e'], rock: ['#7d7a72', '#5f5c56', '#4f4c47'], crate: ['#a07a4a', '#7e5f39', '#6a4f30'],
  barrel: ['#8a5f38', '#6c4a2b', '#5a3d23'], table: ['#946a42', '#735233', '#61452b'], altar: ['#a8a29a', '#86817a', '#716d67'],
  bush: ['#4f8a4f', '#3c6b3c', '#325a32'], chest: ['#a9772f', '#865d24', '#704e1e'], bed: ['#8b5e6a', '#6d4952', '#5b3d45'], chair: ['#946a42', '#735233', '#61452b'],
  rubble: ['#6f6a60', '#58544c', '#4a4740'],
};
const FLAT: Partial<Record<MapObject['kind'], string>> = { water: 'rgba(80,140,200,0.55)', fire: 'rgba(240,120,60,0.6)', stairs: 'rgba(200,190,170,0.45)', trap: 'rgba(212,80,94,0.35)', label: 'rgba(0,0,0,0)' };

interface Cam { x: number; y: number; z: number }

export function IsoBoard({ map, tokens, objects, image, pictures = {}, overlay, gm, selected, canMove, onSelect, onMove }: {
  map: MapInfo; tokens: Token[]; objects: MapObject[]; image: string | null; pictures?: Record<string, string>; overlay: MapOverlay | null; gm: boolean;
  selected: string | null; canMove: (t: Token) => boolean; onSelect: (id: string | null) => void; onMove: (t: Token, c: Cell) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [rot, setRot] = useState(0);
  const [cam, setCam] = useState<Cam>({ x: 0, y: 0, z: 1 });
  const [size, setSize] = useState({ w: 600, h: 400 });
  const [hover, setHover] = useState<Cell | null>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const [, imgLoaded] = useState(0);
  const fitted = useRef('');
  const faces = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    for (const [id, url] of Object.entries(pictures)) {
      if (faces.current.get(id)?.src === url) continue;
      const i = new Image();
      i.onload = () => { faces.current.set(id, i); imgLoaded((n) => n + 1); };
      i.src = url;
    }
  }, [pictures]);

  useEffect(() => {
    if (!image) { img.current = null; return; }
    const i = new Image();
    i.onload = () => { img.current = i; imgLoaded((n) => n + 1); };
    i.src = image;
  }, [image]);

  useEffect(() => {
    const el = wrap.current!;
    const fit = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const T = 64; // tile width at zoom 1
  const rotated = rot % 2 === 1;
  const RW = rotated ? map.rows : map.cols, RH = rotated ? map.cols : map.rows;
  /** Grid point → rotated grid point. */
  const R = useCallback((x: number, y: number): [number, number] => {
    switch (rot) {
      case 1: return [map.rows - y, x];
      case 2: return [map.cols - x, map.rows - y];
      case 3: return [y, map.cols - x];
      default: return [x, y];
    }
  }, [rot, map.cols, map.rows]);
  const hw = (T / 2) * cam.z, hh = (T / 4) * cam.z;
  const zpx = (feet: number) => (feet / map.cellDistance) * (T / 2) * cam.z;
  const P = useCallback((x: number, y: number, feet = 0) => {
    const [rx, ry] = R(x, y);
    return { x: cam.x + (rx - ry) * hw, y: cam.y + (rx + ry) * hh - zpx(feet) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [R, cam, hw, hh]);

  // Centre the board when the map or rotation changes.
  useEffect(() => {
    const key = `${map.id}:${map.cols}x${map.rows}:${rot}:${size.w}x${size.h}`;
    if (fitted.current === key) return;
    fitted.current = key;
    const z = Math.max(0.2, Math.min(2, Math.min((size.w - 40) / ((RW + RH) * (T / 2)), (size.h - 80) / ((RW + RH) * (T / 4)))));
    const midX = ((RW - RH) / 2) * (T / 2) * z, midY = ((RW + RH) / 2) * (T / 4) * z;
    setCam({ z, x: size.w / 2 - midX, y: size.h / 2 - midY + 20 });
  }, [map.id, map.cols, map.rows, rot, size, RW, RH]);

  /** Screen point → ground cell (z = 0). */
  const unproject = (sx: number, sy: number): Cell => {
    const a = (sx - cam.x) / hw, b = (sy - cam.y) / hh; // a = rx - ry, b = rx + ry
    const rx = (a + b) / 2, ry = (b - a) / 2;
    let x: number, y: number;
    switch (rot) {
      case 1: x = ry; y = map.rows - rx; break;
      case 2: x = map.cols - rx; y = map.rows - ry; break;
      case 3: x = map.cols - ry; y = rx; break;
      default: x = rx; y = ry;
    }
    return { x: Math.floor(x), y: Math.floor(y) };
  };
  const tokenAt = (sx: number, sy: number): Token | null => {
    let best: Token | null = null, depth = -Infinity;
    for (const t of tokens) {
      const c = P(t.x + t.size / 2, t.y + t.size / 2, t.elevation ?? 0);
      const r = T * 0.32 * t.size * cam.z;
      const cy = c.y - r * 1.1;
      if (Math.hypot(sx - c.x, sy - cy) <= r * 1.15) {
        const [rx, ry] = R(t.x + t.size / 2, t.y + t.size / 2);
        if (rx + ry > depth) { depth = rx + ry; best = t; }
      }
    }
    return best;
  };

  // ---------- drawing ----------
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size.w * dpr; c.height = size.h * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#120e0c';
    g.fillRect(0, 0, size.w, size.h);
    // The floor: one affine transform from grid units to the screen.
    const o = P(0, 0), ex = P(1, 0), ey = P(0, 1);
    g.save();
    g.transform(ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y);
    if (img.current) g.drawImage(img.current, 0, 0, map.cols, map.rows);
    else { g.fillStyle = '#1e3b33'; g.fillRect(0, 0, map.cols, map.rows); }
    if (map.showGrid) {
      g.strokeStyle = 'rgba(242,234,216,0.16)';
      g.lineWidth = 1 / (T / 2 * cam.z);
      g.beginPath();
      for (let x = 0; x <= map.cols; x++) { g.moveTo(x, 0); g.lineTo(x, map.rows); }
      for (let y = 0; y <= map.rows; y++) { g.moveTo(0, y); g.lineTo(map.cols, y); }
      g.stroke();
    }
    const fill = (cells: Cell[], color: string) => { g.fillStyle = color; for (const k of cells) g.fillRect(k.x, k.y, 1, 1); };
    if (overlay) { fill(overlay.reach, 'rgba(108,196,161,0.22)'); fill(overlay.area, 'rgba(240,181,82,0.45)'); }
    if (hover) { g.strokeStyle = '#6cc4a1'; g.lineWidth = 2 / (T / 2 * cam.z); g.strokeRect(hover.x, hover.y, 1, 1); }
    for (const ob of objects) {
      const flat = FLAT[ob.kind];
      if (flat && heightOf(ob) === 0) { g.fillStyle = flat; g.fillRect(ob.x, ob.y, ob.w, ob.h); }
    }
    if (map.fogEnabled) {
      g.fillStyle = gm ? 'rgba(6,5,12,0.55)' : '#0c0a08';
      for (let i = 0; i < map.fog.length; i++) if (map.fog[i] === '1') g.fillRect(i % map.cols, Math.floor(i / map.cols), 1, 1);
    }
    g.restore();

    // Standing things, back to front.
    type Item = { depth: number; draw: () => void };
    const items: Item[] = [];
    for (const ob of objects) {
      const h = ob.open ? 0 : heightOf(ob);
      if (h === 0) continue;
      const colors = FACE[ob.kind] ?? ['#8f8577', '#6d655a', '#5a534a'];
      const corners = [[ob.x, ob.y], [ob.x + ob.w, ob.y], [ob.x + ob.w, ob.y + ob.h], [ob.x, ob.y + ob.h]] as const;
      const rc = corners.map(([x, y]) => R(x, y));
      const depth = Math.max(...rc.map(([a, b]) => a + b));
      items.push({ depth, draw: () => {
        const ground = corners.map(([x, y]) => P(x, y));
        const top = corners.map(([x, y]) => P(x, y, h));
        // The two faces toward the viewer are the ones whose ground edge is lowest on screen.
        const faces = [0, 1, 2, 3].map((i) => ({ i, y: (ground[i].y + ground[(i + 1) % 4].y) / 2 })).sort((a, b) => a.y - b.y).slice(2);
        for (const f of faces) {
          const j = (f.i + 1) % 4;
          const dx = ground[j].x - ground[f.i].x;
          g.fillStyle = dx > 0 ? colors[1] : colors[2];
          g.beginPath(); g.moveTo(ground[f.i].x, ground[f.i].y); g.lineTo(ground[j].x, ground[j].y); g.lineTo(top[j].x, top[j].y); g.lineTo(top[f.i].x, top[f.i].y); g.closePath(); g.fill();
        }
        g.fillStyle = colors[0];
        g.beginPath(); top.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1; g.stroke();
      } });
    }
    for (const t of tokens) {
      const cx = t.x + t.size / 2, cy = t.y + t.size / 2;
      const [rx, ry] = R(cx, cy);
      items.push({ depth: rx + ry + 0.01, draw: () => {
        const base = P(cx, cy), up = P(cx, cy, t.elevation ?? 0);
        const r = T * 0.32 * t.size * cam.z;
        const ov = overlay?.tokens[t.id];
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.beginPath(); g.ellipse(base.x, base.y, r, r / 2, 0, 0, Math.PI * 2); g.fill();
        if ((t.elevation ?? 0) !== 0) { g.strokeStyle = 'rgba(242,234,216,0.5)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(base.x, base.y); g.lineTo(up.x, up.y); g.stroke(); g.setLineDash([]); }
        const discY = up.y - r * 1.1;
        if (ov) { g.strokeStyle = ov.color; g.lineWidth = 3; g.beginPath(); g.ellipse(base.x, base.y, r * 0.95, r * 0.48, 0, 0, Math.PI * 2); g.stroke(); }
        if (ov?.turn) { g.strokeStyle = '#f0b552'; g.lineWidth = 4; g.beginPath(); g.ellipse(up.x, up.y, r * 1.15, r * 0.58, 0, 0, Math.PI * 2); g.stroke(); }
        g.globalAlpha = t.hidden ? 0.55 : ov && (ov.c.defeated || ov.c.dead) ? 0.4 : 1;
        g.fillStyle = t.color;
        g.beginPath(); g.arc(up.x, discY, r, 0, Math.PI * 2); g.fill();
        const face = pictures[t.id] ? faces.current.get(t.id) : undefined;
        if (face) { g.save(); g.clip(); g.drawImage(face, up.x - r, discY - r, r * 2, r * 2); g.restore(); g.beginPath(); g.arc(up.x, discY, r, 0, Math.PI * 2); }
        g.lineWidth = t.id === selected || overlay?.targets.has(t.id) ? 4 : 2;
        g.strokeStyle = overlay?.targets.has(t.id) ? '#d4505e' : t.id === selected ? '#6cc4a1' : '#0b0908';
        g.stroke();
        g.fillStyle = '#0b0908';
        g.font = `600 ${Math.max(11, r * 0.9)}px 'LXGW WenKai TC', serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        if (!face) g.fillText([...t.name.trim()][0] ?? '?', up.x, discY);
        g.globalAlpha = 1;
        g.font = `500 ${Math.max(10, 11 * cam.z)}px 'Noto Sans TC', sans-serif`;
        g.fillStyle = '#f2ead8';
        g.fillText(t.name + ((t.elevation ?? 0) ? `（${t.elevation} ${map.unit}）` : ''), up.x, discY + r + 10);
        if (ov && overlay && overlay.teams.length > 2) { g.fillStyle = ov.color; g.fillText(ov.team, up.x, discY + r + 10 + Math.max(11, 12 * cam.z)); }
        if (ov && ov.c.hp !== null && ov.c.maxHp) {
          const w = r * 1.8, pct = Math.max(0, ov.c.hp / ov.c.maxHp);
          g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(up.x - w / 2, discY - r - 9, w, 5);
          g.fillStyle = pct <= 0.25 ? '#d4505e' : '#6cc4a1'; g.fillRect(up.x - w / 2, discY - r - 9, w * pct, 5);
        }
      } });
    }
    items.sort((a, b) => a.depth - b.depth).forEach((i) => i.draw());
  });

  // ---------- input ----------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: 'pan'; sx: number; sy: number; cam: Cam; moved: boolean } | { kind: 'pinch'; d: number; cam: Cam } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => { const r = canvas.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const inside = (c: Cell) => c.x >= 0 && c.y >= 0 && c.x < map.cols && c.y < map.rows;
  const zoom = (px: number, py: number, z: number, from: Cam = cam) => {
    const nz = Math.max(0.2, Math.min(3, z));
    setCam({ z: nz, x: px - (px - from.x) * (nz / from.z), y: py - (py - from.y) * (nz / from.z) });
  };
  const click = (sx: number, sy: number) => {
    const t = tokenAt(sx, sy);
    const cell = unproject(sx, sy);
    if (t && overlay?.pickToken && overlay.targets.has(t.id)) return overlay.pickToken(t.id);
    if (overlay?.pickCell && inside(cell)) return overlay.pickCell(cell);
    if (t) return onSelect(t.id);
    const sel = tokens.find((x) => x.id === selected);
    if (sel && canMove(sel) && inside(cell)) return onMove(sel, { x: Math.min(cell.x, map.cols - sel.size), y: Math.min(cell.y, map.rows - sel.size) });
    onSelect(null);
  };

  return (
    <div className="iso" ref={wrap}>
      <canvas ref={canvas} style={{ width: size.w, height: size.h }} aria-label="斜視地圖：點代幣選取，再點地面移動；拖曳平移，滾輪或兩指縮放"
        onPointerDown={(e) => {
          canvas.current!.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            gesture.current = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), cam };
          } else gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, cam, moved: false };
        }}
        onPointerMove={(e) => {
          const p = local(e);
          const cell = unproject(p.x, p.y);
          setHover(inside(cell) ? cell : null);
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          const g = gesture.current;
          if (g?.kind === 'pinch' && pointers.current.size >= 2) {
            const [a, b] = [...pointers.current.values()];
            zoom(size.w / 2, size.h / 2, g.cam.z * (Math.hypot(a.x - b.x, a.y - b.y) / g.d), g.cam);
          } else if (g?.kind === 'pan') {
            g.moved ||= Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 4;
            if (g.moved) setCam({ ...g.cam, x: g.cam.x + e.clientX - g.sx, y: g.cam.y + e.clientY - g.sy });
          }
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          const g = gesture.current;
          if (pointers.current.size > 0) return;
          gesture.current = null;
          if (g?.kind === 'pan' && !g.moved) { const p = local(e); click(p.x, p.y); }
        }}
        onPointerCancel={(e) => { pointers.current.delete(e.pointerId); gesture.current = null; }}
        onPointerLeave={() => setHover(null)}
        onWheel={(e) => { const p = local(e); zoom(p.x, p.y, cam.z * Math.exp(-e.deltaY * 0.0015)); }} />
      <div className="iso-tools" role="group" aria-label="斜視角度">
        <button type="button" className="icon" aria-label="向左轉" data-tip="向左轉" onClick={() => setRot((r) => (r + 3) % 4)}><span aria-hidden>⟲</span></button>
        <button type="button" className="icon" aria-label="向右轉" data-tip="向右轉" onClick={() => setRot((r) => (r + 1) % 4)}><span aria-hidden>⟳</span></button>
      </div>
    </div>
  );
}
