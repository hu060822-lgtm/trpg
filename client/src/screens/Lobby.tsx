import { useRef, useState } from 'react';
import { ApiError, type Api, type PackProblem } from '../api';
import { useAction, usePoll } from '../hooks';
import { Bars, ErrorNote } from '../parts/ui';

/** Where a player lands: their rooms, a way to open or join one, and the rule packs a room can use. */
export function Lobby({ api, go }: { api: Api; go: (path: string) => void }) {
  const rooms = usePoll(() => api.rooms(), 20000, []);
  const packs = usePoll(() => api.packs(), 60000, []);
  const [name, setName] = useState('');
  const [pack, setPack] = useState('');
  const [code, setCode] = useState('');
  const [codeShort, setCodeShort] = useState(false);
  const roomName = useRef<HTMLInputElement>(null);
  const create = useAction();
  const join = useAction();
  const upload = useAction();
  const [problems, setProblems] = useState<PackProblem[]>([]);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const chosen = packs.data?.find((p) => p.key === (pack || packs.data?.[0]?.key));

  return (
    <main className="page stack lobby">
      <section className="stack">
        <h1>我的房間</h1>
        <ErrorNote of={rooms} />
        {!rooms.data && !rooms.error && <ul className="rooms" aria-busy="true">{[0, 1].map((i) => <li key={i}><Bars lines={1} className="room-bar" /></li>)}</ul>}
        {rooms.data && rooms.data.length === 0 && (
          <div className="empty">
            <h3>還沒有房間</h3>
            <p className="muted">你開的房間和加入過的房間都會列在這裡，下次一點就回到桌邊。</p>
            <button className="primary" onClick={() => roomName.current?.focus()}>開第一個房間</button>
          </div>
        )}
        {rooms.data && rooms.data.length > 0 && (
          <ul className="rooms">
            {rooms.data.map((r) => (
              <li key={r.id}>
                <a href={`#/room/${r.id}`}>
                  <b>{r.name}</b>
                  <span className="muted small">{r.packName}</span>
                  <span className={`badge ${r.role}`}>{r.role === 'gm' ? 'GM' : '玩家'}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid2">
        <form className="card stack" onSubmit={(e) => {
          e.preventDefault();
          if (!chosen) return;
          void create.run(async () => { const r = await api.createRoom(name.trim(), chosen.key); go(`room/${r.id}`); });
        }}>
          <h2>開新房間</h2>
          <p className="muted small">你會是這個房間的 GM。開好之後把加入代碼給玩家。</p>
          <label>房間名稱
            <input ref={roomName} required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 週五的地城" />
          </label>
          <label>規則
            <select value={chosen?.key ?? ''} onChange={(e) => setPack(e.target.value)}>
              {packs.data?.map((p) => <option key={p.key} value={p.key}>{p.name}（{p.version}）</option>)}
            </select>
          </label>
          {chosen?.description && <p className="muted small">{chosen.description}</p>}
          <button className="primary" disabled={create.busy}>{create.busy ? '開房間中…' : '開房間'}</button>
          <ErrorNote of={create} />
        </form>

        <form className="card stack" onSubmit={(e) => {
          e.preventDefault();
          if (code.trim().length < 6) { setCodeShort(true); return; }
          void join.run(async () => { const r = await api.join(code.trim()); go(`room/${r.id}`); });
        }}>
          <h2>加入房間</h2>
          <p className="muted small">輸入 GM 給你的 6 碼代碼。</p>
          <label>加入代碼
            <input required className="code-input" value={code} maxLength={6} autoCapitalize="characters" autoComplete="off" spellCheck={false}
              aria-invalid={codeShort || undefined} aria-describedby={codeShort ? 'code-error' : undefined}
              onChange={(e) => { setCode(e.target.value.toUpperCase()); setCodeShort(false); }} onFocus={() => setCodeShort(false)}
              onBlur={() => setCodeShort(code.trim().length > 0 && code.trim().length < 6)} placeholder="ABC123" />
          </label>
          {codeShort && <p id="code-error" className="field-error">代碼是 6 個英文字母或數字，請補齊。</p>}
          <button className="primary" disabled={join.busy}>{join.busy ? '加入中…' : '加入房間'}</button>
          <ErrorNote of={join} />
        </form>
      </div>

      <section className="card stack">
        <h2>規則包</h2>
        <p className="muted small">規則包是一個 zip，寫著一套遊戲的屬性、技能、角色卡怎麼算、檢定怎麼擲。匯入後，開房間時就能選它。格式說明在專案的 docs/packs.md。</p>
        {!packs.data && !packs.error && <Bars lines={2} />}
        <ul className="list framed">
          {packs.data?.map((p) => (
            <li key={p.key}>
              <span><b>{p.name}</b> <span className="muted small">{p.version}</span></span>
              <span className="muted small">{p.builtin ? '內建' : '匯入'}・{p.license}</span>
            </li>
          ))}
        </ul>
        <div className="row">
          <input ref={file} type="file" accept=".zip,application/zip" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setProblems([]);
            setUploaded(null);
            void upload.run(async () => {
              try {
                const r = await api.uploadPack(f);
                setUploaded(r.name);
                await packs.reload();
              } catch (err) {
                if (err instanceof ApiError && err.problems) setProblems(err.problems);
                throw err;
              }
            });
          }} />
          <button type="button" onClick={() => file.current?.click()} disabled={upload.busy}>{upload.busy ? '檢查中…' : '匯入規則包 zip'}</button>
        </div>
        {uploaded && <p className="notice">已匯入「{uploaded}」，開房間時可以選它。</p>}
        <ErrorNote of={upload} />
        {problems.length > 0 && (
          <ul className="problems">
            {problems.map((p, i) => <li key={i}><code>{p.file}{p.path}</code>{p.message}</li>)}
          </ul>
        )}
      </section>
    </main>
  );
}
