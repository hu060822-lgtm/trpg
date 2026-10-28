import { useState } from 'react';
import bestiary from '../../../config/bestiary.v03.json';
import { ATTRIBUTES, SKILLS } from '../../../src/character/create';
import { ITEMS } from '../../../src/combat/engine';
import { RULES_V03 as R } from '../../../src/rules/config';
import type { AttributeCode } from '../../../src/rules/types';
import { describeCheck } from '../../../src/world/engine';
import type { WorldCommand } from '../../../src/world/types';
import type { Api } from '../api';
import { useAction, usePoll } from '../hooks';
import { CombatPanel } from '../parts/Combat';
import { Log } from '../parts/Log';

const ZONE: Record<string, string> = { safe: '安全區', controlled: '管制區', wild: '荒野' };
const COND: Record<string, string> = { healthy: '健康', wounded: '受傷', severe: '重傷', dying: '瀕死', stable: '昏迷', deathPending: '待裁決' };

/** The GM's table: pick a location, read everything that happens there, narrate, call checks, run fights, rule. */
export function GmDesk({ api, worldId }: { api: Api; worldId: string }) {
  const { data, error, reload } = usePoll(async () => {
    const [view, me, combats] = await Promise.all([api.view(worldId, true), api.me(), api.combats(worldId)]);
    return { view, me, fights: await Promise.all(combats.map((c) => api.combat(worldId, c.id))) };
  }, 4000, [api, worldId]);
  const [sel, setSel] = useState('');
  const [tab, setTab] = useState<'sheet' | 'scene' | 'place'>('scene');
  const [narration, setNarration] = useState('');
  const [privateTo, setPrivateTo] = useState('');
  const [news, setNews] = useState({ title: '', body: '' });
  const [check, setCheck] = useState({ characterId: '', label: '', attribute: 'PER' as AttributeCode, skill: '', tn: 14, situational: 0, mode: 'normal' as 'normal' | 'advantage' | 'disadvantage', highRisk: false, secret: false });
  const [fight, setFight] = useState<{ chars: string[]; monsters: string[] }>({ chars: [], monsters: ['wolf'] });
  const [grant, setGrant] = useState({ characterId: '', amount: 10, reason: '' });
  const { busy, error: actError, run } = useAction();

  if (error && !data) return <main className="page"><p className="error">{error}</p></main>;
  if (!data) return <main className="page"><p className="muted">載入中…</p></main>;
  const { world, history } = data.view;
  const role = data.me.gmOf.find((g) => g.worldId === worldId);
  if (!role) return <main className="page"><p className="error">你不是這個世界的 GM。</p></main>;

  const mineLocs = role.role === 'scene' ? role.locations ?? [] : Object.keys(world.locations);
  const locId = sel && world.locations[sel] ? sel : mineLocs[0];
  const loc = world.locations[locId];
  const send = (command: WorldCommand) => run(async () => { await api.command(worldId, command, { asGm: true }); await reload(); });
  const chars = Object.values(world.characters).filter((c) => c.locationId === locId && c.status === 'alive');
  const npcs = Object.values(world.npcs).filter((n) => n.locationId === locId);
  const events = history.filter((e) => e.locationId === locId || (!e.locationId && e.visibility !== 'private'));
  const fights = data.fights.filter((f) => Object.values(f.combatants).some((c) => c.characterId && world.characters[c.characterId]?.locationId === locId));
  const rulings = Object.values(world.rulings).filter((r) => r.status === 'open');
  const disputes = Object.values(world.economy.disputes).filter((d) => d.status === 'open');
  const reviews = Object.values(world.economy.commissions).filter((k) => k.status === 'submitted' && k.requirement.kind === 'gm');
  const main = role.role === 'main';
  const judge = main || role.role === 'arbiter';
  const name = (id: string) => world.characters[id]?.name ?? id;

  return (
    <>
      <div className="table">
        <section className={tab === 'sheet' ? 'shown' : ''} aria-label="地點">
          <h2>{world.name}</h2>
          <span className="muted small">第 {world.day} 天，你是{{ main: '主 GM', scene: '場景 GM', arbiter: '仲裁 GM' }[role.role]}</span>
          <div className="block">
            <h3>地點</h3>
            <ul className="list small">
              {mineLocs.map((id) => {
                const n = Object.values(world.characters).filter((c) => c.locationId === id && c.status === 'alive').length;
                return (
                  <li key={id}>
                    <button className={id === locId ? 'primary' : ''} style={{ width: '100%', textAlign: 'left' }} onClick={() => { setSel(id); setTab('scene'); }}>
                      {world.locations[id].name}{n ? `（${n} 人）` : ''}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {main && (
            <div className="block stack">
              <h3>世界公告</h3>
              <input aria-label="公告標題" placeholder="標題" value={news.title} onChange={(e) => setNews({ ...news, title: e.target.value })} />
              <textarea aria-label="公告內容" rows={3} placeholder="所有玩家都會看到" value={news.body} onChange={(e) => setNews({ ...news, body: e.target.value })} />
              <button disabled={busy || !news.title.trim() || !news.body.trim()} onClick={() => void send({ type: 'gmPublish', title: news.title.trim(), body: news.body.trim() }).then((ok) => ok && setNews({ title: '', body: '' }))}>發布公告</button>
              <button disabled={busy} onClick={() => { if (confirm('世界推進到下一天？伺服器每天 UTC 午夜也會自動推進。')) void send({ type: 'advanceDay' }); }}>推進到下一天</button>
            </div>
          )}
          {main && (
            <div className="block stack">
              <h3>發放錢幣</h3>
              <select aria-label="發給誰" value={grant.characterId} onChange={(e) => setGrant({ ...grant, characterId: e.target.value })}>
                <option value="">選擇角色</option>
                {Object.values(world.characters).filter((c) => c.status === 'alive').map((c) => <option key={c.id} value={c.id}>{c.name}（{c.coins}）</option>)}
              </select>
              <div className="row">
                <input aria-label="數量" type="number" min={1} style={{ width: 80 }} value={grant.amount} onChange={(e) => setGrant({ ...grant, amount: Number(e.target.value) })} />
                <input aria-label="原因" placeholder="原因（必填）" value={grant.reason} onChange={(e) => setGrant({ ...grant, reason: e.target.value })} />
              </div>
              <button disabled={busy || !grant.characterId || !grant.reason.trim()} onClick={() => void send({ type: 'gmGrantCoins', characterId: grant.characterId, amount: grant.amount, reason: grant.reason.trim() })}>發放</button>
            </div>
          )}
        </section>

        <section className={`scene ${tab === 'scene' ? 'shown' : ''}`} aria-label="場景">
          <div className="scene-top">
          <div className="place">
            <h1>{loc.name}</h1>
            <span className="muted small">{ZONE[loc.zone]}{loc.outpost ? '，據點' : ''}，場景時間 {Math.floor(loc.clock / 60)} 小時 {loc.clock % 60} 分</span>
            <p>{loc.description}</p>
            {loc.gmNotes && <p className="small notice">GM 筆記：{loc.gmNotes}</p>}
          </div>
          {fights.map((f) => <CombatPanel key={f.id} api={api} worldId={worldId} combat={f} mine={(c) => c.controller === 'gm'} onChange={reload} />)}
          </div>
          <Log events={events} empty="這個地點還沒有紀錄。" />
          <div className="compose">
            <form className="stack" onSubmit={(e) => {
              e.preventDefault();
              void send({ type: 'gmNarrate', locationId: locId, text: narration.trim(), ...(privateTo ? { to: [privateTo] } : {}) }).then((ok) => ok && setNarration(''));
            }}>
              <textarea aria-label="敘述" rows={2} value={narration} maxLength={500} onChange={(e) => setNarration(e.target.value)} placeholder="描述玩家看到、聽到、感覺到的事" />
              <div className="row">
                <select aria-label="敘述給誰" value={privateTo} onChange={(e) => setPrivateTo(e.target.value)}>
                  <option value="">在場所有人</option>
                  {chars.map((c) => <option key={c.id} value={c.id}>只給 {c.name}</option>)}
                </select>
                <button className="primary" disabled={busy || !narration.trim()}>送出敘述</button>
              </div>
            </form>
            {actError && <p className="error">{actError}</p>}
          </div>
        </section>

        <section className={tab === 'place' ? 'shown' : ''} aria-label="角色與裁決">
          <div className="block">
            <h3>在場角色</h3>
            {chars.length === 0 && <p className="muted small">這裡沒有玩家角色。</p>}
            {chars.map((c) => (
              <div key={c.id} className="stack small" style={{ marginBottom: 10 }}>
                <span><b>{c.name}</b>　{COND[c.condition] ?? c.condition}，{c.online ? '在線' : '殘影'}，錢幣 {c.coins}</span>
                {(c.pendingChecks ?? []).map((p) => (
                  <div key={p.id} className="row">
                    <span className="muted">待擲：{p.label}（{describeCheck({ rules: R }, p)}）</span>
                    <button disabled={busy} onClick={() => void send({ type: 'rollCheck', characterId: c.id, checkId: p.id })}>代擲</button>
                    <button disabled={busy} onClick={() => void send({ type: 'gmCancelCheck', characterId: c.id, checkId: p.id })}>取消</button>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {chars.length > 0 && (
            <div className="block stack">
              <h3>要求檢定</h3>
              <select aria-label="誰擲骰" value={check.characterId} onChange={(e) => setCheck({ ...check, characterId: e.target.value })}>
                <option value="">選擇角色</option>
                {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input aria-label="檢定名稱" placeholder="例如：撬開鐵門" value={check.label} onChange={(e) => setCheck({ ...check, label: e.target.value })} />
              <div className="row">
                <select aria-label="屬性" value={check.attribute} onChange={(e) => setCheck({ ...check, attribute: e.target.value as AttributeCode })}>
                  {ATTRIBUTES.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                </select>
                <select aria-label="技能" value={check.skill} onChange={(e) => setCheck({ ...check, skill: e.target.value })}>
                  <option value="">只用屬性</option>
                  {SKILLS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="row">
                <select aria-label="難度" value={check.tn} onChange={(e) => setCheck({ ...check, tn: Number(e.target.value) })}>
                  {R.difficulties.map((d) => <option key={d.tn} value={d.tn}>{d.name} {d.tn}</option>)}
                </select>
                <label className="tick">情境
                  <input type="number" min={-R.check.modifierCap} max={R.check.modifierCap} style={{ width: 60 }} value={check.situational} onChange={(e) => setCheck({ ...check, situational: Number(e.target.value) })} />
                </label>
                <select aria-label="優劣勢" value={check.mode} onChange={(e) => setCheck({ ...check, mode: e.target.value as typeof check.mode })}>
                  <option value="normal">一般</option><option value="advantage">優勢</option><option value="disadvantage">劣勢</option>
                </select>
              </div>
              <label className="tick"><input type="checkbox" checked={check.highRisk} onChange={(e) => setCheck({ ...check, highRisk: e.target.checked })} />高風險（失敗可能變成災難）</label>
              <label className="tick"><input type="checkbox" checked={check.secret} onChange={(e) => setCheck({ ...check, secret: e.target.checked })} />暗骰（結果只有 GM 看得到）</label>
              <button disabled={busy || !check.characterId || !check.label.trim()} onClick={() => void send({
                type: 'gmRequestCheck', characterId: check.characterId, label: check.label.trim(), attribute: check.attribute, skill: check.skill || null,
                tn: check.tn, situational: check.situational, mode: check.mode, highRisk: check.highRisk, secret: check.secret,
              }).then((ok) => ok && setCheck({ ...check, label: '' }))}>要求檢定</button>
            </div>
          )}

          {chars.length > 0 && (
            <div className="block stack">
              <h3>開戰</h3>
              <div className="small">
                {chars.map((c) => (
                  <label key={c.id} className="tick">
                    <input type="checkbox" checked={fight.chars.includes(c.id)} onChange={(e) => setFight({ ...fight, chars: e.target.checked ? [...fight.chars, c.id] : fight.chars.filter((x) => x !== c.id) })} />{c.name}
                  </label>
                ))}
              </div>
              {fight.monsters.map((m, i) => (
                <div key={i} className="row">
                  <select aria-label="怪物" value={m} onChange={(e) => setFight({ ...fight, monsters: fight.monsters.map((x, j) => (j === i ? e.target.value : x)) })}>
                    {bestiary.monsters.map((b) => <option key={b.id} value={b.id}>{b.name}（生命 {b.maxHp}）</option>)}
                  </select>
                  <button aria-label="移除" onClick={() => setFight({ ...fight, monsters: fight.monsters.filter((_, j) => j !== i) })}>移除</button>
                </div>
              ))}
              <div className="row">
                <button onClick={() => setFight({ ...fight, monsters: [...fight.monsters, 'wolf'] })}>再加一隻</button>
                <button className="danger" disabled={busy || fight.chars.filter((id) => chars.some((c) => c.id === id)).length === 0 || fight.monsters.length === 0} onClick={() => void run(async () => {
                  await api.startFight(worldId, {
                    locationId: locId,
                    characters: fight.chars.filter((id) => chars.some((c) => c.id === id)).map((id) => ({ id, weaponId: 'dagger', armorId: 'leather' })),
                    monsters: fight.monsters.map((bestiaryId) => ({ bestiaryId })),
                  });
                  await reload();
                })}>開始戰鬥</button>
              </div>
              <p className="muted small">角色預設帶{ITEMS.find((i) => i.id === 'dagger')?.name}和{ITEMS.find((i) => i.id === 'leather')?.name}。非 PvP 的戰鬥死亡是永久的。怪物數值是暫定值，沒有經過平衡模擬。</p>
            </div>
          )}

          {npcs.length > 0 && (
            <div className="block">
              <h3>NPC</h3>
              <ul className="list small">
                {npcs.map((n) => (
                  <li key={n.id}>
                    <span>{n.name}{n.status === 'dead' ? '（已死亡）' : ''}</span>
                    {n.status === 'alive' && <button className="danger" disabled={busy} onClick={() => {
                      const basis = prompt(`${n.name} 死亡的依據（會寫進稽核紀錄，不能復活）`);
                      if (basis?.trim()) void send({ type: 'gmSetNpcStatus', npcId: n.id, status: 'dead', basis: basis.trim() });
                    }}>標記死亡</button>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {judge && (rulings.length > 0 || disputes.length > 0 || reviews.length > 0) && (
            <div className="block stack">
              <h3>待裁決</h3>
              {rulings.map((r) => (
                <div key={r.id} className="small stack" style={{ gap: 4 }}>
                  <span>{r.kind === 'pvp-death' ? 'PvP 死亡' : '唯一物品被偷'}：{r.summary}</span>
                  <div className="row">
                    <button className="danger" disabled={busy} onClick={() => void send({ type: 'gmRuling', rulingId: r.id, decision: 'confirm' })}>{r.kind === 'pvp-death' ? '確認死亡' : '維持結果'}</button>
                    <button disabled={busy} onClick={() => void send({ type: 'gmRuling', rulingId: r.id, decision: 'overturn' })}>{r.kind === 'pvp-death' ? '不成立，倖存' : '撤銷，歸還'}</button>
                  </div>
                </div>
              ))}
              {reviews.map((k) => (
                <div key={k.id} className="small stack" style={{ gap: 4 }}>
                  <span>委託驗收「{k.title}」：{k.requirement.kind === 'gm' ? k.requirement.text : ''}（{name(k.contractorId!)} 提交）</span>
                  <div className="row">
                    <button disabled={busy} onClick={() => void send({ type: 'reviewCommission', characterId: '', commissionId: k.id, approve: true })}>通過</button>
                    <button disabled={busy} onClick={() => void send({ type: 'reviewCommission', characterId: '', commissionId: k.id, approve: false })}>退回</button>
                  </div>
                </div>
              ))}
              {disputes.map((d) => (
                <div key={d.id} className="small stack" style={{ gap: 4 }}>
                  <span>{d.kind === 'commission' ? '委託' : '契約'}爭議（{name(d.raisedBy)}）：{d.reason}</span>
                  <div className="row">
                    {d.kind === 'commission' ? (
                      <>
                        <button disabled={busy} onClick={() => void send({ type: 'gmResolveDispute', disputeId: d.id, outcome: 'pay' })}>付給接案人</button>
                        <button disabled={busy} onClick={() => void send({ type: 'gmResolveDispute', disputeId: d.id, outcome: 'refund' })}>退回發布者</button>
                      </>
                    ) : (
                      <>
                        <button disabled={busy} onClick={() => void send({ type: 'gmResolveDispute', disputeId: d.id, outcome: 'fulfilled' })}>視為履行</button>
                        <button disabled={busy} onClick={() => void send({ type: 'gmResolveDispute', disputeId: d.id, outcome: 'cancel' })}>解除契約</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {actError && <p className="error">{actError}</p>}
        </section>
      </div>
      <nav className="tabs">
        {([['sheet', '世界'], ['scene', '場景'], ['place', '角色']] as const).map(([k, label]) => (
          <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>
    </>
  );
}
