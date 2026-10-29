import { useEffect, useRef, useState } from 'react';
import {
  body, corners, dot, launch, reading, restingOn, rotate, settleFlat, shapeOf, step, steer, tumble, STEP,
  type Body, type Tray, type Vec,
} from './dicePhysics';

/**
 * A little dice tray drawn in 3D on a canvas. In `throw` mode the player picks the dice up (press on the tray),
 * shakes them (move while pressing) and lets go to throw; the dice fly with the speed of the flick and bounce off
 * the walls. The server rolls at the moment of the throw, and the dice are steered to land on those faces before
 * they stop. In `auto` mode the dice are thrown by themselves onto values already rolled (someone else's roll).
 */

export type Tone = 'ivory' | 'garnet' | 'jade';
export interface DiceTrayProps {
  dice: { sides: number }[];
  mode: 'throw' | 'auto';
  /** auto: the faces to land on. */
  values?: number[];
  /** throw: sends the throw; resolves to the rolled faces (one per die) or null if it failed. */
  onThrow?: () => Promise<number[] | null>;
  /** Called once the dice have stopped on their faces. */
  onSettled?: (values: number[]) => void;
  /** No tumbling: the dice just show their faces (reduced motion, or the player turned animations off). */
  instant?: boolean;
  tone?: Tone;
  /** Which die decides (advantage keeps one of two); the others are dimmed once they land. */
  kept?: boolean[];
  label?: string;
  small?: boolean;
}

const TRAY: Tray = { w: 10, d: 6 };
const WALL = 1.1;
const HAND_Z = 3;
const TONES: Record<Tone, { face: [number, number, number]; ink: string; edge: string }> = {
  ivory: { face: [242, 234, 216], ink: '#2a1d14', edge: 'rgba(60,40,25,0.55)' },
  garnet: { face: [196, 72, 86], ink: '#fff4f0', edge: 'rgba(60,10,20,0.6)' },
  jade: { face: [108, 196, 161], ink: '#0f241d', edge: 'rgba(10,40,30,0.55)' },
};
const LIGHT = unit3([-0.35, -0.55, 1]);

let font = '';
function uiFont() { return (font ||= getComputedStyle(document.body).getPropertyValue('--ui').trim() || 'sans-serif'); }

