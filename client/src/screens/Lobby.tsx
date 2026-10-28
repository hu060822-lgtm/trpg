import { useState } from 'react';
import { CLASSES } from '../../../src/character/create';
import type { Api, StoredCharacter, WorldSummary } from '../api';
import { useAction, usePoll } from '../hooks';

const GM_ROLE: Record<string, string> = { main: '主 GM', scene: '場景 GM', arbiter: '仲裁 GM' };

export function Lobby({ api, go }: { api: Api; go: (p: string) => void }) {
  const { data, error } = usePoll(async () => {
    const [me, worlds] = await Promise.all([api.me(), api.worlds()]);
    // Which of my characters already stand in each world.
    const joined: Record<string, string[]> = {};
    for (const w of worlds) joined[w.id] = Object.keys((await api.view(w.id)).world.characters).filter((id) => me.characters.some((c) => c.id === id));
    return { me, worlds, joined };
  }, 20_000, [api]);

  if (error) return <main className="page"><p className="error">{error}</p></main>;
  if (!data) return <main className="page"><p className="muted">載入中…</p></main>;
  const { me, worlds, joined } = data;

  return (
    <main className="page stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>你的角色</h1>
        <button className="primary" onClick={() => go('create')}>建立角色</button>
      </div>
      {me.characters.length === 0 && <p className="notice">還沒有角色。先建立一個，再從據點走進世界。</p>}
      <div className="grid2">
        {me.characters.map((c) => <CharacterCard key={c.id} api={api} c={c} worlds={worlds} joined={joined} go={go} />)}
      </div>

      {me.gmOf.length > 0 && (
        <section className="stack" style={{ marginTop: 24 }}>
          <h2>你主持的世界</h2>
          <div className="row">
            {me.gmOf.map((g) => (
              <button key={g.worldId} onClick={() => go(`gm/${g.worldId}`)}>
                打開 {worlds.find((w) => w.id === g.worldId)?.name ?? g.worldId} 的 GM 桌（{GM_ROLE[g.role]}）
              </button>
            ))}
          </div>
        </section>
      )}

      <p className="muted small" style={{ marginTop: 32 }}>
        你的使用者代號：<code>{me.userId}</code>。要擔任 GM，請主 GM 用這個代號替你設定權限。
      </p>
    </main>
  );
}

function CharacterCard({ api, c, worlds, joined, go }: {
  api: Api; c: StoredCharacter; worlds: WorldSummary[]; joined: Record<string, string[]>; go: (p: string) => void;
}) {
  const cls = CLASSES.find((x) => x.id === c.classId);
  const [outpost, setOutpost] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  const dead = c.status === 'dead';
  return (
    <div className="card stack">
      <div>
        <h2>{c.name}</h2>
        <span className="muted small">{cls?.name ?? c.classId}{dead ? '，已永久死亡' : ''}</span>
        {!dead && <div className="hp" title={`生命 ${c.hp}/${c.maxHp}`}><span style={{ width: `${(c.hp / c.maxHp) * 100}%` }} /></div>}
        {!dead && <span className="muted small">生命 {c.hp}/{c.maxHp}</span>}
      </div>
      {!dead && worlds.map((w) => joined[w.id]?.includes(c.id) ? (
        <button key={w.id} className="primary" onClick={() => go(`play/${w.id}/${c.id}`)}>回到{w.name}</button>
      ) : (
        <div key={w.id} className="row">
          <select aria-label="出發的據點" value={outpost[w.id] ?? w.outposts[0]?.id} onChange={(e) => setOutpost({ ...outpost, [w.id]: e.target.value })}>
            {w.outposts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button disabled={busy} onClick={() => void run(async () => {
            await api.join(w.id, c.id, outpost[w.id] ?? w.outposts[0].id);
            go(`play/${w.id}/${c.id}`);
          })}>走進{w.name}</button>
        </div>
      ))}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
