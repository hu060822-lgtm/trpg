import { useEffect, useRef } from 'react';
import type { WorldEvent } from '../../../src/world/types';

const STORY = new Set(['said', 'narration', 'checkResult', 'whispered', 'worldEvent', 'checkRequested', 'checkCalled']);

function classOf(e: WorldEvent) {
  const c = ['entry'];
  if (e.kind === 'narration') c.push('narration');
  else if (e.kind === 'checkResult') c.push('roll', e.data.success === false ? 'fail' : 'ok');
  else if (e.visibility === 'gm') c.push('gm');
  else if (e.visibility === 'private') c.push('private');
  else if (!STORY.has(e.kind)) c.push('system');
  return c.join(' ');
}

/** The scene's thread: every entry this viewer may read, oldest at the top, scrolled to the latest. */
export function Log({ events, empty }: { events: WorldEvent[]; empty: string }) {
  const end = useRef<HTMLDivElement>(null);
  const seen = useRef(0);
  const last = events.at(-1)?.seq ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
    const t = setTimeout(() => { seen.current = last; }, 700);
    return () => clearTimeout(t);
  }, [last]);
  return (
    <div className="log" aria-live="polite">
      {events.length === 0 && <p className="muted">{empty}</p>}
      {events.map((e) => (
        <p key={e.seq} className={`${classOf(e)}${seen.current && e.seq > seen.current ? ' fresh' : ''}`}>
          <time dateTime={e.at}>第 {e.day} 天 {new Date(e.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
          {e.text}
        </p>
      ))}
      <div ref={end} />
    </div>
  );
}
