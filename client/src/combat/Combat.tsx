import { useEffect, useMemo, useRef, useState } from 'react';
import type { MapView, Pack, RoomView } from '../api';
import { hasSheet } from '../api';
import { ErrorNote } from '../parts/ui';
import { areaCells, blockMap, canSee, feetBetween, walkCosts, type Footprint, type Grid } from '../../../src/encounter/geometry';
import { CONDITION_LABEL, type AreaShape, type AttackSource, type CombatantView, type DodgeSetup, type EncounterEvent, type EncounterView, type MonsterAttack } from '../../../src/encounter/types';
import { GESTURE_TEXT } from '../../../src/encounter/weapons';
import { DodgePlay, DodgeReplay } from './Arena';
import { GesturePad } from './Gesture';
import { GmConsole, EncounterSetup } from './Gm';
import { useCountdown, type Cell, type Combat } from './state';

export const STEP_NAME: Record<string, string> = {
  initiative: '擲先攻', attackRoll: '攻擊擲骰', attackInteract: '武器操作', saveRoll: '豁免擲骰', dodge: '閃避', deathSave: '死亡豁免', npcPending: 'NPC 行動',
};
const SIDE_NAME = { party: '隊伍', ally: '盟友', foe: '敵人' } as const;

/** What the map draws on top of itself during a fight. */
export interface MapOverlay {
  tokens: Record<string, { c: CombatantView; turn: boolean }>;
  /** Tokens that can be picked as a target now. */
  targets: Set<string>;
  /** Squares the acting creature can still walk to. */
  reach: Cell[];
  /** Squares an area attack would cover. */
  area: Cell[];
  pickToken?: (tokenId: string) => void;
  pickCell?: (c: Cell) => void;
}

interface Choice { source: AttackSource; label: string; detail: string; reach: number; area?: AreaShape; ranged: boolean }

/** Every way the acting creature can attack, worked out from the pack the same way the server does. */
function choicesFor(c: CombatantView, pack: Pack, view: RoomView): Choice[] {
  const combat = pack.combat;
  if (!combat) return [];
  if (c.characterId) {
    const ch = view.characters.find((x) => x.id === c.characterId);
    const caster = ch && hasSheet(ch) ? (ch.sheet.cast?.value ?? 0) > 0 : false;
    const weapons = combat.weapons.map((w): Choice => ({
      source: { kind: 'weapon', id: w.id }, label: w.label, ranged: !!w.range && !w.reach,
      detail: `${w.damage} ${w.damageType}・${w.range ? `射程 ${w.range[0]}/${w.range[1]} 呎` : `觸及 ${w.reach ?? 5} 呎`}・${w.interaction === 'none' ? '' : GESTURE_TEXT[w.interaction].name}`,
      reach: w.range ? w.range[1] : w.reach ?? 5,
    }));
    const spells = caster ? combat.spells.filter((s) => s.level === 0).map((s): Choice => ({
      source: { kind: 'spell', id: s.id }, label: s.label, ranged: s.range > 5, area: s.area,
      detail: `${s.save ? `${s.save.toUpperCase()} 豁免` : '法術攻擊'}・${s.range} 呎${s.area ? `・${s.area.size} 呎範圍` : ''}`, reach: s.range,
    })) : [];
    return [...weapons, ...spells];
  }
  const attacks: MonsterAttack[] = c.custom?.attacks ?? combat.monsters.find((m) => m.id === c.monsterId)?.attacks ?? [];
  return attacks.map((a): Choice => ({
    source: { kind: 'monster', id: a.id }, label: a.label, ranged: !!a.range, area: a.area,
    detail: `${a.save ? `DC ${a.save.dc} ${a.save.attr.toUpperCase()} 豁免` : `+${a.bonus ?? 0} 命中`}・${a.damage}${a.area ? `・${a.area.size} 呎${a.area.kind === 'cone' ? '錐形' : a.area.kind === 'line' ? '直線' : '範圍'}` : ''}`,
    reach: a.range ? a.range[1] : a.area ? (a.range?.[0] ?? a.area.size) : a.reach ?? 5,
  }));
}

