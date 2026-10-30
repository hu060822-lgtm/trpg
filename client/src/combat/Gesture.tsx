import { useEffect, useRef, useState } from 'react';
import { bowState, challengeFor, GESTURE_LIMIT_MS, GESTURE_TEXT, ringPoints, scoreGesture, sightAt, sweepPoints, throwLanding, type Challenge, type GestureKind, type Point } from '../../../src/encounter/weapons';
import type { GestureInput, InputSample } from '../../../src/encounter/types';

/**
 * The weapon gesture, after the attack roll is already on the table. The pad shows the same challenge the server
 * builds from the step's seed; what the player does is recorded and sent, and the server scores it. The preview
 * score here is only a courtesy.
 */
export function GesturePad({ kind, seed, runes = 4, oneKey, contrast, onDone }: {
  kind: GestureKind; seed: number; runes?: number; oneKey: boolean; contrast: boolean; onDone: (input: GestureInput, preview: number) => void;
}) {
  const c = challengeFor(kind, seed, runes)!;
  return oneKey ? <OneKey c={c} kind={kind} onDone={onDone} /> : <Pointer c={c} kind={kind} contrast={contrast} onDone={onDone} />;
}

function Pointer({ c, kind, contrast, onDone }: { c: Challenge; kind: GestureKind; contrast: boolean; onDone: (input: GestureInput, preview: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [px, setPx] = useState(300);
  // The clock starts at the first touch, so reading the instructions costs nothing.
  const start = useRef<number | null>(null);
  const samples = useRef<InputSample[]>([]);
  const pressAt = useRef<number | null>(null);
  const finished = useRef(false);
  const [left, setLeft] = useState<number | null>(null);
  const limit = c.kind === 'rune' ? c.limit : GESTURE_LIMIT_MS;

  useEffect(() => {
    const el = wrap.current!;
    const fit = () => setPx(Math.max(240, Math.min(el.clientWidth, Math.round(window.innerHeight * 0.58), 520)));
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const now = () => (start.current === null ? 0 : Math.min(GESTURE_LIMIT_MS, Math.round(performance.now() - start.current)));
  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    const input: GestureInput = { kind: 'pointer', samples: samples.current.slice(0, 600) };
    onDone(input, scoreGesture(c, input));
  };

  // The drawing loop; also runs out the clock once it has started.
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      const g = canvas.current?.getContext('2d');
      if (g) paint(g, c, px, samples.current, pressAt.current !== null, now(), contrast);
      if (start.current !== null && !finished.current) {
        const rest = limit - now();
        setLeft(rest);
        if (rest <= 0) finish();
      }
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
      <canvas ref={canvas} width={px} height={px} style={{ width: px, height: px }} className={`gesture-canvas g-${c.kind}`} aria-label={`${GESTURE_TEXT[kind].name}：${GESTURE_TEXT[kind].how}`}
        onPointerDown={(e) => {
          if (finished.current) return;
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          if (start.current === null) start.current = performance.now();
          const s = at(e);
          pressAt.current = s.t;
          push(s);
        }}
        onPointerMove={(e) => { if (pressAt.current !== null && !finished.current) push(at(e)); }}
        onPointerUp={(e) => {
          if (pressAt.current === null || finished.current) return;
          push({ ...at(e), d: 0 });
          pressAt.current = null;
          // The magic circle takes several strokes; everything else is one press.
          if (c.kind !== 'rune') finish();
        }}
        onPointerCancel={() => { pressAt.current = null; }} />
      <div className="row gesture-foot">
        <span className="small muted">{left === null ? '第一下按下去才開始計時' : `剩 ${Math.max(0, left / 1000).toFixed(1)} 秒`}</span>
        <span className="spacer" />
        {c.kind === 'rune' && <button className="primary" onClick={finish} disabled={left === null}>魔法陣畫好了</button>}
      </div>
    </div>
  );
}

const PALETTE = {
  normal: { bg: '#14231e', grid: 'rgba(108,196,161,0.07)', guide: '#f0b552', soft: 'rgba(240,181,82,0.22)', ink: '#6cc4a1', core: '#f2ead8', target: '#d4505e', magic: '#b98ae0' },
  contrast: { bg: '#000000', grid: 'rgba(255,255,255,0.1)', guide: '#ffe600', soft: 'rgba(255,230,0,0.3)', ink: '#00e0ff', core: '#ffffff', target: '#ff3b30', magic: '#ff6bff' },
};

/** The press in progress (or the last one), for the gestures that react while held. */
function lastStroke(samples: InputSample[]): InputSample[] {
  let i = samples.length - 1;
  if (i >= 0 && samples[i].d === 0) i--;
  let j = i;
  while (j > 0 && samples[j - 1].d === 1) j--;
  return i < 0 ? [] : samples.slice(j, i + 1);
}

function paint(g: CanvasRenderingContext2D, c: Challenge, px: number, samples: InputSample[], pressed: boolean, _t: number, contrast: boolean) {
  const k = contrast ? PALETTE.contrast : PALETTE.normal;
  const s = px / 1000;
  g.fillStyle = k.bg;
  g.fillRect(0, 0, px, px);
  g.strokeStyle = k.grid;
  g.lineWidth = 1;
  for (let x = 100; x < 1000; x += 100) { g.beginPath(); g.moveTo(x * s, 0); g.lineTo(x * s, px); g.moveTo(0, x * s); g.lineTo(px, x * s); g.stroke(); }
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const P = (p: Point) => [p.x * s, p.y * s] as const;
  const dot = (p: Point, r: number, fill: string) => { g.fillStyle = fill; g.beginPath(); g.arc(p.x * s, p.y * s, r * s, 0, Math.PI * 2); g.fill(); };
  const ring = (p: Point, r: number, stroke: string, w = 6) => { g.strokeStyle = stroke; g.lineWidth = w * s; g.beginPath(); g.arc(p.x * s, p.y * s, Math.max(1, r * s), 0, Math.PI * 2); g.stroke(); };
  const path = (pts: Point[], stroke: string, w: number, dash: number[] = []) => {
    if (pts.length < 2) return;
    g.strokeStyle = stroke; g.lineWidth = w * s; g.setLineDash(dash.map((d) => d * s));
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(...P(p)) : g.moveTo(...P(p)))); g.stroke();
    g.setLineDash([]);
  };
  const label = (text: string, p: Point, color = k.core, size = 30) => {
    g.fillStyle = color; g.font = `600 ${Math.round(size * s)}px 'Noto Sans TC', sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, p.x * s, p.y * s);
  };
  const bullseye = (p: Point, r = 90) => {
    [r, r * 0.66, r * 0.33].forEach((rr, i) => { dot(p, rr, i % 2 ? k.core : k.target); });
    ring(p, r, '#0b0908', 4);
  };
  const glow = (pts: Point[], w: number) => { path(pts, k.soft, w * 1.8); path(pts, k.guide, w * 0.45); };
  /** The player's stroke as a blade trail: wide and bright where it is newest. */
  const trail = (pts: InputSample[], color = k.ink) => {
    if (pts.length < 2) return;
    for (let i = 1; i < pts.length; i++) {
      const f = i / pts.length;
      g.strokeStyle = color; g.globalAlpha = 0.35 + 0.65 * f; g.lineWidth = (6 + 16 * f) * s;
      g.beginPath(); g.moveTo(...P(pts[i - 1])); g.lineTo(...P(pts[i])); g.stroke();
    }
    g.globalAlpha = 1;
    path(pts, k.core, 3);
  };
  const all = strokesOf(samples);
  const cur = lastStroke(samples);

  switch (c.kind) {
    case 'slash': {
      glow([c.a, c.b], 34);
      dot(c.a, 20, k.guide);
      label('起', { x: c.a.x, y: c.a.y - 50 }, k.guide);
      all.forEach((st) => trail(st));
      break;
    }
    case 'thrust': {
      path([c.from, c.to], k.soft, 26, [30, 24]);
      ring(c.from, 70, k.guide, 6);
      label('護手', { x: c.from.x, y: c.from.y + 105 }, k.guide, 26);
      ring(c.to, 70, k.target, 5);
      ring(c.to, 30, k.target, 5);
      dot(c.to, 10, k.target);
      all.forEach((st) => trail(st));
      break;
    }
    case 'sweep': {
      const pts = sweepPoints(c, 24);
      glow(pts, 40);
      dot(pts[0], 18, k.guide);
      label('起', { x: pts[0].x, y: pts[0].y - 50 }, k.guide);
      all.forEach((st) => trail(st));
      break;
    }
    case 'smash': {
      path([{ x: 60, y: c.raise }, { x: 940, y: c.raise }], k.guide, 4, [24, 18]);
      label('舉過這條線', { x: 500, y: c.raise - 34 }, k.guide, 26);
      // The anvil-like target with cracks.
      ring(c.target, 85, k.target, 6);
      for (let i = 0; i < 6; i++) path([c.target, { x: c.target.x + Math.cos(i) * 70, y: c.target.y + Math.sin(i) * 70 }], k.target, 3);
      dot(c.start, 16, k.guide);
      label('從這裡舉起', { x: c.start.x, y: c.start.y - 44 }, k.guide, 24);
      all.forEach((st) => trail(st));
      break;
    }
    case 'lash': {
      glow(c.points, 30);
      dot(c.points[0], 18, k.guide);
      dot(c.points.at(-1)!, 18, k.guide);
      all.forEach((st) => trail(st));
      break;
    }
    case 'draw': {
      bullseye(c.target);
      const b = bowState(c, cur);
      const tipL = { x: c.bow.x - 230, y: c.bow.y + 40 }, tipR = { x: c.bow.x + 230, y: c.bow.y + 40 };
      // The bow: an arc bending toward the target.
      g.strokeStyle = '#8a5a36'; g.lineWidth = 16 * s;
      g.beginPath(); g.moveTo(...P(tipL)); g.quadraticCurveTo(c.bow.x * s, (c.bow.y - 160) * s, ...P(tipR)); g.stroke();
      const nock = pressed && cur.length && b.power > 0 ? cur.at(-1)! : { x: c.bow.x, y: c.bow.y - 20 };
      path([tipL, nock, tipR], k.core, 3);
      if (!pressed) { ring(c.bow, 220, k.soft, 3); label('按住弓弦往後拉', { x: c.bow.x, y: c.bow.y + 130 }, k.guide, 26); }
      if (pressed && b.land) {
        const v = { x: b.land.x - nock.x, y: b.land.y - nock.y }, len = Math.hypot(v.x, v.y) || 1;
        path([nock, { x: nock.x + (v.x / len) * 240, y: nock.y + (v.y / len) * 240 }], k.core, 6);
        path([nock, b.land], b.power >= 1 ? k.guide : k.soft, 3, [14, 14]);
        ring(b.land, 26, b.power >= 1 ? k.ink : k.soft, 5);
      }
      // Power meter along the bottom.
      g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(100 * s, 950 * s, 800 * s, 24 * s);
      g.fillStyle = b.power >= 1 ? k.guide : k.ink; g.fillRect(100 * s, 950 * s, 800 * b.power * s, 24 * s);
      break;
    }
    case 'aim': {
      bullseye(c.target, 80);
      const at = pressed ? sightAt(c, cur) : c.sight;
      ring(at, 46, k.ink, 4);
      path([{ x: at.x - 70, y: at.y }, { x: at.x + 70, y: at.y }], k.ink, 4);
      path([{ x: at.x, y: at.y - 70 }, { x: at.x, y: at.y + 70 }], k.ink, 4);
      if (!pressed) label('按住任何地方拖動準星，放開射擊', { x: 500, y: 930 }, k.guide, 26);
      break;
    }
    case 'throw': {
      bullseye(c.target, 75);
      dot(c.hand, 30, k.guide);
      label('手', { x: c.hand.x, y: c.hand.y + 70 }, k.guide, 26);
      if (cur.length > 1) {
        trail(cur);
        const land = throwLanding(c, cur);
        if (land) { path([c.hand, land], k.soft, 3, [14, 14]); ring(land, 24, k.ink, 5); }
      }
      break;
    }
    case 'rune': {
      const ring24 = ringPoints(c, 48);
      path([...ring24, ring24[0]], k.soft, 46);
      path([...ring24, ring24[0]], k.magic, 3, [10, 12]);
      ring(c.centre, c.r * 0.55, 'rgba(185,138,224,0.25)', 2);
      c.points.forEach((p, i) => {
        ring(p, 70, 'rgba(185,138,224,0.4)', 3);
        dot(p, 36, k.magic);
        label(String(i + 1), p, '#0b0908', 36);
      });
      all.forEach((st) => trail(st, k.magic));
      break;
    }
  }
}

function strokesOf(samples: InputSample[]): InputSample[][] {
  const out: InputSample[][] = [];
  let cur: InputSample[] | null = null;
  for (const p of samples) {
    if (p.d === 1) (cur ??= []).push(p);
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

/** The one-key form: a marker sweeps along a bar; press Space (or tap the bar) when it reaches the middle. */
function OneKey({ c, kind, onDone }: { c: Challenge; kind: GestureKind; onDone: (input: GestureInput, preview: number) => void }) {
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
