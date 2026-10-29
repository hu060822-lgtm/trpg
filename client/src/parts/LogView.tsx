import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../api';

/** Dice a roll dropped (the low die of 4d6kh3) come back wrapped in ~…~; show them struck through. */
function Breakdown({ text }: { text: string }) {
  return <>{text.split(/~([^~]*)~/).map((part, i) => (i % 2 ? <del key={i}>{part}</del> : part))}</>;
}

const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A just-rolled total tumbles through random faces for a moment, then lands on the real number. */
function Total({ value, tumble }: { value: number; tumble: boolean }) {
  const [shown, setShown] = useState<number | null>(tumble && !calm() ? null : value);
  const [face, setFace] = useState(value);
  useEffect(() => {
    if (shown !== null) return;
    const top = Math.max(6, Math.abs(value) * 1.5);
    const end = performance.now() + 600; // dice are the game's content, not chrome: the one animation allowed past 300ms
    let frame = 0;
    const spin = (t: number) => {
      if (t >= end) { setShown(value); return; }
      setFace(1 + Math.floor(Math.random() * top));
      frame = requestAnimationFrame(spin);
    };
    frame = requestAnimationFrame(spin);
    return () => cancelAnimationFrame(frame);
  }, [shown, value]);
  return shown === null
    ? <b className="total rolling" aria-hidden>{face}</b>
    : <b className={`total${tumble ? ' landed' : ''}`}>{shown}</b>;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

/** The room's log: chat, rolls with every die shown, and table events, newest at the bottom. */
export function LogView({ entries, freshFrom, visible }: { entries: LogEntry[]; freshFrom: number; visible: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const last = entries.at(-1)?.seq;
  // On a phone the log is one tab of three; catch up with what arrived while another tab was open.
  useEffect(() => { if (visible) end.current?.scrollIntoView({ block: 'end' }); }, [last, visible]);

  return (
    <div className="log" aria-live="polite">
      {entries.length === 0 && <p className="entry system">房間開好了。說聲嗨，或輸入 /r 1d20 試擲一次。</p>}
      {entries.map((e) => {
        const fresh = e.seq > freshFrom ? ' fresh' : '';
        if (e.kind === 'roll') {
          const b = e.body;
          return (
            <article key={e.seq} className={`entry roll${b.natural ? ` ${b.natural}` : ''}${fresh}`}>
              <header><time>{time(e.at)}</time><span className="who">{e.author}</span>{b.secret && <span className="badge secret">暗骰</span>}</header>
              <div className="roll-line">
                <span className="roll-label">{b.label}</span>
                <Total value={b.total} tumble={!!fresh} />
                {b.natural === 'critical' && <span className="badge crit">大成功</span>}
                {b.natural === 'fumble' && <span className="badge fumble">大失敗</span>}
              </div>
              <p className="breakdown"><Breakdown text={b.text} /></p>
              {b.damage && (
                <div className="roll-line damage">
                  <span className="roll-label">傷害</span><Total value={b.damage.total} tumble={!!fresh} />
                  <span className="breakdown"><Breakdown text={b.damage.text} /></span>
                </div>
              )}
            </article>
          );
        }
        if (e.kind === 'system') return <p key={e.seq} className={`entry system${fresh}`}><time>{time(e.at)}</time>{e.body.text}</p>;
        return (
          <p key={e.seq} className={`entry${fresh}`}><time>{time(e.at)}</time><span className="who">{e.author}</span>{e.body.text}</p>
        );
      })}
      <div ref={end} />
    </div>
  );
}
