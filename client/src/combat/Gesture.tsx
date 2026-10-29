import { useEffect, useRef, useState } from 'react';
import { challengeFor, GESTURE_LIMIT_MS, GESTURE_TEXT, scoreGesture, swayAt, sweepPoints, thrustRadius, type Challenge } from '../../../src/encounter/weapons';
import type { GestureInput, InputSample, Interaction } from '../../../src/encounter/types';

/**
 * The weapon gesture, after the attack roll is already on the table. The pad shows the same challenge the server
 * builds from the step's seed; what the player does is recorded and sent, and the server scores it. The preview
 * score here is only a courtesy.
 */
export function GesturePad({ kind, seed, runes = 4, oneKey, contrast, onDone }: {
  kind: Exclude<Interaction, 'none'>; seed: number; runes?: number; oneKey: boolean; contrast: boolean; onDone: (input: GestureInput, preview: number) => void;
}) {
  const c = challengeFor(kind, seed, runes)!;
  return oneKey ? <OneKey c={c} kind={kind} onDone={onDone} /> : <Pointer c={c} kind={kind} contrast={contrast} onDone={onDone} />;
}

function Pointer({ c, kind, contrast, onDone }: { c: Challenge; kind: Exclude<Interaction, 'none'>; contrast: boolean; onDone: (input: GestureInput, preview: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [px, setPx] = useState(300);
  const start = useRef(performance.now());
  const samples = useRef<InputSample[]>([]);
  const pressAt = useRef<number | null>(null);
  const finished = useRef(false);
  const [, redraw] = useState(0);

  useEffect(() => {
    const el = wrap.current!;
    const fit = () => setPx(Math.max(220, Math.min(el.clientWidth, Math.round(window.innerHeight * 0.55), 480)));
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const now = () => Math.min(GESTURE_LIMIT_MS, Math.round(performance.now() - start.current));
  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    const input: GestureInput = { kind: 'pointer', samples: samples.current.slice(0, 600) };
    onDone(input, scoreGesture(c, input));
  };
  // Nothing done in time counts as nothing; the server would say the same at its deadline.
  useEffect(() => {
    const limit = c.kind === 'rune' ? c.limit : GESTURE_LIMIT_MS;
    const t = setTimeout(finish, limit);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The drawing loop: held gestures (thrust, draw) animate while pressed.
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      const g = canvas.current?.getContext('2d');
      if (g) paint(g, c, px, samples.current, pressAt.current === null ? null : now() - pressAt.current, contrast);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [px, contrast]);

  const at = (e: React.PointerEvent): InputSample => {
    const r = canvas.current!.getBoundingClientRect();
    return { t: now(), x: Math.round(((e.clientX - r.left) / r.width) * 1000), y: Math.round(((e.clientY - r.top) / r.height) * 1000), d: 1 };
  };
  const push = (s: InputSample) => {
    const last = samples.current.at(-1);
    if (last && s.t < last.t) s.t = last.t;
    if (samples.current.length < 600) samples.current.push(s);
  };

  return (
    <div className="gesture" ref={wrap}>
      <p className="gesture-how"><b>{GESTURE_TEXT[kind].name}</b>　{GESTURE_TEXT[kind].how}</p>
      <canvas ref={canvas} width={px} height={px} style={{ width: px, height: px }} className="gesture-canvas" aria-label={`${GESTURE_TEXT[kind].name}：${GESTURE_TEXT[kind].how}`}
        onPointerDown={(e) => {
          if (finished.current) return;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const s = at(e);
          pressAt.current = s.t;
          push(s);
          redraw((n) => n + 1);
        }}
        onPointerMove={(e) => { if (pressAt.current !== null && !finished.current) push(at(e)); }}
        onPointerUp={(e) => {
          if (pressAt.current === null || finished.current) return;
          push({ ...at(e), d: 0 });
          pressAt.current = null;
          // Runes take several strokes; everything else is one press.
          if (c.kind !== 'rune') finish();
        }} />
      {c.kind === 'rune' && <button onClick={finish}>符文畫好了</button>}
    </div>
  );
}

function paint(g: CanvasRenderingContext2D, c: Challenge, px: number, samples: InputSample[], held: number | null, contrast: boolean) {
  const s = px / 1000;
  const ink = contrast ? '#ffe600' : '#f0b552';
  const line = contrast ? '#00e0ff' : '#6cc4a1';
  g.fillStyle = contrast ? '#000' : '#10201b';
  g.fillRect(0, 0, px, px);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const dot = (x: number, y: number, r: number, fill: string) => { g.fillStyle = fill; g.beginPath(); g.arc(x * s, y * s, r * s, 0, Math.PI * 2); g.fill(); };
  const ring = (x: number, y: number, r: number, stroke: string, w = 6) => { g.strokeStyle = stroke; g.lineWidth = w * s; g.beginPath(); g.arc(x * s, y * s, Math.max(1, r * s), 0, Math.PI * 2); g.stroke(); };
  switch (c.kind) {
    case 'slash':
      g.strokeStyle = ink; g.lineWidth = 34 * s; g.globalAlpha = 0.28;
      g.beginPath(); g.moveTo(c.a.x * s, c.a.y * s); g.lineTo(c.b.x * s, c.b.y * s); g.stroke();
      g.globalAlpha = 1; g.lineWidth = 6 * s;
      g.beginPath(); g.moveTo(c.a.x * s, c.a.y * s); g.lineTo(c.b.x * s, c.b.y * s); g.stroke();
      dot(c.a.x, c.a.y, 16, ink);
      break;
    case 'sweep': {
      const pts = sweepPoints(c, 24);
      g.strokeStyle = ink; g.lineWidth = 40 * s; g.globalAlpha = 0.25;
      g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x * s, p.y * s) : g.moveTo(p.x * s, p.y * s))); g.stroke();
      g.globalAlpha = 1; g.lineWidth = 6 * s; g.stroke();
      dot(pts[0].x, pts[0].y, 16, ink);
      break;
    }
    case 'thrust':
      ring(500, 500, c.target, ink, 10);
      ring(500, 500, thrustRadius(c, held ?? 0), line, 6);
      dot(500, 500, 12, ink);
      break;
    case 'draw': {
      const power = held === null ? 0 : Math.min(1, held / c.full);
      g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(100 * s, 900 * s, 800 * s, 30 * s);
      g.fillStyle = power >= 1 ? ink : line; g.fillRect(100 * s, 900 * s, 800 * power * s, 30 * s);
      ring(500, 450, 250, 'rgba(255,255,255,0.2)', 3);
      ring(500, 450, 60, ink, 6);
      const off = held !== null && held >= c.full ? swayAt(c, held - c.full) : { x: 0, y: 0 };
      g.strokeStyle = line; g.lineWidth = 4 * s;
      const ax = 500 + off.x, ay = 450 + off.y;
      g.beginPath(); g.moveTo((ax - 40) * s, ay * s); g.lineTo((ax + 40) * s, ay * s); g.moveTo(ax * s, (ay - 40) * s); g.lineTo(ax * s, (ay + 40) * s); g.stroke();
      break;
    }
    case 'rune':
      c.points.forEach((p, i) => {
        ring(p.x, p.y, 70, 'rgba(240,181,82,0.35)', 3);
        dot(p.x, p.y, 34, ink);
        g.fillStyle = '#0b0908'; g.font = `600 ${Math.round(36 * s)}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(i + 1), p.x * s, p.y * s);
      });
      break;
  }
  // The player's own strokes.
  g.strokeStyle = line; g.lineWidth = 8 * s;
  g.beginPath();
  let pen = false;
  for (const p of samples) {
    if (p.d === 1) { if (pen) g.lineTo(p.x * s, p.y * s); else g.moveTo(p.x * s, p.y * s); pen = true; } else pen = false;
  }
  if (c.kind !== 'thrust' && c.kind !== 'draw') g.stroke();
}

/** The one-key form: a marker sweeps along a bar; press Space (or tap the bar) when it reaches the middle. */
function OneKey({ c, kind, onDone }: { c: Challenge; kind: Exclude<Interaction, 'none'>; onDone: (input: GestureInput, preview: number) => void }) {
  const start = useRef(performance.now());
  const presses = useRef<{ t: number; key: string }[]>([]);
  const finished = useRef(false);
  const [t, setT] = useState(0);
  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    const input: GestureInput = { kind: 'keys', presses: presses.current.slice(0, 40) };
    onDone(input, scoreGesture(c, input));
  };
  const press = (key: string) => {
    if (finished.current) return;
    presses.current.push({ t: Math.min(GESTURE_LIMIT_MS, Math.round(performance.now() - start.current)), key });
    if (c.kind !== 'rune' || presses.current.length >= c.points.length) finish();
  };
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      const now = performance.now() - start.current;
      setT(now);
      if (now >= (c.kind === 'rune' ? c.limit : GESTURE_LIMIT_MS)) { finish(); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const key = (e: KeyboardEvent) => {
      if (c.kind === 'rune' ? /^[1-9]$/.test(e.key) : e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); press(c.kind === 'rune' ? e.key : ' '); }
    };
    addEventListener('keydown', key);
    return () => { cancelAnimationFrame(raf); removeEventListener('keydown', key); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (c.kind === 'rune') {
    const n = presses.current.length;
    return (
      <div className="gesture one-key">
        <p className="gesture-how"><b>{GESTURE_TEXT[kind].name}</b>　{GESTURE_TEXT[kind].key}</p>
        <div className="row">
          {c.points.map((_, i) => <button key={i} className={i < n ? 'primary' : ''} onClick={() => press(String(i + 1))}>{i + 1}</button>)}
        </div>
        <p className="small muted">剩 {Math.max(0, (c.limit - t) / 1000).toFixed(1)} 秒</p>
      </div>
    );
  }
  // The cursor crosses the bar in 2 × beat; the middle of the bar is the beat.
  const period = c.beat * 2;
  return (
    <div className="gesture one-key">
      <p className="gesture-how"><b>{GESTURE_TEXT[kind].name}</b>　{GESTURE_TEXT[kind].key}</p>
      <button className="beat-bar" onClick={() => press(' ')} aria-label="在游標到中間時按下">
        <span className="beat-mark" />
        <span className="beat-cursor" style={{ left: `${Math.min(100, (t / period) * 100)}%` }} />
      </button>
      <p className="small muted">{t < c.beat ? '游標往中間走…' : '已經過了中間，越晚按加值越少'}</p>
    </div>
  );
}