/** The geometry the client needs to highlight what is legal; the server checks the same things again. */
export function useGeometry(data: MapView | null, cellRule: Grid['rule']) {
  return useMemo(() => {
    if (!data) return null;
    const grid: Grid = { cols: data.map.cols, rows: data.map.rows, cellDistance: data.map.cellDistance, rule: cellRule };
    const blocks = blockMap(grid, data.objects);
    const foot = (tokenId: string): Footprint | null => {
      const t = data.tokens.find((x) => x.id === tokenId);
      return t ? { x: t.x, y: t.y, size: t.size, elevation: t.elevation ?? 0 } : null;
    };
    return { grid, blocks, foot };
  }, [data, cellRule]);
}

export function useCombatOverlay(combat: Combat, data: MapView | null, pack: Pack, view: RoomView): MapOverlay | null {
  const enc = combat.encounter;
  const geo = useGeometry(data, pack.combat?.rules.distance ?? 'chebyshev');
  return useMemo(() => {
    if (!enc || enc.status === 'ended' || !data || !geo || enc.mapId !== data.map.id) return null;
    const tokens: MapOverlay['tokens'] = {};
    for (const c of Object.values(enc.combatants)) tokens[c.tokenId] = { c, turn: enc.turn?.combatantId === c.id };
    const actor = enc.turn ? enc.combatants[enc.turn.combatantId] : undefined;
    const me = view.me.userId, gm = enc.you.gm;
    const mine = actor && (actor.controller === me || (gm && actor.controller === 'gm'));
    const overlay: MapOverlay = { tokens, targets: new Set(), reach: [], area: [] };
    if (!actor || !mine || enc.status !== 'active' || enc.step || enc.flow) return overlay;
    const from = geo.foot(actor.tokenId);
    if (!from) return overlay;
    const p = combat.picking;
    if (!p) {
      const t = enc.turn!;
      const speed = actor.conditions.includes('restrained') ? 0 : actor.conditions.includes('prone') ? Math.floor(actor.speed / 2) : actor.speed;
      const left = speed * (t.dashed ? 2 : 1) - t.movementUsed;
      if (left > 0 && actor.hp !== 0) {
        const hostile = Object.values(enc.combatants).filter((o) => o.id !== actor.id && !o.defeated && !o.dead && (o.side === 'foe') !== (actor.side === 'foe'));
        const costs = walkCosts(geo.grid, geo.blocks, from, hostile.map((o) => geo.foot(o.tokenId)).filter((f): f is Footprint => !!f), left);
        for (const cell of costs.keys()) overlay.reach.push({ x: cell % geo.grid.cols, y: Math.floor(cell / geo.grid.cols) });
      }
      return overlay;
    }
    const choice = choicesFor(actor, pack, view).find((x) => x.source.kind === p.source.kind && x.source.id === p.source.id);
    if (!choice) return overlay;
    if (p.kind === 'target') {
      for (const o of Object.values(enc.combatants)) {
        if (o.id === actor.id || o.defeated || o.dead) continue;
        const f = geo.foot(o.tokenId);
        if (!f || feetBetween(geo.grid, from, f) > choice.reach || !canSee(geo.grid, geo.blocks, from, f)) continue;
        overlay.targets.add(o.tokenId);
      }
      overlay.pickToken = (tokenId) => {
        const target = Object.values(enc.combatants).find((o) => o.tokenId === tokenId);
        if (target) void combat.send({ type: 'attack', combatantId: actor.id, source: p.source, targets: [target.id] }).then((ok) => { if (ok) combat.setPicking(null); });
      };
    } else {
      overlay.pickCell = (c) => combat.setPicking({ ...p, point: c });
      if (p.point) overlay.area = areaCells(geo.grid, choice.area!, from, p.point);
    }
    return overlay;
  }, [enc, data, geo, combat, pack, view]);
}

// ---------------- the dock ----------------

