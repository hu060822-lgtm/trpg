import { useCallback, useEffect, useRef, useState } from 'react';
import { hasSheet, type Api, type CheckMode, type LogEntry, type Pack, type RollTarget, type RoomView } from '../api';
import { useAction, usePoll } from '../hooks';
import { CharacterForm } from '../parts/CharacterForm';
import { LogView } from '../parts/LogView';
import { SheetPanel } from '../parts/SheetPanel';

const DICE = [4, 6, 8, 10, 12, 20, 100];

/** Keeps the room's log in step with the server: everything after the last entry seen, every few seconds. */
function useLog(api: Api, roomId: string) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [firstLoad, setFirstLoad] = useState(0);
  const last = useRef(0);
  const pull = useCallback(async () => {
    for (;;) {
      const page = await api.log(roomId, last.current);
      if (page.length === 0) return;
      last.current = page.at(-1)!.seq;
      setEntries((old) => [...old, ...page.filter((e) => e.seq > (old.at(-1)?.seq ?? 0))]);
      if (page.length < 200) return;
    }
  }, [api, roomId]);
  useEffect(() => {
    let live = true;
    void pull().then(() => { if (live) setFirstLoad(last.current); }).catch(() => {});
    const t = setInterval(() => { if (document.visibilityState === 'visible') void pull().catch(() => {}); }, 3000);
    return () => { live = false; clearInterval(t); };
  }, [pull]);
  return { entries, pull, firstLoad };
}

export function RoomScreen({ api, roomId, go }: { api: Api; roomId: string; go: (path: string) => void }) {
  const view = usePoll(() => api.room(roomId), 8000, [roomId]);
  const [pack, setPack] = useState<Pack | null>(null);
  const packKey = view.data?.room.packKey;
  useEffect(() => { if (packKey) void api.pack(packKey).then(setPack); }, [api, packKey]);
  const log = useLog(api, roomId);
  const [tab, setTab] = useState<'log' | 'sheet' | 'table'>('log');

  if (view.error && !view.data) return <main className="page"><p className="error">{view.error}</p><button onClick={() => go('')}>回到大廳</button></main>;
  if (!view.data || !pack) return <main className="page"><p className="muted">載入房間中…</p></main>;
  return (
    <div className="table">
      <section className={`side${tab === 'sheet' ? ' shown' : ''}`}><Characters api={api} view={view.data} pack={pack} reload={view.reload} pull={log.pull} /></section>
      <section className={`scene${tab === 'log' ? ' shown' : ''}`}>
        <div className="place">
          <h1>{view.data.room.name}</h1>
          <p className="small muted">{pack.manifest.name}・{view.data.me.role === 'gm' ? '你是 GM' : '你是玩家'}</p>
        </div>
        <LogView entries={log.entries} freshFrom={log.firstLoad} visible={tab === 'log'} />
        <Compose api={api} roomId={roomId} pull={log.pull} />
      </section>
      <section className={`side${tab === 'table' ? ' shown' : ''}`}><TableSide api={api} view={view.data} pack={pack} reload={view.reload} /></section>
      <nav className="tabs">
        <button aria-pressed={tab === 'sheet'} onClick={() => setTab('sheet')}>角色</button>
        <button aria-pressed={tab === 'log'} onClick={() => setTab('log')}>紀錄</button>
        <button aria-pressed={tab === 'table'} onClick={() => setTab('table')}>桌邊</button>
      </nav>
    </div>
  );
}

function Compose({ api, roomId, pull }: { api: Api; roomId: string; pull: () => Promise<void> }) {
  const [text, setText] = useState('');
  const send = useAction();
  const say = (words: string) => send.run(async () => { await api.chat(roomId, words); await pull(); });
  return (
    <div className="compose">
      <div className="dice row" role="group" aria-label="快速擲骰">
        {DICE.map((d) => <button key={d} disabled={send.busy} onClick={() => void say(`/r 1d${d}`)}>d{d}</button>)}
      </div>
      <form className="row" onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) return;
        void say(t).then((ok) => { if (ok) setText(''); });
      }}>
        <input value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} aria-label="訊息" placeholder="說點什麼，或輸入 /r 2d6+3 擲骰、/gr 暗骰" />
        <button className="primary" disabled={send.busy || !text.trim()}>送出</button>
      </form>
      {send.error && <p className="error">{send.error}</p>}
    </div>
  );
}

