import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL, hasSheet, type Api, type CharacterData, type CheckMode, type LogEntry, type Pack, type RollTarget, type RoomView } from '../api';
import { useAction, useDraft, useMedia, usePoll, useRoomEvents } from '../hooks';
import { CharacterBuilder } from '../parts/CharacterBuilder';
import { CharacterForm } from '../parts/CharacterForm';
import { LogView } from '../parts/LogView';
import { MapPanel } from '../parts/MapPanel';
import { SheetPanel } from '../parts/SheetPanel';
import { Bars, ErrorNote } from '../parts/ui';

const DICE = [4, 6, 8, 10, 12, 20, 100];

/** Keeps the room's log in step with the server: everything after the last entry seen, every few seconds. */
function useLog(api: Api, roomId: string, every: number) {
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
  useEffect(() => { void pull().then(() => setFirstLoad(last.current)).catch(() => {}); }, [pull]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void pull().catch(() => {}); }, every);
    return () => clearInterval(t);
  }, [pull, every]);
  return { entries, pull, firstLoad };
}

type Tab = 'map' | 'log' | 'sheet' | 'table';

export function RoomScreen({ api, roomId, go }: { api: Api; roomId: string; go: (path: string) => void }) {
  // Events call into `view` and `log` below; they only fire after this render has set both up.
  const live = useRoomEvents(api, API_URL, roomId, (e) => {
    if (e.type === 'log') { void log.pull(); if (tab !== 'log' && tab !== 'map') { unread.current++; bump((n) => n + 1); } }
    else if (e.type === 'room' || e.type === 'maps') void view.reload();
    if (e.type === 'map' || e.type === 'maps') setMapVersion((v) => v + 1);
  });
  // With live updates the polls are only a safety net; without them they keep the table fresh on their own.
  const view = usePoll(() => api.room(roomId), live ? 30000 : 8000, [roomId, live]);
  const [pack, setPack] = useState<Pack | null>(null);
  const packKey = view.data?.room.packKey;
  useEffect(() => { if (packKey) void api.pack(packKey).then(setPack); }, [api, packKey]);
  const log = useLog(api, roomId, live ? 20000 : 3000);
  const [tab, setTab] = useState<Tab>('map');
  const [side, setSide] = useState<'log' | 'sheet' | 'table'>('log');
  // Wide screens seat the sheet in its own column; medium ones (tablets) move it into the right column's switch.
  const medium = useMedia('(min-width: 768px) and (max-width: 1279.98px)');
  const [picked, setPicked] = useState<string | null>(null);
  const [mapVersion, setMapVersion] = useState(0);
  const unread = useRef(0);
  const [, bump] = useState(0);

  const activeMapId = view.data?.room.activeMapId ?? null;
  const gm = view.data?.me.role === 'gm';
  const shownMap = gm ? picked ?? activeMapId : activeMapId;


  if (view.error && !view.data) return <main className="page stack"><ErrorNote of={view} /><div className="row"><button onClick={() => void view.reload()}>再試一次</button><button onClick={() => go('')}>回到大廳</button></div></main>;
  if (!view.data || !pack) return <RoomSkeleton />;
  const choose = (t: Tab) => { setTab(t); if (t === 'log') unread.current = 0; };
  const pane = tab === 'table' ? 'table' : tab === 'log' ? 'log' : side === 'sheet' && !medium ? 'log' : side;
  const characters = <Characters api={api} view={view.data} pack={pack} reload={view.reload} pull={log.pull} />;
  const logPanel = (
    <>
      <LogView entries={log.entries} freshFrom={log.firstLoad} visible={tab === 'log' || tab === 'map'} />
      <Compose api={api} roomId={roomId} pull={log.pull} />
    </>
  );
  return (
    <div className="table">
      <section className={`side${tab === 'sheet' ? ' shown' : ''}`}>{!medium && characters}</section>
      <section className={`stage-col${tab === 'map' ? ' shown' : ''}`}>
        <MapPanel api={api} view={view.data} mapId={shownMap} version={mapVersion} onChat={() => { choose('log'); setSide('log'); }} onMaps={(id) => { setPicked(id); setMapVersion((v) => v + 1); void view.reload(); }} />
      </section>
      <section className={`scene${tab === 'log' || tab === 'table' ? ' shown' : ''}`}>
        <div className="place">
          <div className="row">
            <h1>{view.data.room.name}</h1>
            <span className={`live${live ? ' on' : ''}`}>{live ? '即時同步' : '定時更新'}</span>
          </div>
          <p className="small muted">{pack.manifest.name}・{view.data.me.role === 'gm' ? '你是 GM' : '你是玩家'}</p>
          <div className="switch side-switch" role="group" aria-label="右欄內容">
            <button aria-pressed={pane === 'log'} onClick={() => setSide('log')}>紀錄</button>
            {medium && <button aria-pressed={pane === 'sheet'} onClick={() => setSide('sheet')}>角色</button>}
            <button aria-pressed={pane === 'table'} onClick={() => setSide('table')}>桌邊</button>
          </div>
        </div>
        <div className={`side-pane log-pane${pane === 'log' ? ' on' : ''}`}>{logPanel}</div>
        {medium && <div className={`side-pane table-pane${pane === 'sheet' ? ' on' : ''}`}>{characters}</div>}
        <div className={`side-pane table-pane${pane === 'table' ? ' on' : ''}`}>
          <TableSide api={api} view={view.data} pack={pack} reload={view.reload} />
        </div>
      </section>
      <nav className="tabs" aria-label="房間分頁">
        <button aria-pressed={tab === 'map'} onClick={() => choose('map')}>地圖</button>
        <button aria-pressed={tab === 'log'} onClick={() => choose('log')}>紀錄{unread.current > 0 && <span className="dot">{unread.current}</span>}</button>
        <button aria-pressed={tab === 'sheet'} onClick={() => choose('sheet')}>角色</button>
        <button aria-pressed={tab === 'table'} onClick={() => choose('table')}>桌邊</button>
      </nav>
    </div>
  );
}