export function CombatDock({ combat, view, pack, data }: { combat: Combat; view: RoomView; pack: Pack; data: MapView | null }) {
  const enc = combat.encounter;
  const gm = view.me.role === 'gm';
  const [console, setConsole] = useState(false);
  const [setup, setSetup] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [feed, setFeed] = useState(false);
  const replay = useReplays(combat, view);
  const result = useLatestResult(combat.events);
  const running = enc && enc.status !== 'ended';

  return (
    <>
      {running && <InitiativeBar enc={enc} />}
      <div className="combat-bar" role="toolbar" aria-label="戰鬥">
        {running ? <span className="round">第 {enc.round || 1} 輪{enc.status === 'paused' ? '・暫停中' : enc.status === 'initiative' ? '・擲先攻' : ''}</span>
          : gm ? <button className="primary" onClick={() => setSetup(true)} disabled={!data}>開始戰鬥</button> : null}
        {running && <button aria-expanded={feed} onClick={() => setFeed((v) => !v)}>戰鬥紀錄</button>}
        <button aria-expanded={prefsOpen} onClick={() => setPrefsOpen((v) => !v)}>戰鬥設定</button>
        {gm && running && <button aria-expanded={console} onClick={() => setConsole((v) => !v)}>GM 主控台</button>}
      </div>
      {running && <StepPanel combat={combat} enc={enc} view={view} pack={pack} />}
      {running && <TurnPanel combat={combat} enc={enc} view={view} pack={pack} />}
      {feed && running && <EventFeed events={combat.events} gm={gm} onReplay={replay.open} onClose={() => setFeed(false)} />}
      {prefsOpen && <PrefsPanel combat={combat} onClose={() => setPrefsOpen(false)} />}
      {console && gm && enc && <GmConsole combat={combat} enc={enc} pack={pack} view={view} data={data} onClose={() => setConsole(false)} />}
      {setup && gm && data && <EncounterSetup combat={combat} view={view} pack={pack} data={data} onClose={() => setSetup(false)} />}
      {replay.current && (
        <div className="replay-pop" role="dialog" aria-label="閃避重播">
          <div className="row"><b>{replay.current.title}</b><span className="spacer" /><button className="link" onClick={replay.close}>關閉重播</button></div>
          <DodgeReplay setup={replay.current.setup} seed={replay.current.seed} moves={replay.current.moves} contrast={combat.prefs.highContrast} onEnd={() => setTimeout(replay.close, 1500)} />
        </div>
      )}
      {result && <div className="result-banner" role="status">{result}</div>}
      {combat.error && <ErrorNote of={combat.error} className="map-toast combat-toast" />}
    </>
  );
}

function hpBar(c: CombatantView) {
  if (c.hp === null || c.maxHp === null) return null;
  const pct = Math.max(0, Math.min(100, (c.hp / Math.max(1, c.maxHp)) * 100));
  return <span className="hp" aria-hidden><span style={{ width: `${pct}%` }} className={pct <= 25 ? 'low' : ''} /></span>;
}

