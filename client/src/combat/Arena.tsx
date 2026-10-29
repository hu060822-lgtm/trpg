import { useEffect, useRef, useState } from 'react';
import { DodgeSim, TICKS_PER_SECOND } from '../../../src/encounter/dodge';
import type { DodgeSetup } from '../../../src/encounter/types';

/**
 * The dodge arena: a knot of thread (the player) inside a loom frame, needles and threads flying at it. The same
 * simulation the server replays runs here, tick by tick, so what the player sees is what gets counted.
 */

// Directions 1–8 clockwise from up; 0 is standing still.
const KEY_DIR: Record<string, [number, number]> = {
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
};
export function dirOf(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  const a = Math.atan2(dy, dx); // 0 = right, positive = down
  const octant = (Math.round(a / (Math.PI / 4)) + 8) % 8; // 0 right, 1 down-right, 2 down …
  return [3, 4, 5, 6, 7, 8, 1, 2][octant];
}

const COLORS = {
  normal: { bg: '#10201b', frame: '#3c6a5c', bullet: '#f2ead8', laserWarn: 'rgba(240,181,82,0.35)', laser: '#f0b552', knot: '#6cc4a1', hurt: '#d4505e' },
  contrast: { bg: '#000000', frame: '#ffffff', bullet: '#ffe600', laserWarn: 'rgba(255,255,255,0.4)', laser: '#ff3b30', knot: '#00e0ff', hurt: '#ff3b30' },
};

export function drawArena(g: CanvasRenderingContext2D, sim: DodgeSim, px: number, contrast: boolean) {
  const c = contrast ? COLORS.contrast : COLORS.normal;
  const s = px / 1000; // arena units → canvas pixels
  const m = s / 1000; // milli-units → canvas pixels
  g.fillStyle = '#0b0908';
  g.fillRect(0, 0, px, px);
  const { o, side } = sim.box;
  g.fillStyle = c.bg;
  g.fillRect(o * s, o * s, side * s, side * s);
  // The loom's warp threads, faint, so movement reads against something.
  g.strokeStyle = contrast ? 'rgba(255,255,255,0.08)' : 'rgba(108,196,161,0.08)';
  g.lineWidth = 1;
  for (let x = o; x <= o + side; x += 50) { g.beginPath(); g.moveTo(x * s, o * s); g.lineTo(x * s, (o + side) * s); g.stroke(); }
  g.strokeStyle = c.frame;
  g.lineWidth = Math.max(2, 4 * s);
  g.strokeRect(o * s, o * s, side * s, side * s);
  for (const l of sim.lasers) {
    const warn = sim.tick < l.warnUntil;
    g.fillStyle = warn ? c.laserWarn : c.laser;
    const w = (warn ? Math.max(2, l.w / 6) : l.w) * s;
    if (l.vertical) g.fillRect(l.at * m - w / 2, o * s, w, side * s);
    else g.fillRect(o * s, l.at * m - w / 2, side * s, w);
  }
  g.fillStyle = c.bullet;
  for (const b of sim.bullets) {
    if (b.born > sim.tick) continue;
    g.beginPath();
    g.arc(b.x * m, b.y * m, Math.max(2, b.r * m), 0, Math.PI * 2);
    g.fill();
  }
  // The knot flickers while it cannot be hit again.
  if (sim.invulnerable === 0 || Math.floor(sim.tick / 4) % 2 === 0) {
    g.fillStyle = sim.invulnerable > 0 ? c.hurt : c.knot;
    g.beginPath();
    g.arc(sim.x * m, sim.y * m, Math.max(4, 10 * s), 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#0b0908';
    g.lineWidth = 2;
    g.stroke();
  }
}

function useSquareCanvas() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [px, setPx] = useState(320);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setPx(Math.max(200, Math.min(el.clientWidth, Math.round(window.innerHeight * 0.62), 560)));
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  return { wrap, canvas, px };
}

/**
 * Plays a dodge. Keyboard: arrows or WASD. Touch: put a finger anywhere on the arena and slide; the knot moves the
 * way the finger moved from where it touched down, so the finger never covers the knot.
 */
