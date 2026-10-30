import { useEffect, useMemo, useState } from 'react';
import type { Api, Emitter, MapView, Pack, PatternDef, RoomView } from '../api';
import type { GmOp } from '../../../src/encounter/engine';
import { useAction } from '../hooks';
import { Confirm, ErrorNote } from '../parts/ui';
import { DEFAULT_RULES } from '../../../src/encounter/rules';
import { CONDITIONS, CONDITION_LABEL, type CombatantView, type EncounterView, type SetupEntry, type Tier, type Trigger } from '../../../src/encounter/types';
import { FOE_TEAM, PARTY_TEAM, teamOf, teamsIn } from '../../../src/encounter/teams';
import { PatternPreview } from './Arena';
import { STEP_NAME } from './Combat';
import type { Combat } from './state';

const TIER_NAME: Record<Tier, string> = { minion: '一般', elite: '重要', boss: 'Boss' };
const MODE_NAME = { full: '完整互動', quick: '快速結算', custom: 'GM 自訂' } as const;

// ---------------- starting a fight ----------------

interface Row { include: boolean; side: 'party' | 'ally' | 'foe'; team: string; monsterId: string; hidden: boolean; ac: number; hp: number; bonus: number; damage: string; tier: Tier }

export function EncounterSetup({ combat, view, pack, data, onClose }: { combat: Combat; view: RoomView; pack: Pack; data: MapView; onClose: () => void }) {
  const monsters = pack.combat?.monsters ?? [];
  const templates = pack.combat?.encounters ?? [];
  const [rows, setRows] = useState<Record<string, Row>>(() => Object.fromEntries(data.tokens.map((t) => {
    const m = monsters.find((x) => t.name.startsWith(x.name));
    return [t.id, { include: true, side: t.characterId ? 'party' : 'foe', team: '', monsterId: m?.id ?? '', hidden: t.hidden, ac: 12, hp: 10, bonus: 3, damage: '1d6+1', tier: 'minion' }];
  })));
  const [template, setTemplate] = useState('');
  const [at, setAt] = useState({ x: Math.floor(data.map.cols / 2), y: Math.floor(data.map.rows / 2) });
  const [mode, setMode] = useState<'full' | 'quick' | 'custom'>('full');
  const [autoNpc, setAutoNpc] = useState(true);
  const [showFoeHp, setShowFoeHp] = useState(false);
  const [autoEnd, setAutoEnd] = useState(true);
  const act = useAction();
  const teamNames = [...new Set([PARTY_TEAM, FOE_TEAM, ...Object.values(rows).map((r) => r.team.trim()).filter(Boolean)])];
  const set = (id: string, change: Partial<Row>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...change } }));
  const start = () => void act.run(async () => {
    const entries: SetupEntry[] = data.tokens.filter((t) => rows[t.id]?.include).map((t) => {
      const r = rows[t.id];
      const team = r.team.trim() ? { team: r.team.trim() } : {};
      if (t.characterId) return { tokenId: t.id, side: r.side, ...team };
      if (r.monsterId) return { tokenId: t.id, side: r.side, ...team, monsterId: r.monsterId, hidden: r.hidden };
      return { tokenId: t.id, side: r.side, ...team, hidden: r.hidden, ac: r.ac, hp: r.hp, tier: r.tier, attacks: [{ id: 'a0', label: '攻擊', bonus: r.bonus, damage: r.damage, damageType: '傷害' }] };
    });
    const b = await combat.api.startEncounter(view.room.id, { entries, ...(template ? { template: { id: template, ...at } } : {}), mode, autoNpc, showFoeHp, autoEnd });
    combat.take(b);
    onClose();
  });
  return (
    <aside className="drawer combat-drawer" aria-label="開始戰鬥">
      <div className="drawer-head"><h2>開始戰鬥</h2><button className="link" onClick={onClose}>關閉</button></div>
      <p className="small muted">勾選要參戰的代幣。玩家角色用角色卡的生命和 AC；其他代幣選怪物圖鑑，或自己填數字。</p>
      <p className="small muted">陣營：不填就照身分分成「我方」和「敵方」。要三方以上混戰，就替各方取名字（例如「哥布林」、「盜賊」），不同陣營互相敵對。</p>
      <datalist id="team-names">{teamNames.map((n) => <option key={n} value={n} />)}</datalist>
      <ul className="list framed setup-list">
        {data.tokens.length === 0 && <li className="muted small">地圖上還沒有代幣。可以只用下面的遭遇範本。</li>}
        {data.tokens.map((t) => {
          const r = rows[t.id];
          return (
            <li key={t.id} className="stack tight">
              <label className="tick"><input type="checkbox" checked={r.include} onChange={(e) => set(t.id, { include: e.target.checked })} /><b>{t.name}</b>{t.characterId && <span className="badge">角色</span>}</label>
              {r.include && (
                <div className="row wrap">
                  <label className="tick">身分
                    <select value={r.side} onChange={(e) => set(t.id, { side: e.target.value as Row['side'] })}>
                      <option value="party">隊伍</option><option value="ally">盟友</option><option value="foe">敵人</option>
                    </select>
                  </label>
                  <label className="tick">陣營
                    <input className="team-input" list="team-names" maxLength={16} value={r.team} placeholder={r.side === 'foe' ? FOE_TEAM : PARTY_TEAM}
                      onChange={(e) => set(t.id, { team: e.target.value })} />
                  </label>
                  {!t.characterId && (
                    <label className="tick">怪物
                      <select value={r.monsterId} onChange={(e) => set(t.id, { monsterId: e.target.value })}>
                        <option value="">自訂數值</option>
                        {monsters.map((m) => <option key={m.id} value={m.id}>{m.name}（AC {m.ac}・HP {m.hp}）</option>)}
                      </select>
                    </label>
                  )}
                  {!t.characterId && !r.monsterId && (
                    <>
                      <label className="tick">AC<input type="number" className="num" value={r.ac} onChange={(e) => set(t.id, { ac: Number(e.target.value) })} /></label>
                      <label className="tick">HP<input type="number" className="num" value={r.hp} onChange={(e) => set(t.id, { hp: Number(e.target.value) })} /></label>
                      <label className="tick">命中<input type="number" className="num" value={r.bonus} onChange={(e) => set(t.id, { bonus: Number(e.target.value) })} /></label>
                      <label className="tick">傷害<input value={r.damage} className="formula" onChange={(e) => set(t.id, { damage: e.target.value })} /></label>
                      <label className="tick">重要度
                        <select value={r.tier} onChange={(e) => set(t.id, { tier: e.target.value as Tier })}>{(['minion', 'elite', 'boss'] as Tier[]).map((k) => <option key={k} value={k}>{TIER_NAME[k]}</option>)}</select>
                      </label>
                    </>
                  )}
                  {!t.characterId && <label className="tick"><input type="checkbox" checked={r.hidden} onChange={(e) => set(t.id, { hidden: e.target.checked })} />先藏起來</label>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {templates.length > 0 && (
        <section className="stack tight">
          <h3>加上遭遇範本</h3>
          <div className="row wrap">
            <select value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="遭遇範本">
              <option value="">不用範本</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.entries.length} 隻）</option>)}
            </select>
            {template && <>
              <label className="tick">放在第<input type="number" className="num" min={1} max={data.map.cols} value={at.x + 1} onChange={(e) => setAt({ ...at, x: Number(e.target.value) - 1 })} />欄</label>
              <label className="tick">第<input type="number" className="num" min={1} max={data.map.rows} value={at.y + 1} onChange={(e) => setAt({ ...at, y: Number(e.target.value) - 1 })} />列</label>
            </>}
          </div>
        </section>
      )}
      <section className="stack tight">
        <h3>戰鬥方式</h3>
        <div className="seg" role="group" aria-label="互動模式">
          {(['full', 'quick', 'custom'] as const).map((m) => <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{MODE_NAME[m]}</button>)}
        </div>
        <p className="small muted">{{ full: '玩家擲骰、做武器操作、閃避。', quick: '全部自動擲骰，照骰子結算，適合小怪。', custom: '每個參戰者可以在主控台個別設定。' }[mode]}</p>
        <label className="tick"><input type="checkbox" checked={autoNpc} onChange={(e) => setAutoNpc(e.target.checked)} />NPC 回合自動行動（3 秒內可以接手）</label>
        <label className="tick"><input type="checkbox" checked={showFoeHp} onChange={(e) => setShowFoeHp(e.target.checked)} />讓玩家看到敵人的確切生命</label>
        <label className="tick"><input type="checkbox" checked={autoEnd} onChange={(e) => setAutoEnd(e.target.checked)} />只剩一個陣營站著時自動結束戰鬥</label>
      </section>
      <div className="row">
        <button className="primary" disabled={act.busy} onClick={start}>開始戰鬥</button>
        <button disabled={act.busy} onClick={() => void act.run(() => combat.api.rest(view.room.id))}>長休（角色生命回滿）</button>
      </div>
      <ErrorNote of={act} />
    </aside>
  );
}

type Op = (o: GmOp) => void;

// ---------------- the console ----------------

export function GmConsole({ combat, enc, pack, view, data, onClose }: { combat: Combat; enc: EncounterView; pack: Pack; view: RoomView; data: MapView | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [ending, setEnding] = useState(false);
  const [patternsOpen, setPatternsOpen] = useState(false);
  const [quality, setQuality] = useState(0.7);
  const [hits, setHits] = useState(1);
  const [total, setTotal] = useState(15);
  const op: Op = (o) => void combat.send({ type: 'gm', op: o, ...(reason.trim() ? { reason: reason.trim() } : {}) });
  const [roomPatterns, setRoomPatterns] = useState<PatternDef[]>([]);
  useEffect(() => { void combat.api.patterns(view.room.id).then(setRoomPatterns).catch(() => {}); }, [combat.api, view.room.id, patternsOpen]);
  const patterns = [...(pack.combat?.patterns ?? []), ...roomPatterns];
  const st = enc.step;
  const outside = data?.tokens.filter((t) => !Object.values(enc.combatants).some((c) => c.tokenId === t.id)) ?? [];
  return (
    <aside className="drawer combat-drawer" aria-label="GM 主控台">
      <div className="drawer-head"><h2>GM 主控台</h2><button className="link" onClick={onClose}>關閉</button></div>
      <label>這次調整的理由（會寫進紀錄，可留白）<input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="玩家斷線" /></label>
      <section className="stack tight">
        <h3>流程</h3>
        <div className="row wrap">
          {enc.status === 'paused' ? <button className="primary" onClick={() => op({ kind: 'resume' })}>繼續戰鬥</button> : <button onClick={() => op({ kind: 'pause' })}>暫停戰鬥</button>}
          <button onClick={() => op({ kind: 'nextTurn' })}>跳到下一位</button>
          {enc.flow && <button onClick={() => op({ kind: 'cancelAttack' })}>取消這次攻擊</button>}
          <button className="danger" onClick={() => setEnding(true)}>結束戰鬥</button>
        </div>
        <div className="row wrap">
          <label className="tick">模式
            <select value={enc.mode} onChange={(e) => op({ kind: 'settings', mode: e.target.value as EncounterView['mode'] })}>
              {(['full', 'quick', 'custom'] as const).map((m) => <option key={m} value={m}>{MODE_NAME[m]}</option>)}
            </select>
          </label>
          <label className="tick"><input type="checkbox" checked={enc.autoNpc} onChange={(e) => op({ kind: 'settings', autoNpc: e.target.checked })} />NPC 自動行動</label>
          <label className="tick"><input type="checkbox" checked={enc.showFoeHp} onChange={(e) => op({ kind: 'settings', showFoeHp: e.target.checked })} />公開敵人生命</label>
          <label className="tick"><input type="checkbox" checked={enc.autoEnd !== false} onChange={(e) => op({ kind: 'settings', autoEnd: e.target.checked })} />一方全倒自動結束</label>
        </div>
      </section>
      {st && (
        <section className="stack tight">
          <h3>目前步驟：{STEP_NAME[st.kind]}</h3>
          <p className="small muted">暫停時倒數會停住；跳過會照預設結果（自動擲骰、沒做操作算 0、沒閃避照骰子傷害）。</p>
          <div className="row wrap">
            <button onClick={() => op({ kind: 'retry' })}>讓這步重來</button>
            <button onClick={() => op({ kind: 'skip' })}>跳過這步</button>
          </div>
          {st.kind === 'attackInteract' && <div className="row"><label className="tick">指定品質 {Math.round(quality * 100)}%<input type="range" min={0} max={1} step={0.05} value={quality} onChange={(e) => setQuality(Number(e.target.value))} /></label><button onClick={() => op({ kind: 'force', quality })}>套用</button></div>}
          {st.kind === 'dodge' && <div className="row"><label className="tick">指定被打中<input type="number" className="num" min={0} max={20} value={hits} onChange={(e) => setHits(Number(e.target.value))} />次</label><button onClick={() => op({ kind: 'force', hits })}>套用</button></div>}
          {st.kind === 'attackRoll' && <div className="row"><label className="tick">指定攻擊總值<input type="number" className="num" value={total} onChange={(e) => setTotal(Number(e.target.value))} /></label><button onClick={() => op({ kind: 'force', total })}>套用</button></div>}
        </section>
      )}
      <section className="stack tight">
        <h3>參戰者</h3>
        <datalist id="gm-team-names">{teamsIn(Object.values(enc.combatants)).map((n) => <option key={n} value={n} />)}</datalist>
        <ul className="list framed gm-list">
          {enc.order.concat(Object.keys(enc.combatants).filter((id) => !enc.order.includes(id))).map((id) => enc.combatants[id]).filter(Boolean).map((c) => (
            <CombatantRow key={c.id} c={c} enc={enc} op={op} patterns={patterns} />
          ))}
        </ul>
      </section>
      {outside.length > 0 && (
        <section className="stack tight">
          <h3>加入戰鬥</h3>
          <AddCombatants tokens={outside} pack={pack} onAdd={(entries) => op({ kind: 'add', entries })} />
        </section>
      )}
      <Triggers enc={enc} op={op} patterns={patterns} />
      <section className="stack tight">
        <h3>彈幕</h3>
        <button onClick={() => setPatternsOpen(true)}>編輯房間的彈幕</button>
      </section>
      {patternsOpen && <PatternEditor api={combat.api} roomId={view.room.id} pack={pack} contrast={combat.prefs.highContrast} onClose={() => setPatternsOpen(false)} />}
      {ending && <Confirm title="結束這場戰鬥？" action="結束戰鬥" body="角色目前的生命會保留到下一場。進行中的攻擊會取消。" onClose={() => setEnding(false)} onConfirm={() => op({ kind: 'end' })} />}
      <ErrorNote of={combat.error} />
    </aside>
  );
}

function CombatantRow({ c, enc, op, patterns }: { c: CombatantView; enc: EncounterView; op: Op; patterns: PatternDef[] }) {
  const [hp, setHp] = useState(String(c.hp ?? ''));
  const [open, setOpen] = useState(false);
  useEffect(() => setHp(String(c.hp ?? '')), [c.hp]);
  return (
    <li className="stack tight">
      <div className="row">
        <b>{c.name}</b>
        <small className="muted">{teamOf(c)}・{c.hp}/{c.maxHp}・AC {c.ac}・先攻 {c.initiative ?? '—'}{c.defeated ? '・倒下' : ''}{c.dead ? '・死亡' : ''}</small>
        {c.hidden && <span className="badge secret">隱藏</span>}
        <span className="spacer" />
        <button className="link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? '收起' : '調整'}</button>
      </div>
      {open && (
        <div className="stack tight">
          <div className="row wrap">
            <label className="tick">生命<input type="number" className="num" value={hp} onChange={(e) => setHp(e.target.value)} /></label>
            <button onClick={() => op({ kind: 'hp', combatantId: c.id, hp: Number(hp) })}>套用生命</button>
            <label className="tick">陣營<input className="team-input" list="gm-team-names" maxLength={16} defaultValue={c.team ?? ''} placeholder={c.side === 'foe' ? FOE_TEAM : PARTY_TEAM}
              onBlur={(e) => { if (e.target.value.trim() !== (c.team ?? '')) op({ kind: 'team', combatantId: c.id, team: e.target.value.trim() }); }} /></label>
            <label className="tick">先攻<input type="number" className="num" defaultValue={c.initiative ?? 10} onBlur={(e) => { if (Number(e.target.value) !== c.initiative) op({ kind: 'initiative', combatantId: c.id, value: Number(e.target.value) }); }} /></label>
            {c.hidden && <button onClick={() => op({ kind: 'reveal', combatantId: c.id })}>現身</button>}
            {enc.turn?.combatantId === c.id && <button onClick={() => op({ kind: 'extraAction', combatantId: c.id })}>再給一個動作</button>}
            <button className="danger" onClick={() => op({ kind: 'remove', combatantId: c.id })}>移出戰鬥</button>
          </div>
          <div className="row wrap" role="group" aria-label="狀態">
            {CONDITIONS.map((k) => (
              <button key={k} className="chip" aria-pressed={c.conditions.includes(k)} onClick={() => op({ kind: 'condition', combatantId: c.id, condition: k, on: !c.conditions.includes(k) })}>{CONDITION_LABEL[k]}</button>
            ))}
          </div>
          {c.controller === 'gm' && (
            <div className="row wrap">
              <label className="tick">重要度
                <select value={c.tier} onChange={(e) => op({ kind: 'tier', combatantId: c.id, tier: e.target.value as Tier })}>{(['minion', 'elite', 'boss'] as Tier[]).map((k) => <option key={k} value={k}>{TIER_NAME[k]}</option>)}</select>
              </label>
              <label className="tick">彈幕
                <select value={c.patterns?.[0] ?? ''} onChange={(e) => op({ kind: 'patterns', combatantId: c.id, patterns: e.target.value ? [e.target.value] : [] })}>
                  <option value="">照怪物預設</option>
                  {patterns.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            </div>
          )}
          {enc.mode === 'custom' && (
            <label className="tick">互動
              <select value={c.interaction} onChange={(e) => op({ kind: 'interaction', combatantId: c.id, interaction: e.target.value as CombatantView['interaction'] })}>
                <option value="auto">照重要度</option><option value="full">完整互動</option><option value="quick">快速結算</option>
              </select>
            </label>
          )}
        </div>
      )}
    </li>
  );
}

function AddCombatants({ tokens, pack, onAdd }: { tokens: MapView['tokens']; pack: Pack; onAdd: (entries: SetupEntry[]) => void }) {
  const [pick, setPick] = useState<Record<string, string>>({});
  const monsters = pack.combat?.monsters ?? [];
  return (
    <ul className="list framed">
      {tokens.map((t) => (
        <li key={t.id} className="row">
          <span>{t.name}</span>
          {!t.characterId && (
            <select value={pick[t.id] ?? ''} onChange={(e) => setPick({ ...pick, [t.id]: e.target.value })} aria-label={`${t.name} 是哪種怪物`}>
              <option value="">自訂（AC 12・HP 10）</option>
              {monsters.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
          <button onClick={() => onAdd([t.characterId ? { tokenId: t.id } : { tokenId: t.id, ...(pick[t.id] ? { monsterId: pick[t.id] } : {}), hidden: t.hidden }])}>加入</button>
        </li>
      ))}
    </ul>
  );
}

function Triggers({ enc, op, patterns }: { enc: EncounterView; op: Op; patterns: PatternDef[] }) {
  const people = Object.values(enc.combatants);
  const [when, setWhen] = useState<'hpBelow' | 'round' | 'enter'>('hpBelow');
  const [then, setThen] = useState<'say' | 'reveal' | 'patterns' | 'tier'>('say');
  const [who, setWho] = useState(people[0]?.id ?? '');
  const [target, setTarget] = useState(people[0]?.id ?? '');
  const [n, setN] = useState(50);
  const [box, setBox] = useState({ x: 0, y: 0, w: 2, h: 2 });
  const [text, setText] = useState('');
  const [pattern, setPattern] = useState(patterns[0]?.id ?? '');
  const describe = (t: Trigger) => {
    const name = (id: string) => enc.combatants[id]?.name ?? '?';
    const w = t.when.kind === 'hpBelow' ? `${name(t.when.combatantId)} 生命低於 ${t.when.percent}%` : t.when.kind === 'round' ? `第 ${t.when.round} 輪` : `有人走進 (${t.when.x + 1},${t.when.y + 1}) 起 ${t.when.w}×${t.when.h} 格`;
    const d = t.then.kind === 'say' ? `說：「${t.then.text}」` : t.then.kind === 'reveal' ? `${name(t.then.combatantId)} 現身` : t.then.kind === 'patterns' ? `${name(t.then.combatantId)} 換彈幕` : `${name(t.then.combatantId)} 變成 ${TIER_NAME[t.then.tier]}`;
    return `${w} → ${d}`;
  };
  const add = () => {
    const w: Trigger['when'] = when === 'hpBelow' ? { kind: 'hpBelow', combatantId: who, percent: n } : when === 'round' ? { kind: 'round', round: n } : { kind: 'enter', ...box };
    const d: Trigger['then'] = then === 'say' ? { kind: 'say', text } : then === 'reveal' ? { kind: 'reveal', combatantId: target } : then === 'patterns' ? { kind: 'patterns', combatantId: target, patterns: [pattern] } : { kind: 'tier', combatantId: target, tier: 'boss' };
    op({ kind: 'trigger', trigger: { when: w, then: d } });
  };
  return (
    <section className="stack tight">
      <h3>觸發器</h3>
      <ul className="list framed">
        {enc.triggers.map((t) => <li key={t.id} className="row"><span className={t.fired ? 'muted' : ''}>{describe(t)}{t.fired ? '（已觸發）' : ''}</span><button className="link" onClick={() => op({ kind: 'untrigger', triggerId: t.id })}>刪除</button></li>)}
        {enc.triggers.length === 0 && <li className="muted small">還沒有觸發器。例如：Boss 生命低於 50% 時說一段台詞、換彈幕。</li>}
      </ul>
      <div className="row wrap">
        <select value={when} onChange={(e) => setWhen(e.target.value as typeof when)} aria-label="條件"><option value="hpBelow">生命低於</option><option value="round">到第幾輪</option><option value="enter">走進區域</option></select>
        {when === 'hpBelow' && <><select value={who} onChange={(e) => setWho(e.target.value)} aria-label="誰">{people.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><input type="number" className="num" value={n} onChange={(e) => setN(Number(e.target.value))} aria-label="百分比" />%</>}
        {when === 'round' && <input type="number" className="num" value={n} onChange={(e) => setN(Number(e.target.value))} aria-label="輪數" />}
        {when === 'enter' && (['x', 'y', 'w', 'h'] as const).map((k) => <input key={k} type="number" className="num" aria-label={{ x: '欄', y: '列', w: '寬', h: '高' }[k]} value={k === 'x' || k === 'y' ? box[k] + 1 : box[k]} onChange={(e) => setBox({ ...box, [k]: Number(e.target.value) - (k === 'x' || k === 'y' ? 1 : 0) })} />)}
      </div>
      <div className="row wrap">
        <select value={then} onChange={(e) => setThen(e.target.value as typeof then)} aria-label="結果"><option value="say">說一段話</option><option value="reveal">讓誰現身</option><option value="patterns">換彈幕</option><option value="tier">升為 Boss</option></select>
        {then === 'say' ? <input value={text} maxLength={300} onChange={(e) => setText(e.target.value)} placeholder="地面開始震動…" aria-label="台詞" />
          : <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="對象">{people.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
        {then === 'patterns' && <select value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="彈幕">{patterns.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        <button onClick={add} disabled={then === 'say' && !text.trim()}>加觸發器</button>
      </div>
    </section>
  );
}

// ---------------- pattern editor ----------------

const KINDS: Emitter['kind'][] = ['fan', 'ring', 'aimed', 'rain', 'laser', 'spiral', 'wall'];
const KIND_NAME: Record<Emitter['kind'], string> = { fan: '扇形', ring: '環形', aimed: '瞄準', rain: '雨', laser: '雷射', spiral: '螺旋', wall: '牆' };

function PatternEditor({ api, roomId, pack, contrast, onClose }: { api: Api; roomId: string; pack: Pack; contrast: boolean; onClose: () => void }) {
  const [list, setList] = useState<PatternDef[]>([]);
  const [editing, setEditing] = useState<PatternDef>({ id: '', name: '新彈幕', emitters: [{ at: 300, kind: 'fan', count: 5, speed: 260, spread: 48, side: 'top', repeat: 3, every: 900 }] });
  const [tier, setTier] = useState(2);
  const [seed, setSeed] = useState(1);
  const act = useAction();
  const load = () => void api.patterns(roomId).then(setList).catch(() => {});
  useEffect(load, [roomId]);
  const setup = useMemo(() => ({ tier: DEFAULT_RULES.tiers[tier], duration: DEFAULT_RULES.tiers[tier].duration, pattern: editing, reduced: false, damage: 0 }), [editing, tier]);
  const setE = (i: number, change: Partial<Emitter>) => setEditing((p) => ({ ...p, emitters: p.emitters.map((e, j) => (j === i ? { ...e, ...change } : e)) }));
  return (
    <aside className="drawer combat-drawer wide" aria-label="彈幕編輯">
      <div className="drawer-head"><h2>彈幕編輯</h2><button className="link" onClick={onClose}>關閉</button></div>
      <div className="row wrap">
        <select aria-label="從現有彈幕開始" value="" onChange={(e) => {
          const p = [...list, ...(pack.combat?.patterns ?? [])].find((x) => x.id === e.target.value);
          if (p) setEditing(list.some((x) => x.id === p.id) ? structuredClone(p) : { ...structuredClone(p), id: '', name: `${p.name}（改）` });
        }}>
          <option value="">從現有彈幕開始…</option>
          {list.length > 0 && <optgroup label="這個房間">{list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
          <optgroup label="規則包">{(pack.combat?.patterns ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
        </select>
        <label className="tick">名稱<input value={editing.name} maxLength={30} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
      </div>
      <div className="pattern-grid">
        <div className="stack tight">
          {editing.emitters.map((e, i) => (
            <fieldset key={i} className="emitter">
              <legend>發射器 {i + 1}</legend>
              <div className="row wrap">
                <select value={e.kind} onChange={(ev) => setE(i, { kind: ev.target.value as Emitter['kind'] })} aria-label="種類">{KINDS.map((k) => <option key={k} value={k}>{KIND_NAME[k]}</option>)}</select>
                <label className="tick">開始(毫秒)<input type="number" className="num" value={e.at} onChange={(ev) => setE(i, { at: Number(ev.target.value) })} /></label>
                <label className="tick">數量<input type="number" className="num" value={e.count} onChange={(ev) => setE(i, { count: Number(ev.target.value) })} /></label>
                <label className="tick">速度<input type="number" className="num" value={e.speed} onChange={(ev) => setE(i, { speed: Number(ev.target.value) })} /></label>
                <label className="tick">重複<input type="number" className="num" value={e.repeat ?? 0} onChange={(ev) => setE(i, { repeat: Number(ev.target.value) })} /></label>
                <label className="tick">間隔<input type="number" className="num" value={e.every ?? 500} onChange={(ev) => setE(i, { every: Number(ev.target.value) })} /></label>
                <select value={e.side ?? 'top'} onChange={(ev) => setE(i, { side: ev.target.value as Emitter['side'] })} aria-label="方向">
                  <option value="top">上</option><option value="bottom">下</option><option value="left">左</option><option value="right">右</option><option value="center">中</option>
                </select>
                {(e.kind === 'fan') && <label className="tick">張角<input type="number" className="num" value={e.spread ?? 48} onChange={(ev) => setE(i, { spread: Number(ev.target.value) })} /></label>}
                {(e.kind === 'wall' || e.kind === 'laser') && <label className="tick">{e.kind === 'wall' ? '缺口' : '寬度'}<input type="number" className="num" value={e.gap ?? (e.kind === 'wall' ? 140 : 40)} onChange={(ev) => setE(i, { gap: Number(ev.target.value) })} /></label>}
                <button className="link" onClick={() => setEditing({ ...editing, emitters: editing.emitters.filter((_, j) => j !== i) })} disabled={editing.emitters.length <= 1}>刪除</button>
              </div>
            </fieldset>
          ))}
          <button onClick={() => setEditing({ ...editing, emitters: [...editing.emitters, { at: 1000, kind: 'aimed', count: 3, speed: 300 }] })} disabled={editing.emitters.length >= 24}>加一個發射器</button>
        </div>
        <div className="stack tight">
          <div className="row wrap">
            <label className="tick">預覽局勢
              <select value={tier} onChange={(e) => setTier(Number(e.target.value))}>{DEFAULT_RULES.tiers.map((t, i) => <option key={t.id} value={i}>{t.label}</option>)}</select>
            </label>
            <button onClick={() => setSeed((s) => s + 1)}>換個亂數</button>
          </div>
          <PatternPreview key={`${seed}-${tier}-${JSON.stringify(editing.emitters)}`} setup={setup} seed={seed} contrast={contrast} />
          <p className="small muted">預覽中線結站著不動。正式閃避時一樣的種子會跑出一樣的彈幕。</p>
        </div>
      </div>
      <div className="row">
        <button className="primary" disabled={act.busy} onClick={() => void act.run(async () => {
          const saved = await api.savePattern(roomId, { ...(editing.id ? { id: editing.id } : {}), name: editing.name, emitters: editing.emitters });
          setEditing(saved);
          load();
        })}>{editing.id ? '儲存變更' : '存成新彈幕'}</button>
        {editing.id && <button className="danger" disabled={act.busy} onClick={() => void act.run(async () => { await api.removePattern(roomId, editing.id); setEditing({ ...editing, id: '' }); load(); })}>刪除這個彈幕</button>}
      </div>
      <ErrorNote of={act} />
      <p className="small muted">房間自訂的彈幕可以在主控台指定給怪物，或用觸發器在戰鬥中換上。</p>
    </aside>
  );
}