function InitiativeBar({ enc }: { enc: EncounterView }) {
  const order = enc.order.length ? enc.order : Object.keys(enc.combatants);
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => { ref.current?.querySelector('.now')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); }, [enc.turn?.combatantId]);
  return (
    <ol className="initiative" ref={ref} aria-label="先攻順序">
      {order.map((id) => {
        const c = enc.combatants[id];
        if (!c) return null;
        const now = enc.turn?.combatantId === id;
        return (
          <li key={id} className={`${now ? 'now' : ''} side-${c.side}${c.defeated || c.dead ? ' out' : ''}${c.hidden ? ' secret' : ''}`} aria-current={now ? 'step' : undefined}>
            <span className="init">{c.initiative ?? '—'}</span>
            <span className="who">
              <b>{c.name}</b>
              <small>{c.hp !== null ? `${c.hp}/${c.maxHp}` : c.health}{c.tempHp ? ` +${c.tempHp}` : ''}{c.ac !== null ? `・AC ${c.ac}` : ''}</small>
              {hpBar(c)}
              {c.conditions.length > 0 && <small className="conds">{c.conditions.map((k) => CONDITION_LABEL[k]).join('、')}</small>}
              {c.dying && <small className="conds">死亡豁免 ✓{c.dying.successes} ✗{c.dying.failures}</small>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------- steps ----------------

function StepPanel({ combat, enc, view, pack }: { combat: Combat; enc: EncounterView; view: RoomView; pack: Pack }) {
  const st = enc.step;
  const left = useCountdown(st?.deadline);
  const me = view.me.userId;
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => setResult(null), [st?.id]);
  if (!st || st.kind === 'npcPending') return null;
  const mine = st.awaiting.includes(me);
  const flow = enc.flow;
  const who = st.combatantId ? enc.combatants[st.combatantId] : undefined;
  const attacker = flow ? enc.combatants[flow.attackerId] : undefined;
  const secs = left === null ? '' : `${Math.ceil(left / 1000)} 秒`;
  if (!mine) {
    const names = st.awaiting.map((u) => view.members.find((m) => m.userId === u)?.name ?? '玩家').join('、');
    return (
      <div className="step-wait" aria-live="polite">
        {st.awaiting.length ? `等待 ${names}：${STEP_NAME[st.kind]}${who ? `（${who.name}）` : ''}` : STEP_NAME[st.kind]}
        <span className="muted">　{secs}</span>
      </div>
    );
  }
  const release = (label: string, hint: string) => (
    <DiceButton label={label} hint={hint} busy={combat.busy} onRelease={() => void combat.send({ type: 'release', stepId: st.id })} />
  );
  let body: React.ReactNode;
  if (st.kind === 'initiative') {
    const mineToRoll = Object.values(enc.combatants).filter((c) => c.controller === me && c.initiative === null);
    body = <>{release('擲先攻', mineToRoll.map((c) => c.name).join('、'))}</>;
  } else if (st.kind === 'attackRoll' && flow) {
    const targets = flow.targets.map((t) => enc.combatants[t]?.name ?? '目標').join('、');
    body = <>{release(`擲攻擊骰：${flow.label}`, `${attacker?.name} 攻擊 ${targets}${flow.mode === 'advantage' ? '（優勢，擲兩顆取高）' : flow.mode === 'disadvantage' ? '（劣勢，擲兩顆取低）' : ''}`)}</>;
  } else if (st.kind === 'attackInteract' && flow && flow.interaction !== 'none') {
    body = (
      <>
        <p className="step-dice">攻擊擲骰 <b>{flow.roll?.total}</b>（{flow.roll?.text}）　現在做{GESTURE_TEXT[flow.interaction].name}，品質好可以加 +1 或 +2。</p>
        {result ? <p>{result}</p> : (
          <GesturePad kind={flow.interaction} seed={st.seed} oneKey={combat.prefs.oneKey} contrast={combat.prefs.highContrast}
            runes={4 + Math.min(3, flow.source.kind === 'spell' ? pack.combat?.spells.find((s) => s.id === flow.source.id)?.level ?? 0 : 0)}
            onDone={(input, preview) => { setResult(`送出中…（預估品質 ${Math.round(preview * 100)}%）`); void combat.send({ type: 'gesture', stepId: st.id, input }); }} />
        )}
      </>
    );
  } else if (st.kind === 'saveRoll' && flow) {
    const dmg = flow.results[0]?.damage;
    body = <>{release(`擲豁免：DC ${flow.dc}`, `${attacker?.name} 的${flow.label}，傷害已擲出 ${dmg?.total ?? '?'}（${dmg?.text ?? ''}）`)}</>;
  } else if (st.kind === 'dodge' && st.dodge && who) {
    body = <DodgeStep key={st.id} combat={combat} stepId={st.id} setup={st.dodge} seed={st.seed} begun={!!st.begunAt} who={who.name} flowLabel={flow?.label ?? ''} />;
  } else if (st.kind === 'deathSave' && who) {
    body = <>{release(`${who.name} 的死亡豁免`, '擲 d20：10 以上成功，三次成功穩定，三次失敗死亡；20 直接醒來。')}</>;
  }
  return (
    <div className="step-panel" role="dialog" aria-label={STEP_NAME[st.kind]}>
      <div className="row"><b>{STEP_NAME[st.kind]}</b><span className="spacer" /><span className={`timer${left !== null && left < 8000 ? ' urgent' : ''}`}>{secs}</span></div>
      {body}
    </div>
  );
}

/** Press and hold to shake the dice, let go to throw; Space or Enter does the same. The server rolls. */
function DiceButton({ label, hint, busy, onRelease }: { label: string; hint: string; busy: boolean; onRelease: () => void }) {
  const [shaking, setShaking] = useState(false);
  const fire = () => { if (shaking && !busy) onRelease(); setShaking(false); };
  return (
    <div className="dice-step">
      <p className="small muted">{hint}</p>
      <button className={`dice-throw${shaking ? ' shaking' : ''}`} disabled={busy}
        onPointerDown={() => setShaking(true)} onPointerUp={fire} onPointerLeave={() => setShaking(false)}
        onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); setShaking(true); } }}
        onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!busy) onRelease(); setShaking(false); } }}>
        <span className="die" aria-hidden>d20</span>
        <span>{shaking ? '放開擲出' : label}</span>
      </button>
      <p className="small muted">按住搖骰，放開就擲出；骰子由伺服器擲。</p>
    </div>
  );
}