export function DodgePlay({ setup, seed, contrast, onDone }: { setup: DodgeSetup; seed: number; contrast: boolean; onDone: (moves: string, hits: number) => void }) {
  const { wrap, canvas, px } = useSquareCanvas();
  const [hits, setHits] = useState(0);
  const [left, setLeft] = useState(setup.duration);
  const keys = useRef(new Set<string>());
  const touch = useRef<{ id: number; x: number; y: number; dx: number; dy: number } | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const sim = new DodgeSim(setup, seed);
    let moves = '';
    let raf = 0;
    const start = performance.now();
    const dir = () => {
      const t = touch.current;
      if (t) return Math.hypot(t.dx, t.dy) < 10 ? 0 : dirOf(Math.abs(t.dx) < Math.abs(t.dy) * 0.4 ? 0 : t.dx, Math.abs(t.dy) < Math.abs(t.dx) * 0.4 ? 0 : t.dy);
      let x = 0, y = 0;
      for (const k of keys.current) { const d = KEY_DIR[k]; if (d) { x += d[0]; y += d[1]; } }
      return dirOf(Math.sign(x), Math.sign(y));
    };
    const frame = (now: number) => {
      const want = Math.min(sim.total, Math.floor(((now - start) * TICKS_PER_SECOND) / 1000));
      while (sim.tick < want) {
        const d = dir();
        moves += d;
        sim.step(d);
      }
      const g = canvas.current?.getContext('2d');
      if (g) drawArena(g, sim, g.canvas.width, contrast);
      setHits(sim.hits);
      setLeft(Math.max(0, setup.duration - (sim.tick * 1000) / TICKS_PER_SECOND));
      if (sim.done) { done.current(moves, sim.hits); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const down = (e: KeyboardEvent) => { if (KEY_DIR[e.code]) { e.preventDefault(); keys.current.add(e.code); } };
    const up = (e: KeyboardEvent) => { keys.current.delete(e.code); };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    return () => { cancelAnimationFrame(raf); removeEventListener('keydown', down); removeEventListener('keyup', up); };
  }, [setup, seed, contrast, canvas]);

  return (
    <div className="arena" ref={wrap}>
      <div className="arena-read" aria-live="off">
        <span>剩 {(left / 1000).toFixed(1)} 秒</span>
        <span className={hits ? 'hurt' : ''}>被打中 {hits} 次</span>
      </div>
      <canvas ref={canvas} width={px} height={px} style={{ width: px, height: px }} className="arena-canvas" aria-label="閃避場：用方向鍵、WASD，或手指在場內滑動移動線結"
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0 }; }}
        onPointerMove={(e) => { const t = touch.current; if (t && t.id === e.pointerId) { t.dx = e.clientX - t.x; t.dy = e.clientY - t.y; } }}
        onPointerUp={() => { touch.current = null; }} onPointerCancel={() => { touch.current = null; }} />
    </div>
  );
}

/** Replays a recorded dodge at its real speed, for the table to watch. Nothing here changes any result. */
export function DodgeReplay({ setup, seed, moves, contrast, onEnd }: { setup: DodgeSetup; seed: number; moves: string; contrast: boolean; onEnd?: () => void }) {
  const { wrap, canvas, px } = useSquareCanvas();
  const [hits, setHits] = useState(0);
  const [run, setRun] = useState(0);
  const end = useRef(onEnd);
  end.current = onEnd;
  useEffect(() => {
    const sim = new DodgeSim(setup, seed);
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const want = Math.min(sim.total, Math.floor(((now - start) * TICKS_PER_SECOND) / 1000));
      while (sim.tick < want) sim.step(Number(moves[sim.tick] ?? 0) || 0);
      const g = canvas.current?.getContext('2d');
      if (g) drawArena(g, sim, g.canvas.width, contrast);
      setHits(sim.hits);
      if (sim.done) { end.current?.(); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [setup, seed, moves, contrast, canvas, run]);
  return (
    <div className="arena" ref={wrap}>
      <div className="arena-read"><span>{setup.tier.label}・{setup.pattern.name}</span><span>被打中 {hits} 次</span></div>
      <canvas ref={canvas} width={px} height={px} style={{ width: px, height: px }} className="arena-canvas" aria-label="閃避重播" />
      <button className="small" onClick={() => setRun((r) => r + 1)}>從頭再看一次</button>
    </div>
  );
}

/** A still bot that stands in the middle: for previewing a pattern in the editor. */
export function PatternPreview({ setup, seed, contrast }: { setup: DodgeSetup; seed: number; contrast: boolean }) {
  return <DodgeReplay setup={setup} seed={seed} moves="" contrast={contrast} />;
}