function Characters({ api, view, pack, reload, pull }: { api: Api; view: RoomView; pack: Pack; reload: () => Promise<void>; pull: () => Promise<void> }) {
  const gm = view.me.role === 'gm';
  const mine = view.characters.filter(hasSheet).filter((c) => gm || c.ownerUserId === view.me.userId);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null);
  const [mode, setMode] = useState<CheckMode>('normal');
  const [secret, setSecret] = useState(false);
  const rolling = useAction();
  const current = mine.find((c) => c.id === selected) ?? mine.find((c) => c.ownerUserId === view.me.userId) ?? mine[0];
  const roll = (t: RollTarget) => void rolling.run(async () => { await api.roll(view.room.id, t, secret); await pull(); });

  if (editing === 'new' || (!current && editing !== 'edit')) {
    return (
      <div className="stack">
        <h2>建立角色</h2>
        {!current && <p className="muted small">照{pack.manifest.name}的規則分配點數。數字會即時算出來，不確定時把滑鼠停在項目上看說明。</p>}
        <CharacterForm pack={pack} creating onCancel={current ? () => setEditing(null) : undefined}
          onSave={async (name, data) => { const c = await api.createCharacter(view.room.id, name, data); await reload(); setSelected(c.id); setEditing(null); await pull(); }} />
      </div>
    );
  }
  if (editing === 'edit' && current) {
    return (
      <div className="stack">
        <h2>編輯角色</h2>
        <CharacterForm pack={pack} creating={false} initial={current} onCancel={() => setEditing(null)}
          onSave={async (name, data) => { await api.updateCharacter(view.room.id, current.id, current.version, { name, data }); await reload(); setEditing(null); }} />
      </div>
    );
  }
  return (
    <div className="stack">
      {mine.length > 1 && (
        <select aria-label="選擇角色" value={current!.id} onChange={(e) => setSelected(e.target.value)}>
          {mine.map((c) => <option key={c.id} value={c.id}>{c.name}{c.ownerUserId !== view.me.userId ? `（${view.members.find((m) => m.userId === c.ownerUserId)?.name ?? '其他玩家'}）` : ''}</option>)}
        </select>
      )}
      <SheetPanel pack={pack} character={current!} mode={mode} setMode={setMode} secret={secret} setSecret={setSecret}
        busy={rolling.busy} roll={roll} onEdit={() => setEditing('edit')} />
      {rolling.error && <p className="error">{rolling.error}</p>}
      <button className="link" onClick={() => setEditing('new')}>＋ 再建立一個角色</button>
    </div>
  );
}

function TableSide({ api, view, pack, reload }: { api: Api; view: RoomView; pack: Pack; reload: () => Promise<void> }) {
  const gm = view.me.role === 'gm';
  const [q, setQ] = useState('');
  const [copied, setCopied] = useState(false);
  const change = useAction();
  const found = pack.glossary.filter((e) => !q || e.title.includes(q) || e.text.includes(q) || e.tags?.some((t) => t.includes(q)));
  return (
    <div>
      <section className="block">
        <h3>加入代碼</h3>
        <div className="row">
          <code className="room-code">{view.room.code}</code>
          <button onClick={() => { void navigator.clipboard?.writeText(view.room.code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
            {copied ? '已複製' : '複製'}
          </button>
        </div>
        <p className="muted small">把代碼給玩家，他們在大廳輸入就能加入。</p>
      </section>

      <section className="block">
        <h3>成員</h3>
        <ul className="list">
          {view.members.map((m) => {
            const chars = view.characters.filter((c) => c.ownerUserId === m.userId).map((c) => c.name).join('、');
            return (
              <li key={m.userId}>
                <span>{m.name}{chars && <small className="muted">　{chars}</small>}</span>
                {gm && m.userId !== view.me.userId ? (
                  <button className="small" disabled={change.busy}
                    onClick={() => void change.run(async () => { await api.setRole(view.room.id, m.userId, m.role === 'gm' ? 'player' : 'gm'); await reload(); })}>
                    {m.role === 'gm' ? 'GM・改成玩家' : '設為 GM'}
                  </button>
                ) : <span className={`badge ${m.role}`}>{m.role === 'gm' ? 'GM' : '玩家'}</span>}
              </li>
            );
          })}
        </ul>
        {change.error && <p className="error">{change.error}</p>}
      </section>

      {pack.checks.difficulties && pack.checks.difficulties.length > 0 && (
        <section className="block">
          <h3>難度</h3>
          <ul className="difficulties">
            {pack.checks.difficulties.map((d) => <li key={d.label}><span>{d.label}</span><b>{d.value}</b></li>)}
          </ul>
        </section>
      )}

      <section className="block">
        <h3>規則說明</h3>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋，例如 優勢" aria-label="搜尋規則說明" />
        <div className="glossary">
          {found.map((e) => <details key={e.id}><summary>{e.title}</summary><p>{e.text}</p></details>)}
          {found.length === 0 && <p className="muted small">找不到「{q}」。</p>}
        </div>
      </section>

      <section className="block">
        <h3>規則包</h3>
        <p className="small">{pack.manifest.name} {pack.manifest.version}</p>
        <p className="muted small">授權 {pack.manifest.license}{pack.manifest.author ? `・${pack.manifest.author}` : ''}</p>
        {pack.manifest.attribution && <p className="muted small">{pack.manifest.attribution}</p>}
      </section>
    </div>
  );
}
