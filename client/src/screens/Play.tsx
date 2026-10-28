import { useState } from 'react';
import { ATTRIBUTES, CLASSES, SKILLS, skillTierName } from '../../../src/character/create';
import { RULES_V03 as R } from '../../../src/rules/config';
import { describeCheck } from '../../../src/world/engine';
import type { WorldCommand } from '../../../src/world/types';
import type { Api } from '../api';
import { useAction, usePoll } from '../hooks';
import { CombatPanel } from '../parts/Combat';
import { Log } from '../parts/Log';
import { Market } from '../parts/Market';

const ZONE: Record<string, string> = { safe: '安全區', controlled: '管制區', wild: '荒野' };
const COND: Record<string, string> = {
  healthy: '健康', wounded: '受傷', severe: '重傷', dying: '瀕死', stable: '昏迷', dead: '死亡', deathPending: '倒下，等待 GM 裁決',
};

export function Play({ api, worldId, characterId, go }: { api: Api; worldId: string; characterId: string; go: (p: string) => void }) {
  const { data, error, reload } = usePoll(async () => {
    const [view, me, combats] = await Promise.all([api.view(worldId), api.me(), api.combats(worldId)]);
    const fights = await Promise.all(combats.map((c) => api.combat(worldId, c.id)));
    return { view, me, fights };
  }, 4000, [api, worldId, characterId]);
  const [tab, setTab] = useState<'sheet' | 'scene' | 'place'>('scene');
  const [side, setSide] = useState<'place' | 'market'>('place');
  const [mode, setMode] = useState<'say' | 'act' | 'ooc'>('say');
  const [text, setText] = useState('');
  const [whisperTo, setWhisperTo] = useState('');
  const { busy, error: actError, run } = useAction();

  if (error && !data) return <main className="page"><p className="error">{error}</p></main>;
  if (!data) return <main className="page"><p className="muted">載入中…</p></main>;

  const { world, history } = data.view;
  const me = world.characters[characterId];
  const sheet = data.me.characters.find((c) => c.id === characterId);
  if (!me || !sheet) return <main className="page"><p className="notice">這個角色不在這個世界。<button className="link" onClick={() => go('')}>回到大廳</button></p></main>;

  const send = async (command: WorldCommand) => { await api.command(worldId, command); await reload(); };
  const act = (command: WorldCommand) => run(() => send(command));
  const loc = world.locations[me.locationId];
  const people = Object.values(world.characters).filter((c) => c.id !== me.id && c.locationId === me.locationId && c.status === 'alive');
  const npcs = Object.values(world.npcs).filter((n) => n.locationId === me.locationId);
  const ground = Object.values(world.items).filter((i) => i.holder.type === 'location' && i.holder.id === me.locationId && i.status === 'present');
  const bag = Object.values(world.items).filter((i) => i.holder.type === 'character' && i.holder.id === me.id && i.status === 'present');
  const duels = world.duels.filter((d) => d.status === 'pending' && d.to === me.id);
  const fight = data.fights.find((f) => Object.values(f.combatants).some((c) => c.characterId === me.id));
  const cls = CLASSES.find((c) => c.id === sheet.classId);
  const dead = sheet.status === 'dead';

  const speak = () => {
    const body = text.trim();
    if (!body) return;
    void act(whisperTo ? { type: 'whisper', characterId: me.id, to: whisperTo, text: body } : { type: 'say', characterId: me.id, text: body, mode })
      .then((ok) => { if (ok) setText(''); });
  };

  return (
    <>
      <div className="table">
        <section className={tab === 'sheet' ? 'shown' : ''} aria-label="角色">
          <h2>{me.name}</h2>
          <span className="muted small">{cls?.name}，{dead ? '已永久死亡' : COND[me.condition] ?? me.condition}{me.online ? '' : '，離線（殘影）'}</span>
          <div className="hp"><span style={{ width: `${(sheet.hp / sheet.maxHp) * 100}%` }} /></div>
          <span className="muted small">生命 {sheet.hp}/{sheet.maxHp}，錢幣 {me.coins}</span>
          <div className="block">
            <h3>屬性</h3>
            <div className="stats">
              {ATTRIBUTES.map((a) => <div key={a.code}><b>{me.attributes[a.code]}</b><span>{a.name}</span></div>)}
            </div>
          </div>
          <div className="block">
            <h3>技能</h3>
            <ul className="list small">
              {SKILLS.filter((s) => (me.skills[s.id] ?? 0) > 0).map((s) => (
                <li key={s.id}><span>{s.name}</span><span className="muted">{me.skills[s.id]}　{skillTierName(me.skills[s.id], R)}</span></li>
              ))}
            </ul>
          </div>
          <div className="block">
            <h3>背包</h3>
            {bag.length === 0 && <p className="muted small">身上沒有東西。</p>}
            <ul className="list small">
              {bag.map((i) => (
                <li key={i.id}>
                  <span>{i.name}{i.unique ? '（唯一）' : ''}{i.boundTo ? '（綁定）' : ''}</span>
                  <button disabled={busy} onClick={() => void act({ type: 'drop', characterId: me.id, itemId: i.id })}>放下</button>
                </li>
              ))}
            </ul>
          </div>
          <div className="block stack">
            <label className="tick">
              <input type="checkbox" checked={me.lethalPvpOptIn} onChange={(e) => void act({ type: 'setLethalOptIn', characterId: me.id, optIn: e.target.checked })} />
              接受致命 PvP（不勾時，沒有決鬥約定的攻擊最多把你打昏）
            </label>
            <button onClick={() => void act({ type: 'setOnline', characterId: me.id, online: !me.online })}>
              {me.online ? '下線（離開安全區時會留下殘影）' : '重新上線'}
            </button>
            <button className="link" onClick={() => go('')}>回到大廳</button>
          </div>
        </section>

        <section className={`scene ${tab === 'scene' ? 'shown' : ''}`} aria-label="場景">
          <div className="scene-top">
          <div className="place">
            <h1>{loc.name}</h1>
            <span className="muted small">{ZONE[loc.zone]}{loc.outpost ? '，據點' : ''}，場景時間 {Math.floor(loc.clock / 60)} 小時 {loc.clock % 60} 分，世界第 {world.day} 天</span>
            <p>{loc.description}</p>
            {Object.keys(loc.state).length > 0 && <p className="small">{Object.entries(loc.state).map(([k, v]) => `${k}：${v}`).join('；')}</p>}
          </div>
          {(me.pendingChecks ?? []).map((c) => (
            <div key={c.id} className="check">
              <div>
                <h3>GM 要求檢定：{c.label}</h3>
                <span className="small">{describeCheck({ rules: R }, c)}{c.secret ? '，暗骰（結果只有 GM 知道）' : ''}</span>
              </div>
              <button className="primary" disabled={busy} onClick={() => void act({ type: 'rollCheck', characterId: me.id, checkId: c.id })}>擲 d20</button>
            </div>
          ))}
          {fight && <CombatPanel api={api} worldId={worldId} combat={fight} mine={(c) => c.controller === data.me.userId} onChange={reload} />}
          </div>
          <Log events={history} empty="還沒有紀錄。說點什麼，或四處看看。" />
          {!dead && (
            <div className="compose">
              <div className="row modes">
                {(['say', 'act', 'ooc'] as const).map((m) => (
                  <button key={m} aria-pressed={!whisperTo && mode === m} onClick={() => { setMode(m); setWhisperTo(''); }}>{{ say: '說話', act: '動作', ooc: '場外' }[m]}</button>
                ))}
                <select aria-label="悄悄話對象" value={whisperTo} onChange={(e) => setWhisperTo(e.target.value)}>
                  <option value="">悄悄話…</option>
                  {people.map((p) => <option key={p.id} value={p.id}>對 {p.name}</option>)}
                </select>
              </div>
              <form className="row" onSubmit={(e) => { e.preventDefault(); speak(); }}>
                <input aria-label="輸入內容" value={text} maxLength={500} onChange={(e) => setText(e.target.value)}
                  placeholder={whisperTo ? `悄悄對 ${world.characters[whisperTo]?.name} 說…` : mode === 'act' ? '描述你的動作，例如：推開鐘樓的門' : mode === 'ooc' ? '場外說明，不算角色說的話' : '角色說的話'} />
                <button className="primary" disabled={busy || !text.trim()}>送出</button>
              </form>
              {actError && <p className="error">{actError}</p>}
            </div>
          )}
        </section>

        <section className={tab === 'place' ? 'shown' : ''} aria-label="地點與交易">
          <div className="row modes" style={{ marginBottom: 8 }}>
            <button aria-pressed={side === 'place'} onClick={() => setSide('place')}>這裡</button>
            <button aria-pressed={side === 'market'} onClick={() => setSide('market')}>交易</button>
          </div>
          {side === 'market' ? <Market world={world} me={me} send={send} /> : (
            <>
              {duels.map((d) => (
                <div key={d.id} className="notice small stack">
                  {world.characters[d.from]?.name} 邀請你決鬥。決鬥可能致命，死亡要經 GM 確認。
                  <div className="row">
                    <button className="danger" disabled={busy} onClick={() => void act({ type: 'respondDuel', characterId: me.id, duelId: d.id, accept: true })}>接受</button>
                    <button disabled={busy} onClick={() => void act({ type: 'respondDuel', characterId: me.id, duelId: d.id, accept: false })}>拒絕</button>
                  </div>
                </div>
              ))}
              <div className="block">
                <h3>在場的人</h3>
                {people.length === 0 && npcs.length === 0 && <p className="muted small">這裡只有你。</p>}
                <ul className="list small">
                  {people.map((p) => (
                    <li key={p.id}>
                      <span>{p.name}{p.online ? '' : '（殘影）'}</span>
                      <span className="row">
                        <button disabled={busy} onClick={() => void act({ type: 'inviteDuel', characterId: me.id, targetId: p.id })}>邀請決鬥</button>
                        <button className="danger" disabled={busy} onClick={() => {
                          if (confirm(`確定攻擊 ${p.name}？在管制區要先宣告敵意，攻擊可能留下犯罪紀錄。`)) void act({ type: 'attack', characterId: me.id, targetId: p.id });
                        }}>攻擊</button>
                      </span>
                    </li>
                  ))}
                  {npcs.map((n) => <li key={n.id}><span>{n.name}{n.status === 'dead' ? '（已死亡）' : ''}</span><span className="muted">NPC</span></li>)}
                </ul>
              </div>
              <div className="block">
                <h3>地上的東西</h3>
                {ground.length === 0 && <p className="muted small">沒看到什麼。仔細搜索也許會發現藏起來的東西。</p>}
                <ul className="list small">
                  {ground.map((i) => (
                    <li key={i.id}><span>{i.name}</span><button disabled={busy} onClick={() => void act({ type: 'take', characterId: me.id, itemId: i.id })}>撿起</button></li>
                  ))}
                </ul>
              </div>
              <div className="block">
                <h3>可以去的地方</h3>
                <ul className="list small">
                  {loc.links.map((l) => (
                    <li key={l.to}>
                      <span>{world.locations[l.to]?.name}<span className="muted">　{l.minutes} 分鐘</span></span>
                      <button disabled={busy || !!fight} onClick={() => void act({ type: 'move', characterId: me.id, to: l.to })}>前往</button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="block row">
                <button disabled={busy} onClick={() => void act({ type: 'search', characterId: me.id })}>仔細搜索</button>
                <button disabled={busy} onClick={() => void act({ type: 'wait', characterId: me.id, minutes: 10 })}>等待 10 分鐘</button>
              </div>
              {actError && <p className="error">{actError}</p>}
            </>
          )}
        </section>
      </div>
      <nav className="tabs">
        {([['sheet', '角色'], ['scene', '場景'], ['place', '地點']] as const).map(([k, label]) => (
          <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>
    </>
  );
}