function DodgeStep({ combat, stepId, setup, seed, begun, who, flowLabel }: { combat: Combat; stepId: string; setup: DodgeSetup; seed: number; begun: boolean; who: string; flowLabel: string }) {
  const [phase, setPhase] = useState<'ready' | 'play' | 'sent'>(begun ? 'sent' : 'ready');
  const [hits, setHits] = useState(0);
  const factors = [0.5, 0.75, 1, 1.1, 1.25];
  if (phase === 'ready') {
    return (
      <div className="stack tight">
        <p className="step-dice">{flowLabel}命中 {who}，傷害已擲出 <b>{setup.damage}</b>。閃避決定最後吃下幾成。</p>
        <p className="small">局勢：<b>{setup.tier.label}</b>・{setup.duration / 1000} 秒・{setup.pattern.name}{setup.reduced ? '・減量模式（彈速較慢）' : ''}</p>
        <p className="small muted">被打中 0 次 ×0.5、1 次 ×0.75、2 次 ×1、3 次 ×1.1、4 次以上 ×1.25（無條件捨去，至少 1）。開始後中斷不能重來。</p>
        <p className="small muted">鍵盤：方向鍵或 WASD。手機：手指放在場內任何地方滑動。</p>
        <button className="primary" disabled={combat.busy} onClick={() => void combat.send({ type: 'begin', stepId }).then((ok) => { if (ok) setPhase('play'); })}>開始閃避</button>
      </div>
    );
  }
  if (phase === 'play') {
    return <DodgePlay setup={setup} seed={seed} contrast={combat.prefs.highContrast} onDone={(moves, h) => { setHits(h); setPhase('sent'); void combat.send({ type: 'dodge', stepId, moves }); }} />;
  }
  return <p>閃避結束：被打中 {hits} 次，傷害 ×{factors[Math.min(hits, 4)]}。{begun && hits === 0 ? '（這次閃避已經開始過，等時間到或 GM 處理）' : ''}</p>;
}

// ---------------- the turn ----------------