function Compose({ api, roomId, pull }: { api: Api; roomId: string; pull: () => Promise<void> }) {
  const [text, setText, dropText] = useDraft(`fateweave:say:${roomId}`, () => '');
  const [blank, setBlank] = useState(false);
  const send = useAction();
  const say = (words: string) => send.run(async () => { await api.chat(roomId, words); await pull(); });
  return (
    <div className="compose">
      <div className="dice row" role="group" aria-label="快速擲骰">
        {DICE.map((d) => <button key={d} disabled={send.busy} aria-label={`擲 1 顆 d${d}`} onClick={() => void say(`/r 1d${d}`)}>d{d}</button>)}
      </div>
      <form className="stack tight" onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) { setBlank(true); return; }
        void say(t).then((ok) => { if (ok) { setText(''); dropText(); } });
      }}>
        <label htmlFor={`say-${roomId}`} className="compose-label">訊息<span>輸入 /r 2d6+3 擲骰，/gr 擲暗骰</span></label>
        <div className="row nowrap">
          <input id={`say-${roomId}`} value={text} maxLength={1000} onChange={(e) => { setText(e.target.value); setBlank(false); }} onBlur={() => setBlank(false)}
            placeholder="大家好" autoComplete="off" />
          <button className="primary" disabled={send.busy}>傳送</button>
        </div>
      </form>
      {blank && <p className="field-error">先打一段話或擲骰指令，再按傳送。</p>}
      <ErrorNote of={send} />
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

  const created = async (name: string, data: CharacterData) => {
    const c = await api.createCharacter(view.room.id, name, data);
    await reload(); setSelected(c.id); setEditing(null); await pull();
  };
  // Packs with a builder (class, species…) get the step-by-step builder; simple packs keep the one-page form.
  if (pack.builder.length > 0 && editing === 'new') {
    return <CharacterBuilder pack={pack} draftKey={`fateweave:builder:${view.room.id}`} onSave={created} onClose={() => setEditing(null)} />;
  }
  if (pack.builder.length > 0 && !current && editing !== 'edit') {
    return (
      <div className="empty">
        <h2>建立你的角色</h2>
        <p className="muted small">照{pack.manifest.name}一步一步選職業、背景、種族和屬性，角色卡會即時算好。做到一半離開也會幫你留著。</p>
        <button className="primary" onClick={() => setEditing('new')}>開始建立角色</button>
      </div>
    );
  }
  if (editing === 'new' || (!current && editing !== 'edit')) {
    return (
      <div className="stack">
        <h2>建立角色</h2>
        {!current && <p className="muted small">照{pack.manifest.name}的規則分配點數。數字會即時算出來；做到一半離開也會幫你留著。</p>}
        <CharacterForm pack={pack} creating draftKey={`fateweave:new-character:${view.room.id}`} onCancel={current ? () => setEditing(null) : undefined}
          onSave={created} />
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
        <label>正在看的角色
          <select value={current!.id} onChange={(e) => setSelected(e.target.value)}>
            {mine.map((c) => <option key={c.id} value={c.id}>{c.name}{c.ownerUserId !== view.me.userId ? `（${view.members.find((m) => m.userId === c.ownerUserId)?.name ?? '其他玩家'}）` : ''}</option>)}
          </select>
        </label>
      )}
      <SheetPanel pack={pack} character={current!} mode={mode} setMode={setMode} secret={secret} setSecret={setSecret}
        busy={rolling.busy} roll={roll} onEdit={() => setEditing('edit')} />
      <ErrorNote of={rolling} />
      <button className="link" onClick={() => setEditing('new')}>建立另一個角色</button>
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
            {copied ? '已複製' : '複製代碼'}
          </button>
        </div>
        <p className="muted small">把代碼給玩家，他們在大廳輸入就能加入。</p>
      </section>

      <section className="block">
        <h3>成員</h3>
        <ul className="list framed">
          {view.members.map((m) => {
            const chars = view.characters.filter((c) => c.ownerUserId === m.userId).map((c) => c.name).join('、');
            return (
              <li key={m.userId}>
                <span>{m.name}{chars && <small className="muted">　{chars}</small>}</span>
                {gm && m.userId !== view.me.userId ? (
                  <button className="small" disabled={change.busy}
                    onClick={() => void change.run(async () => { await api.setRole(view.room.id, m.userId, m.role === 'gm' ? 'player' : 'gm'); await reload(); })}>
                    {m.role === 'gm' ? '改成玩家' : '設為 GM'}
                  </button>
                ) : <span className={`badge ${m.role}`}>{m.role === 'gm' ? 'GM' : '玩家'}</span>}
              </li>
            );
          })}
        </ul>
        <ErrorNote of={change} />
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
        <label>搜尋規則說明
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="優勢" />
        </label>
        <div className="glossary">
          {found.map((e) => <details key={e.id}><summary>{e.title}</summary><p>{e.text}</p></details>)}
          {found.length === 0 && (
            <div className="empty">
              <p className="muted small">沒有條目提到「{q}」。換個詞，或清除搜尋看全部條目。</p>
              <button onClick={() => setQ('')}>清除搜尋</button>
            </div>
          )}
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

/** The room's three columns in outline while the table loads, so nothing jumps when it arrives. */
function RoomSkeleton() {
  return (
    <div className="table" aria-busy="true" aria-label="載入房間中">
      <section className="side shown"><Bars lines={6} /></section>
      <section className="stage-col"><div className="skeleton board-bar" /></section>
      <section className="scene"><div className="place"><Bars lines={2} /></div><div className="log"><Bars lines={5} /></div></section>
    </div>
  );
}