function unit3(v: Vec): Vec { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

/** A fixed camera above the near edge of the tray, looking down at it. */
function camera(width: number, height: number) {
  const eye: Vec = [0, -8.5, 11.5];
  const target: Vec = [0, 0.4, 0];
  const f = unit3([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const r = unit3([f[1], -f[0], 0]);
  const u: Vec = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const raw = (p: Vec) => {
    const d: Vec = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const z = dot(d, f);
    return { x: dot(d, r) / z, y: -dot(d, u) / z, z };
  };
  // Fit the tray with its walls into the canvas.
  const box = [[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([sx, sy]) => [0, WALL].map((z) => raw([(sx * TRAY.w) / 2, (sy * TRAY.d) / 2, z])));
  const minX = Math.min(...box.map((b) => b.x)), maxX = Math.max(...box.map((b) => b.x));
  const minY = Math.min(...box.map((b) => b.y)), maxY = Math.max(...box.map((b) => b.y));
  const focal = Math.min((width * 0.96) / (maxX - minX), (height * 0.94) / (maxY - minY));
  const cx = width / 2 - ((minX + maxX) / 2) * focal, cy = height / 2 - ((minY + maxY) / 2) * focal;
  const project = (p: Vec) => { const q = raw(p); return { x: cx + q.x * focal, y: cy + q.y * focal, z: q.z }; };
  /** The point on the plane z = h under a pixel. */
  const unproject = (sx: number, sy: number, h: number): Vec => {
    const nx = (sx - cx) / focal, ny = (sy - cy) / focal;
    const dir: Vec = [f[0] + r[0] * nx - u[0] * ny, f[1] + r[1] * nx - u[1] * ny, f[2] + r[2] * nx - u[2] * ny];
    const t = (h - eye[2]) / dir[2];
    return [eye[0] + dir[0] * t, eye[1] + dir[1] * t, h];
  };
  return { eye, project, unproject };
}
type Camera = ReturnType<typeof camera>;

function quad(ctx: CanvasRenderingContext2D, cam: Camera, pts: Vec[], fill: string | CanvasGradient, stroke?: string) {
  ctx.beginPath();
  pts.forEach((p, i) => { const s = cam.project(p); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function drawTray(ctx: CanvasRenderingContext2D, cam: Camera, front: boolean) {
  const w = TRAY.w / 2, d = TRAY.d / 2, h = WALL;
  if (!front) {
    // Back and side walls (their inner faces), then the felt.
    quad(ctx, cam, [[-w, d, 0], [w, d, 0], [w, d, h], [-w, d, h]], '#3a2c22');
    quad(ctx, cam, [[-w, -d, 0], [-w, d, 0], [-w, d, h], [-w, -d, h]], '#2f241c');
    quad(ctx, cam, [[w, -d, 0], [w, -d, h], [w, d, h], [w, d, 0]], '#2f241c');
    const a = cam.project([0, d, 0]), b = cam.project([0, -d, 0]);
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, '#1a3530'); g.addColorStop(1, '#285046');
    quad(ctx, cam, [[-w, -d, 0], [w, -d, 0], [w, d, 0], [-w, d, 0]], g);
    return;
  }
  // The near wall is drawn as a low rim so it never hides the dice.
  quad(ctx, cam, [[-w, -d, 0], [w, -d, 0], [w, -d, 0.35], [-w, -d, 0.35]], 'rgba(58,44,34,0.85)');
  ctx.strokeStyle = 'rgba(240,181,82,0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ([[-w, -d], [w, -d], [w, d], [-w, d]] as [number, number][]).forEach(([x, y], i) => {
    const s = cam.project([x, y, y < 0 ? 0.35 : h]);
    if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
  });
  ctx.closePath();
  ctx.stroke();
}

function drawDie(ctx: CanvasRenderingContext2D, cam: Camera, b: Body, tone: Tone, dim: boolean, glow: boolean, dpr: number) {
  const sh = shapeOf(b.sides);
  const world = corners(b);
  const t = TONES[tone];
  // Shadow on the felt, softer the higher the die is.
  const lift = Math.max(0, b.p[2] - sh.radius * 0.6);
  const sc = cam.project([b.p[0], b.p[1], 0]);
  const edge = cam.project([b.p[0] + sh.radius, b.p[1], 0]);
  const rad = Math.abs(edge.x - sc.x) * (1 + lift * 0.15);
  ctx.fillStyle = `rgba(0,0,0,${Math.max(0.08, 0.35 - lift * 0.05)})`;
  ctx.beginPath();
  ctx.ellipse(sc.x + lift * 2, sc.y + lift, rad, rad * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = dim ? 0.45 : 1;
  sh.faces.forEach((face, fi) => {
    const n = rotate(b.q, sh.normals[fi]);
    const c = rotate(b.q, sh.centers[fi]);
    const centre: Vec = [b.p[0] + c[0], b.p[1] + c[1], b.p[2] + c[2]];
    const toEye: Vec = [cam.eye[0] - centre[0], cam.eye[1] - centre[1], cam.eye[2] - centre[2]];
    if (dot(n, toEye) <= 0) return;
    const light = 0.5 + 0.5 * Math.max(0, dot(n, LIGHT));
    const [r, g, bl] = t.face.map((x) => Math.round(x * light));
    ctx.beginPath();
    face.forEach((vi, k) => { const s = cam.project(world[vi]); if (k) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
    ctx.closePath();
    ctx.fillStyle = `rgb(${r},${g},${bl})`;
    ctx.fill();
    ctx.strokeStyle = glow && fi === topFace(b) ? '#f0b552' : t.edge;
    ctx.lineWidth = glow && fi === topFace(b) ? 2.5 : 1;
    ctx.stroke();
    // Numbers lie on the face: map a flat text box onto the face's plane.
    const facing = dot(n, unit3(toEye));
    if (facing < 0.15) return;
    const up0 = rotate(b.q, sh.verts[face[0]]);
    const labels: { text: string; at: Vec; up: Vec; size: number }[] = [];
    if (b.sides === 4) {
      face.forEach((vi) => {
        const v = rotate(b.q, sh.verts[vi]);
        const dir = unit3([v[0] - c[0], v[1] - c[1], v[2] - c[2]]);
        labels.push({ text: String(b.cornerValues![vi]), at: [centre[0] + dir[0] * 0.3, centre[1] + dir[1] * 0.3, centre[2] + dir[2] * 0.3], up: dir, size: 0.26 });
      });
    } else {
      const up = unit3([up0[0] - c[0], up0[1] - c[1], up0[2] - c[2]]);
      const v = b.values[fi];
      labels.push({ text: v === 6 || v === 9 ? `${v}.` : String(v), at: centre, up, size: b.sides === 6 ? 0.62 : b.sides === 20 ? 0.36 : b.sides === 12 ? 0.42 : 0.44 });
    }
    for (const l of labels) {
      const right: Vec = [l.up[1] * n[2] - l.up[2] * n[1], l.up[2] * n[0] - l.up[0] * n[2], l.up[0] * n[1] - l.up[1] * n[0]];
      const o = cam.project(l.at);
      const px = cam.project([l.at[0] + right[0], l.at[1] + right[1], l.at[2] + right[2]]);
      const py = cam.project([l.at[0] - l.up[0], l.at[1] - l.up[1], l.at[2] - l.up[2]]);
      const K = 100;
      ctx.save();
      ctx.setTransform(((px.x - o.x) / K) * dpr, ((px.y - o.y) / K) * dpr, ((py.x - o.x) / K) * dpr, ((py.y - o.y) / K) * dpr, o.x * dpr, o.y * dpr);
      ctx.fillStyle = t.ink;
      ctx.font = `600 ${l.size * K}px ${uiFont()}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(l.text, 0, 0);
      ctx.restore();
    }
  });
  ctx.globalAlpha = 1;
}

function topFace(b: Body) {
  const sh = shapeOf(b.sides);
  if (b.sides === 4) return -1;
  let best = 0, top = -Infinity;
  sh.normals.forEach((n, i) => { const z = rotate(b.q, n)[2]; if (z > top) { top = z; best = i; } });
  return best;
}

/** Where dice wait before a throw: in a loose row near the left wall. */
function restingRow(dice: { sides: number }[], seed: number): Body[] {
  return dice.map((d, i) => {
    const b = body(d.sides, [-3.2 + (i % 4) * 1.5, 0.8 - Math.floor(i / 4) * 1.5, 1.5]);
    restingOn(b, b.sides === 4 ? 4 : shapeOf(b.sides).values.length, seed + i * 1.7);
    return b;
  });
}

type Phase = 'ready' | 'holding' | 'flying' | 'settling' | 'done';

export function DiceTray({ dice, mode, values, onThrow, onSettled, instant, tone = 'ivory', kept, label, small }: DiceTrayProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>(mode === 'auto' ? 'flying' : 'ready');
  const [result, setResult] = useState<number[] | null>(null);
  const state = useRef({
    bodies: [] as Body[],
    phase: (mode === 'auto' ? 'flying' : 'ready') as Phase,
    want: null as number[] | null,
    steered: false,
    hand: [0, 0, HAND_Z] as Vec,
    trail: [] as { p: Vec; t: number }[],
    flat: 0,
    failed: false,
  });
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const key = dice.map((d) => d.sides).join(',');

  const go = (p: Phase) => { state.current.phase = p; setPhase(p); };

  // Set the dice up: resting in a row for a throw, or already in the air for someone else's roll.
  useEffect(() => {
    const s = state.current;
    const seed = (values ?? []).reduce((a, v, i) => a + v * (i + 3), 7);
    s.bodies = restingRow(dice, seed);
    s.want = null; s.steered = false; s.flat = 0; s.failed = false;
    setResult(null);
    if (mode === 'auto' && values) {
      if (instant) {
        s.bodies.forEach((b, i) => restingOn(b, values[i], seed + i));
        finish(values);
        return;
      }
      s.bodies.forEach((b, i) => {
        b.p = [-3.8 + (i % 3) * 0.5, -1.5 + (i % 4) * 0.9, 2.4 + (i % 2) * 0.6];
        b.q = tumble(seed + i * 13);
        launch(b, [11 + ((seed + i * 5) % 5), 1.5 - ((seed * (i + 1)) % 4), 2], [((seed + i) % 9) - 4, 8, ((seed * 3 + i) % 7) - 3]);
      });
      s.want = values;
      steer(s.bodies, TRAY, values);
      s.steered = true;
      go('flying');
    } else go('ready');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, mode, (values ?? []).join(',')]);

  function finish(v: number[]) {
    state.current.phase = 'done';
    setPhase('done');
    setResult(v);
    const cb = settledRef.current;
    setTimeout(() => cb?.(v), 650);
  }

  // The loop: physics in fixed steps, then a redraw.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let raf = 0, last = performance.now(), acc = 0, shake = 0;
    const frame = (now: number) => {
      const s = state.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = el.clientWidth, h = el.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
      const cam = camera(w, h);
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      if (s.phase === 'holding') {
        // In the hand: the dice gather under the pointer and rattle.
        shake += 1;
        s.bodies.forEach((b, i) => {
          const off = [(i % 3) - 1, Math.floor(i / 3) - 0.5];
          b.p = [s.hand[0] + off[0] * 0.9 + Math.sin(shake * 0.7 + i) * 0.12, s.hand[1] + off[1] * 0.9 + Math.cos(shake * 0.9 + i) * 0.12, HAND_Z];
          b.q = tumble(shake * 0.05 + i * 31);
        });
        acc = 0;
      } else if (s.phase === 'flying' || s.phase === 'settling') {
        while (acc >= STEP) { step(s.bodies, TRAY); acc -= STEP; }
        if (s.phase === 'flying' && s.bodies.every((b) => b.asleep)) {
          if (s.want && s.steered) {
            go('settling');
          } else if (s.want && !s.steered) {
            // The roll came back after the dice stopped: give them a small hop and land them on it.
            s.bodies.forEach((b, i) => launch(b, [1.5 - i, 0.8, 6], [6, -4 + i, 3]));
            steer(s.bodies, TRAY, s.want);
            s.steered = true;
          }
        }
        if (s.phase === 'settling') {
          s.bodies.forEach((b) => settleFlat(b, 0.35));
          if (++s.flat > 10) finish(s.bodies.map(reading));
        }
      } else acc = 0;

      const ctx = el.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      drawTray(ctx, cam, false);
      const order = s.bodies.map((b, i) => ({ b, i, z: cam.project(b.p).z })).sort((a, c) => c.z - a.z);
      const done = s.phase === 'done';
      for (const { b, i } of order) drawDie(ctx, cam, b, tone, done && kept ? kept[i] === false : false, done && (kept ? kept[i] !== false : true), dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawTray(ctx, cam, true);
      // Once they stop, each die's number floats above it, big enough to read on a phone.
      if (done) {
        for (const { b, i } of order) {
          const at = cam.project([b.p[0], b.p[1], b.p[2] + shapeOf(b.sides).radius + 0.5]);
          const text = String(reading(b));
          const size = small ? 14 : 20;
          ctx.font = `600 ${size}px ${uiFont()}`;
          const w = ctx.measureText(text).width + size;
          const dropped = kept ? kept[i] === false : false;
          ctx.globalAlpha = dropped ? 0.5 : 1;
          ctx.fillStyle = dropped ? 'rgba(28,22,19,0.9)' : '#f0b552';
          ctx.beginPath();
          ctx.roundRect(at.x - w / 2, at.y - size * 0.85, w, size * 1.6, size * 0.5);
          ctx.fill();
          ctx.fillStyle = dropped ? '#b3a48d' : '#16110e';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, at.x, at.y);
          ctx.globalAlpha = 1;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [tone, kept, small]);

  // ---- the throw ----
  const toWorld = (e: React.PointerEvent | PointerEvent): Vec => {
    const el = canvas.current!;
    const r = el.getBoundingClientRect();
    const p = camera(r.width, r.height).unproject(e.clientX - r.left, e.clientY - r.top, HAND_Z);
    return [Math.max(-TRAY.w / 2 + 1, Math.min(TRAY.w / 2 - 1, p[0])), Math.max(-TRAY.d / 2 + 1, Math.min(TRAY.d / 2 - 1, p[1])), HAND_Z];
  };
  const pick = (at: Vec) => {
    const s = state.current;
    s.hand = at;
    s.trail = [{ p: at, t: performance.now() }];
    go('holding');
  };
  const release = () => {
    const s = state.current;
    if (s.phase !== 'holding') return;
    const now = performance.now();
    const old = s.trail.find((x) => now - x.t < 120) ?? s.trail[0];
    const dt = Math.max(0.016, (now - old.t) / 1000);
    let vx = (s.hand[0] - old.p[0]) / dt, vy = (s.hand[1] - old.p[1]) / dt;
    let speed = Math.hypot(vx, vy);
    if (speed < 3) {
      // A tap or a still hand: toss toward the middle.
      vx = -s.hand[0] * 2 + 7 * (s.hand[0] < 1 ? 1 : -1); vy = -s.hand[1] * 2 + 1.5;
      speed = Math.hypot(vx, vy);
    }
    const k = Math.min(1, 22 / speed) * Math.max(1, 7 / speed);
    vx *= k; vy *= k;
    const seed = now % 1000;
    s.bodies.forEach((b, i) => launch(b, [vx + (i - 0.5) * 1.2, vy + ((seed + i * 7) % 3) - 1, 2.5], [-vy * 0.9 + ((seed * (i + 2)) % 7) - 3, vx * 0.9 + ((seed + i) % 5) - 2, ((seed * 3) % 9) - 4]));
    s.want = null; s.steered = false; s.flat = 0;
    go('flying');
    void onThrow?.().then((v) => {
      if (!v) { s.failed = true; s.bodies = restingRow(dice, seed); go('ready'); return; }
      s.want = v;
      if (instant) { s.bodies.forEach((b, i) => restingOn(b, v[i], seed + i)); finish(v); return; }
      if (!s.bodies.every((b) => b.asleep)) { steer(s.bodies, TRAY, v); s.steered = true; }
    });
  };
  const interactive = mode === 'throw' && (phase === 'ready' || phase === 'holding');

  return (
    <div className={`dice-tray${small ? ' small' : ''}`}>
      <canvas ref={canvas} className={`dice-canvas${interactive ? ' grab' : ''}${phase === 'holding' ? ' holding' : ''}`}
        role={mode === 'throw' ? 'button' : 'img'} tabIndex={interactive ? 0 : -1}
        aria-label={mode === 'throw' ? `${label ?? '擲骰'}：按住盤子拖曳、放開丟出骰子，或按空白鍵` : `${label ?? '擲骰'}${result ? `：${result.join('、')}` : ''}`}
        onPointerDown={(e) => { if (!interactive) return; e.currentTarget.setPointerCapture(e.pointerId); pick(toWorld(e)); }}
        onPointerMove={(e) => {
          const s = state.current;
          if (s.phase !== 'holding') return;
          s.hand = toWorld(e);
          s.trail.push({ p: s.hand, t: performance.now() });
          if (s.trail.length > 12) s.trail.shift();
        }}
        onPointerUp={release} onPointerCancel={release}
        onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat && state.current.phase === 'ready' && mode === 'throw') { e.preventDefault(); pick([-3, 0, HAND_Z]); } }}
        onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); const s = state.current; if (s.phase === 'holding') { s.trail = [{ p: [-4.5, -0.5, HAND_Z], t: performance.now() - 80 }]; release(); } } }} />
      {mode === 'throw' && phase === 'ready' && <p className="dice-hint">{state.current.failed ? '沒有送出，再丟一次' : '按住盤子、甩一下放開'}</p>}
      {mode === 'throw' && phase === 'holding' && <p className="dice-hint">放開就丟出</p>}
    </div>
  );
}