function TurnPanel({ combat, enc, view, pack }: { combat: Combat; enc: EncounterView; view: RoomView; pack: Pack }) {
  const t = enc.turn;
  const actor = t ? enc.combatants[t.combatantId] : undefined;
  const me = view.me.userId, gm = enc.you.gm;
  const [weapon, setWeapon] = useState<string>(() => { try { return localStorage.getItem('fateweave:weapon') ?? ''; } catch { return ''; } });
  if (!t || !actor || enc.status !== 'active' || enc.flow || (enc.step && enc.step.kind !== 'npcPending')) return null;
  if (!(actor.controller === me || (gm && actor.controller === 'gm'))) return null;
  const choices = choicesFor(actor, pack, view);
  const speed = actor.conditions.includes('restrained') ? 0 : actor.conditions.includes('prone') ? Math.floor(actor.speed / 2) : actor.speed;
  const moveLeft = speed * (t.dashed ? 2 : 1) - t.movementUsed;
  const canAttack = !t.actionUsed || t.attacksLeft > 0;
  const p = combat.picking;
  const weapons = choices.filter((c) => c.source.kind === 'weapon');
  const others = choices.filter((c) => c.source.kind !== 'weapon');
  const pickedWeapon = weapons.find((w) => w.source.id === weapon) ?? weapons[0];
  const start = (c: Choice) => combat.setPicking(c.area ? { kind: 'area', source: c.source, combatantId: actor.id } : { kind: 'target', source: c.source, combatantId: actor.id });
  const targetsInList = p?.kind === 'target' ? Object.values(enc.combatants).filter((o) => o.id !== actor.id && !o.defeated && !o.dead) : [];

  return (
    <div className="turn-panel" aria-label={`${actor.name} 的回合`}>
      <div className="row">
        <b>{actor.name} 的回合</b>
        <small className="muted">移動剩 {Math.max(0, moveLeft)} 呎・{canAttack ? (t.actionUsed ? `還能攻擊 ${t.attacksLeft} 次` : '動作可用') : '動作已用'}</small>
        <span className="spacer" />
        {gm && actor.controller === 'gm' && <button disabled={combat.busy} onClick={() => void combat.send({ type: 'gm', op: { kind: 'auto' } })}>交給自動</button>}
      </div>
      {p ? (
        <div className="stack tight">
          <p className="small">{p.kind === 'target' ? '點地圖上發光的目標，或從下面選。' : p.point ? '確認範圍後按「施放」。' : '點地圖選範圍的位置。'}</p>
          {p.kind === 'target' && (
            <div className="row wrap">
              {targetsInList.map((o) => (
                <button key={o.id} disabled={combat.busy} onClick={() => void combat.send({ type: 'attack', combatantId: actor.id, source: p.source, targets: [o.id] }).then((ok) => { if (ok) combat.setPicking(null); })}>
                  {o.name}<small className="muted">　{SIDE_NAME[o.side]}</small>
                </button>
              ))}
            </div>
          )}
          <div className="row">
            {p.kind === 'area' && <button className="primary" disabled={!p.point || combat.busy}
              onClick={() => void combat.send({ type: 'attack', combatantId: actor.id, source: p.source, targets: [], point: p.point }).then((ok) => { if (ok) combat.setPicking(null); })}>施放</button>}
            <button onClick={() => combat.setPicking(null)}>取消攻擊</button>
          </div>
        </div>
      ) : (
        <>
          <div className="row wrap">
            {weapons.length > 0 && (
              <>
                <label className="tick">武器
                  <select value={pickedWeapon?.source.id} onChange={(e) => { setWeapon(e.target.value); try { localStorage.setItem('fateweave:weapon', e.target.value); } catch { /* storage off */ } }}>
                    {weapons.map((w) => <option key={w.source.id} value={w.source.id}>{w.label}</option>)}
                  </select>
                </label>
                {pickedWeapon && <button className="primary" disabled={!canAttack || combat.busy} onClick={() => start(pickedWeapon)} title={pickedWeapon.detail}>攻擊</button>}
              </>
            )}
            {others.map((c) => <button key={`${c.source.kind}:${c.source.id}`} className={c.source.kind === 'monster' ? 'primary' : ''} disabled={!canAttack || combat.busy || (!!c.area && t.actionUsed) || (c.source.kind === 'spell' && t.actionUsed)} onClick={() => start(c)} title={c.detail}>{c.label}</button>)}
          </div>
          {pickedWeapon && <p className="small muted">{pickedWeapon.detail}</p>}
          <div className="row wrap">
            <button disabled={t.actionUsed || combat.busy} onClick={() => void combat.send({ type: 'dash', combatantId: actor.id })}>衝刺</button>
            <button disabled={t.actionUsed || combat.busy} onClick={() => void combat.send({ type: 'dodgeAction', combatantId: actor.id })}>閃避動作</button>
            <span className="spacer" />
            <button className="primary" disabled={combat.busy} onClick={() => void combat.send({ type: 'endTurn', combatantId: actor.id })}>結束回合</button>
          </div>
          <p className="small muted">在地圖上拖曳代幣移動（淡綠色的格子走得到）。</p>
        </>
      )}
    </div>
  );
}

// ---------------- feed, replays, settings ----------------

