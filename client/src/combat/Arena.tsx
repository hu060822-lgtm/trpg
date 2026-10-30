import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { DodgeSim, FINE_MARK, fineChar, playMoves, simFor, TICKS_PER_SECOND } from '../../../src/encounter/dodge';
import type { DodgeSetup } from '../../../src/encounter/types';

/**
 * The dodge arena: a knot of thread (the player) inside a loom frame, needles and threads flying at it. The same
 * simulation the server replays runs here, tick by tick, so what the player sees is what gets counted.
 */

const KEY_DIR: Record<string, [number, number]> = {
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
};
const COLORS = {
  normal: { bg: '#10201b', frame: '#3c6a5c', bullet: '#f2ead8', laserWarn: 'rgba(240,181,82,0.35)', laser: '#f0b552', knot: '#6cc4a1', hurt: '#d4505e' },
  contrast: { bg: '#000000', frame: '#ffffff', bullet: '#ffe600', laserWarn: 'rgba(255,255,255,0.4)', laser: '#ff3b30', knot: '#00e0ff', hurt: '#ff3b30' },
};

/** Draws the arena. `alpha` (0–1) is how far the clock is past the last tick, so motion reads smooth between ticks. */
export function drawArena(g: CanvasRenderingContext2D, sim: DodgeSim, px: number, contrast: boolean, alpha = 1, target?: { x: number; y: number } | null) {
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
  // Needles move in straight lines, so drawing them a fraction of a tick back along their path is exact.
  const back = 1 - alpha;
  for (const b of sim.bullets) {
    if (b.born > sim.tick) continue;
    const t = b.born >= sim.tick - 1 ? 0 : back;
    g.beginPath();
    g.arc((b.x - b.vx * t) * m, (b.y - b.vy * t) * m, Math.max(2, b.r * m), 0, Math.PI * 2);
    g.fill();
  }
  const kx = sim.prevX + (sim.x - sim.prevX) * alpha, ky = sim.prevY + (sim.y - sim.prevY) * alpha;
  if (target) {
    g.strokeStyle = contrast ? 'rgba(255,255,255,0.5)' : 'rgba(108,196,161,0.45)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(target.x * m, target.y * m, Math.max(5, 14 * s), 0, Math.PI * 2);
    g.stroke();
  }
  // The knot flickers while it cannot be hit again.
  if (sim.invulnerable === 0 || Math.floor(sim.tick / 4) % 2 === 0) {
    g.fillStyle = sim.invulnerable > 0 ? c.hurt : c.knot;
    g.beginPath();
    g.arc(kx * m, ky * m, Math.max(4, 10 * s), 0, Math.PI * 2);
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
 * Plays a dodge. Pointer or finger: press anywhere in the arena and drag; the knot follows the drag one-to-one (as
 * fast as it can move), so the finger never has to cover it. Keyboard: arrows or WASD, Shift to move at half speed.
 * Input is recorded as one of 32 directions at full or half speed each tick (see FINE_ALPHABET).
 */
export function DodgePlay({ setup, seed, contrast, onDone }: { setup: DodgeSetup; seed: number; contrast: boolean; onDone: (moves: string, hits: number) => void }) {
  const { wrap, canvas, px } = useSquareCanvas();
  const [hits, setHits] = useState(0);
  const [left, setLeft] = useState(setup.duration);
  const keys = useRef(new Set<string>());
  const slow = useRef(false);
  // The pointer in arena milli-units, and the offset from it to where the knot was when the drag began.
  const grab = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);
  const simRef = useRef<DodgeSim | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const toArena = (e: ReactPointerEvent) => {
    const r = (e.target as HTMLElement).getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 1_000_000, y: ((e.clientY - r.top) / r.height) * 1_000_000 };
  };

  useEffect(() => {
    const sim = new DodgeSim(setup, seed, true);
    simRef.current = sim;
    let moves = FINE_MARK;
    let raf = 0;
    const start = performance.now();
    const target = () => {
      const p = grab.current;
      if (!p) return null;
      const { o, side } = sim.box;
      const lo = o * 1000, hi = (o + side) * 1000;
      return { x: Math.max(lo, Math.min(hi, p.x + p.ox)), y: Math.max(lo, Math.min(hi, p.y + p.oy)) };
    };
    const input = () => {
      const t = target();
      if (t) {
        const dx = t.x - sim.x, dy = t.y - sim.y, dist = Math.hypot(dx, dy);
        // Close enough: stop rather than jitter around the finger; a little further: creep at half speed.
        if (dist < sim.reach * 0.3) return '.';
        return fineChar(dx, dy, dist < sim.reach * 0.75);
      }
      let x = 0, y = 0;
      for (const k of keys.current) { const d = KEY_DIR[k]; if (d) { x += d[0]; y += d[1]; } }
      return fineChar(Math.sign(x), Math.sign(y), slow.current);
    };
    const frame = (now: number) => {
      const clock = Math.min(sim.total, ((now - start) * TICKS_PER_SECOND) / 1000);
      while (sim.tick < Math.floor(clock)) {
        const ch = input();
        moves += ch;
        sim.stepFine(ch);
      }
      const g = canvas.current?.getContext('2d');
      if (g) drawArena(g, sim, g.canvas.width, contrast, sim.done ? 1 : clock - Math.floor(clock), target());
      setHits(sim.hits);
      setLeft(Math.max(0, setup.duration - (sim.tick * 1000) / TICKS_PER_SECOND));
      if (sim.done) { done.current(moves, sim.hits); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const down = (e: KeyboardEvent) => {
      slow.current = e.shiftKey;
      if (KEY_DIR[e.code]) { e.preventDefault(); keys.current.add(e.code); }
    };
    const up = (e: KeyboardEvent) => { slow.current = e.shiftKey; keys.current.delete(e.code); };
    const blur = () => { keys.current.clear(); slow.current = false; };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('blur', blur);
    return () => { cancelAnimationFrame(raf); removeEventListener('keydown', down); removeEventListener('keyup', up); removeEventListener('blur', blur); };
  }, [setup, seed, contrast, canvas]);

  return (
    <div className="arena" ref={wrap}>
      <div className="arena-read" aria-live="off">
        <span>剩 {(left / 1000).toFixed(1)} 秒</span>
        <span className={hits ? 'hurt' : ''}>被打中 {hits} 次</span>
      </div>
      <canvas ref={canvas} width={px} height={px} style={{ width: px, height: px, touchAction: 'none' }} className="arena-canvas" aria-label="閃避場：在場內按住拖曳，線結會跟著移動；或用方向鍵、WASD，按住 Shift 慢走"
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const sim = simRef.current, p = toArena(e);
          grab.current = { id: e.pointerId, ...p, ox: sim ? sim.x - p.x : 0, oy: sim ? sim.y - p.y : 0 };
        }}
        onPointerMove={(e) => { const g = grab.current; if (g && g.id === e.pointerId) Object.assign(g, toArena(e)); }}
        onPointerUp={() => { grab.current = null; }} onPointerCancel={() => { grab.current = null; }} />
      <p className="hint arena-hint">按住場內任何地方拖曳，線結會跟著手指走；鍵盤用方向鍵或 WASD，按住 Shift 慢走。</p>
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
    const sim = simFor(setup, seed, moves);
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const clock = Math.min(sim.total, ((now - start) * TICKS_PER_SECOND) / 1000);
      playMoves(sim, moves, Math.floor(clock));
      const g = canvas.current?.getContext('2d');
      if (g) drawArena(g, sim, g.canvas.width, contrast, sim.done ? 1 : clock - Math.floor(clock));
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