function EventFeed({ events, gm, onReplay, onClose }: { events: EncounterEvent[]; gm: boolean; onReplay: (e: EncounterEvent) => void; onClose: () => void }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => { list.current?.lastElementChild?.scrollIntoView({ block: 'nearest' }); }, [events.length]);
  return (
    <div className="event-feed">
      <div className="row"><b>戰鬥紀錄</b><span className="spacer" /><button className="link" onClick={onClose}>收起</button></div>
      <ol ref={list}>
        {events.slice(-60).map((e) => (
          <li key={e.seq} className={`ev-${e.kind}${e.gmOnly ? ' secret' : ''}`}>
            {e.text}
            {e.kind === 'dodge' && (e.data as { moves?: string })?.moves !== undefined && <button className="link small" onClick={() => onReplay(e)}>重播</button>}
            {e.gmOnly && gm && <small className="muted">（只有 GM）</small>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The outcome of the last attack, shown to everyone for a few seconds after it lands. */
function useLatestResult(events: EncounterEvent[]) {
  const [text, setText] = useState<string | null>(null);
  const seen = useRef(0);
  useEffect(() => {
    const last = events.at(-1);
    if (!last) return;
    const first = seen.current === 0;
    const fresh = events.filter((e) => e.seq > seen.current && ['resolved', 'down', 'defeated', 'dead', 'phase', 'trigger'].includes(e.kind));
    seen.current = last.seq;
    if (first || fresh.length === 0) return;
    setText(fresh.map((e) => e.text).join('　'));
    const t = setTimeout(() => setText(null), 6000);
    return () => clearTimeout(t);
  }, [events]);
  return text;
}

interface ReplayItem { title: string; setup: DodgeSetup; seed: number; moves: string }
function useReplays(combat: Combat, view: RoomView) {
  const [current, setCurrent] = useState<ReplayItem | null>(null);
  const seen = useRef(0);
  const asItem = (e: EncounterEvent): ReplayItem | null => {
    const d = e.data as { setup?: DodgeSetup; seed?: number; moves?: string } | undefined;
    return d?.setup && d.seed !== undefined && d.moves !== undefined ? { title: e.text, setup: d.setup, seed: d.seed, moves: d.moves } : null;
  };
  useEffect(() => {
    const last = combat.events.at(-1);
    if (!last) return;
    const first = seen.current === 0;
    const fresh = combat.events.filter((e) => e.seq > seen.current);
    seen.current = last.seq;
    // Others watch a dodge right after it happens, unless they turned replays or animations off.
    if (first || !combat.prefs.watchReplays || combat.prefs.skipAnimations) return;
    const enc = combat.encounter;
    for (const e of fresh) {
      if (e.kind !== 'dodge') continue;
      const d = e.data as { combatantId?: string } | undefined;
      const c = d?.combatantId ? enc?.combatants[d.combatantId] : undefined;
      if (c && c.controller === view.me.userId) continue;
      const item = asItem(e);
      if (item) setCurrent(item);
    }
  }, [combat.events, combat.prefs, combat.encounter, view.me.userId]);
  return { current, open: (e: EncounterEvent) => setCurrent(asItem(e)), close: () => setCurrent(null) };
}

function PrefsPanel({ combat, onClose }: { combat: Combat; onClose: () => void }) {
  const p = combat.prefs;
  return (
    <div className="token-card prefs" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="row"><b>我的戰鬥設定</b><span className="spacer" /><button className="link" onClick={onClose}>收起</button></div>
      <fieldset className="stack tight">
        <legend className="small">互動程度</legend>
        {([['full', '完整：擲骰、武器操作、閃避都自己來'], ['reduced', '減量：一樣自己來，但彈幕比較慢'], ['off', '關閉：全部自動擲骰，直接照骰子結算']] as const).map(([v, label]) => (
          <label key={v} className="tick"><input type="radio" name="interaction" checked={p.interaction === v} onChange={() => void combat.savePrefs({ interaction: v })} />{label}</label>
        ))}
      </fieldset>
      <label className="tick"><input type="checkbox" checked={p.oneKey} onChange={(e) => void combat.savePrefs({ oneKey: e.target.checked })} />武器操作改用單鍵（空白鍵或點一下）</label>
      <label className="tick"><input type="checkbox" checked={p.highContrast} onChange={(e) => void combat.savePrefs({ highContrast: e.target.checked })} />高對比彈幕</label>
      <label className="tick"><input type="checkbox" checked={p.watchReplays} onChange={(e) => void combat.savePrefs({ watchReplays: e.target.checked })} />別人閃避後自動播重播</label>
      <label className="tick"><input type="checkbox" checked={p.skipAnimations} onChange={(e) => void combat.savePrefs({ skipAnimations: e.target.checked })} />略過所有動畫</label>
    </div>
  );
}
