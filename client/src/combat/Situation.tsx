import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomView } from '../api';
import type { CombatantView, DieFace, EncounterEvent, EncounterView, Step } from '../../../src/encounter/types';
import { GESTURE_TEXT } from '../../../src/encounter/weapons';
import { DiceTray, type Tone } from './DiceTray';
import { useCountdown, type Combat } from './state';

/**
 * What is happening right now, said once and plainly: a bar that names the moment (whose turn, who we wait for),
 * a big card when the turn passes or someone falls, the dice tray for the player's own rolls, and small trays
 * that show other rolls landing.
 */

const D20_STEPS = ['initiative', 'attackRoll', 'saveRoll', 'deathSave'] as const;
const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function memberName(view: RoomView, userId: string) {
  return userId === view.me.userId ? '你' : view.members.find((m) => m.userId === userId)?.name ?? '玩家';
}
const isMine = (c: CombatantView | undefined, enc: EncounterView, me: string) => !!c && (c.controller === me || (enc.you.gm && c.controller === 'gm'));

// ---------------- the bar ----------------

export type Mood = 'mine' | 'foe' | 'ally' | 'paused' | 'calm';
export interface Moment { mood: Mood; title: string; detail: string; deadline?: string }

/** One sentence for the screen: what is going on, and what (if anything) this person should do. */
export function momentOf(enc: EncounterView, view: RoomView): Moment {
  const me = view.me.userId, gm = enc.you.gm;
  const st = enc.step, flow = enc.flow;
  const name = (id?: string) => (id && enc.combatants[id]?.name) || '某人';
  const waiting = (s: Step) => s.awaiting.map((u) => memberName(view, u)).join('、');
  if (enc.status === 'initiative') {
    const mine = st?.awaiting.includes(me);
    return { mood: mine ? 'mine' : 'calm', title: '擲先攻', detail: mine ? '換你擲骰' : st?.awaiting.length ? `等 ${waiting(st)} 擲骰` : '決定順序中', deadline: st?.deadline };
  }
  if (enc.status === 'paused') return { mood: 'paused', title: 'GM 暫停了戰鬥', detail: gm ? '按「繼續」恢復' : '請稍等' };
  const actor = enc.turn ? enc.combatants[enc.turn.combatantId] : undefined;
  const moodOf = (c?: CombatantView): Mood => (isMine(c, enc, me) ? 'mine' : c?.side === 'foe' ? 'foe' : 'ally');
  if (st && st.kind !== 'npcPending') {
    const mine = st.awaiting.includes(me);
    const attacker = flow ? enc.combatants[flow.attackerId] : undefined;
    const targets = flow ? flow.targets.map((t) => name(t)).join('、') : '';
    const who = waiting(st);
    switch (st.kind) {
      case 'attackRoll': return { mood: mine ? 'mine' : moodOf(attacker), title: `${name(flow?.attackerId)} 攻擊 ${targets}`, detail: mine ? '換你擲攻擊骰' : `等 ${who} 擲攻擊骰`, deadline: st.deadline };
      case 'attackInteract': return { mood: mine ? 'mine' : moodOf(attacker), title: `${name(flow?.attackerId)} 攻擊 ${targets}`, detail: mine ? `換你做${flow && flow.interaction !== 'none' ? GESTURE_TEXT[flow.interaction].name : '武器操作'}` : `等 ${who} 做武器操作`, deadline: st.deadline };
      case 'saveRoll': return { mood: mine ? 'mine' : moodOf(attacker), title: `${name(flow?.attackerId)} 的${flow?.label ?? '攻擊'}`, detail: mine ? '換你擲豁免' : `等 ${who} 擲豁免`, deadline: st.deadline };
      case 'dodge': return { mood: mine ? 'mine' : 'ally', title: `${name(st.combatantId)} 被${flow?.label ?? '攻擊'}命中`, detail: mine ? '換你閃避！' : `${who} 正在閃避`, deadline: st.deadline };
      case 'deathSave': return { mood: mine ? 'mine' : 'ally', title: `${name(st.combatantId)} 生命垂危`, detail: mine ? '換你擲死亡豁免' : `等 ${who} 擲死亡豁免`, deadline: st.deadline };
      default: break;
    }
  }
  if (!actor) return { mood: 'calm', title: `第 ${enc.round || 1} 輪`, detail: '' };
  if (st?.kind === 'npcPending') {
    return gm ? { mood: 'mine', title: `${actor.name} 的回合（你操作）`, detail: '移動或攻擊；不動的話會自動行動', deadline: st.deadline }
      : { mood: 'foe', title: `${actor.name} 的回合`, detail: '敵人正在行動', deadline: st.deadline };
  }
  if (actor.controller === me) return { mood: 'mine', title: `輪到你：${actor.name}`, detail: '移動或攻擊，做完按「結束回合」' };
  if (gm && actor.controller === 'gm') return { mood: 'mine', title: `${actor.name} 的回合（你操作）`, detail: '移動或攻擊，做完按「結束回合」' };
  const owner = actor.controller === 'gm' ? '' : `（${memberName(view, actor.controller)}）`;
  return { mood: actor.side === 'foe' ? 'foe' : 'ally', title: `${actor.name} 的回合${owner}`, detail: actor.side === 'foe' ? '敵人行動中' : '等他行動' };
}

const MOOD_TAG: Record<Mood, string> = { mine: '你', foe: '敵人', ally: '隊友', paused: '暫停', calm: '戰鬥' };

export function NowBar({ combat, enc, view }: { combat: Combat; enc: EncounterView; view: RoomView }) {
  const m = momentOf(enc, view);
  const left = useCountdown(m.deadline);
  const gm = enc.you.gm;
  const st = enc.step;
  const op = (kind: 'pause' | 'resume' | 'skip' | 'nextTurn') => void combat.send({ type: 'gm', op: { kind } });
  return (
    <div className={`now-bar mood-${m.mood}`} role="status" aria-live="polite">
      <span className="now-tag">{MOOD_TAG[m.mood]}</span>
      <span className="now-text"><b>{m.title}</b>{m.detail && <span>{m.detail}</span>}</span>
      {left !== null && <span className={`now-timer${left < 8000 ? ' urgent' : ''}`}>{Math.ceil(left / 1000)}</span>}
      {gm && (
        <span className="now-gm">
          {enc.status === 'paused' ? <button onClick={() => op('resume')} disabled={combat.busy}>繼續</button> : <button onClick={() => op('pause')} disabled={combat.busy}>暫停</button>}
          {st && st.kind !== 'npcPending' && st.awaiting.length > 0 && <button onClick={() => op('skip')} disabled={combat.busy} title="不等了，照骰子結果算">跳過這步</button>}
          {enc.status === 'active' && !st && !enc.flow && <button onClick={() => op('nextTurn')} disabled={combat.busy}>下一位</button>}
        </span>
      )}
    </div>
  );
}

// ---------------- the big cards ----------------

export interface Splash { key: number; tone: 'mine' | 'foe' | 'ally' | 'down' | 'dead'; title: string; detail?: string }

/** A card in the middle of the map when the turn passes, someone drops or dies. One at a time, newest wins. */
export function useSplash(combat: Combat, view: RoomView) {
  const [splash, setSplash] = useState<Splash | null>(null);
  const seen = useRef(0);
  const enc = combat.encounter;
  useEffect(() => {
    const last = combat.events.at(-1);
    if (!last || !enc) return;
    const first = seen.current === 0;
    const fresh = combat.events.filter((e) => e.seq > seen.current);
    seen.current = last.seq;
    if (first) return;
    let next: Splash | null = null;
    for (const e of fresh) {
      const id = (e.data as { combatantId?: string } | undefined)?.combatantId;
      const c = id ? enc.combatants[id] : undefined;
      if (!c) continue;
      if (e.kind === 'dead') next = { key: e.seq, tone: 'dead', title: `${c.name} 死亡`, detail: c.controller === view.me.userId ? '你的角色死了。GM 可以在主控台讓他復活或離開戰鬥。' : undefined };
      else if (e.kind === 'defeated') next = { key: e.seq, tone: 'down', title: `${c.name} 被擊倒` };
      else if (e.kind === 'down') next = { key: e.seq, tone: 'down', title: `${c.name} 倒下了`, detail: c.controller === view.me.userId ? '輪到你時擲死亡豁免：三次成功穩定，三次失敗死亡。' : '他輪到時要擲死亡豁免' };
      else if (e.kind === 'turn' && (!next || next.tone === 'mine' || next.tone === 'foe' || next.tone === 'ally')) {
        const mine = isMine(c, enc, view.me.userId) && (c.controller !== 'gm' || enc.you.gm);
        next = { key: e.seq, tone: c.controller === view.me.userId ? 'mine' : c.side === 'foe' ? 'foe' : mine ? 'mine' : 'ally', title: c.controller === view.me.userId ? '你的回合' : c.side === 'foe' ? '敵人回合' : `${c.name} 的回合`, detail: c.controller === view.me.userId || c.side === 'foe' ? c.name : undefined };
      }
    }
    if (next) setSplash(next);
  }, [combat.events, enc, view.me.userId]);
  const clear = useCallback((key: number) => setSplash((s) => (s?.key === key ? null : s)), []);
  return { splash, clear };
}

/** Shows itself for a moment, then asks to be cleared. The caller holds it back while dice are still rolling. */
export function SplashCard({ splash, onDone }: { splash: Splash; onDone: (key: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onDone(splash.key), splash.tone === 'dead' || splash.tone === 'down' ? 2600 : 1500);
    return () => clearTimeout(t);
  }, [splash, onDone]);
  return (
    <div className={`splash splash-${splash.tone}`} role="alert" key={splash.key}>
      {splash.tone === 'dead' && <span className="splash-mark" aria-hidden>☠</span>}
      <b>{splash.title}</b>
      {splash.detail && <span>{splash.detail}</span>}
    </div>
  );
}

// ---------------- the player's own throw ----------------

export interface Throw { stepId: string; kind: Step['kind']; title: string; hint: string; count: number }

/** The roll this person has to make now, if any. */
export function throwFor(enc: EncounterView, me: string): Throw | null {
  const st = enc.step;
  if (!st || !(D20_STEPS as readonly string[]).includes(st.kind) || !st.awaiting.includes(me)) return null;
  const flow = enc.flow;
  const name = (id?: string) => (id && enc.combatants[id]?.name) || '';
  if (st.kind === 'initiative') {
    const mine = Object.values(enc.combatants).filter((c) => c.controller === me && c.initiative === null);
    return { stepId: st.id, kind: st.kind, title: '擲先攻', hint: mine.map((c) => c.name).join('、'), count: Math.max(1, mine.length) };
  }
  if (st.kind === 'attackRoll' && flow) {
    const two = flow.mode !== 'normal';
    return { stepId: st.id, kind: st.kind, title: `${flow.label} 攻擊 ${flow.targets.map(name).join('、')}`, hint: two ? (flow.mode === 'advantage' ? '優勢：兩顆取高' : '劣勢：兩顆取低') : '', count: two ? 2 : 1 };
  }
  if (st.kind === 'saveRoll' && flow) {
    const mine = flow.results.filter((r) => enc.combatants[r.combatantId]?.controller === me && !r.save);
    return { stepId: st.id, kind: st.kind, title: `豁免 DC ${flow.dc}`, hint: `${name(flow.attackerId)} 的${flow.label}`, count: Math.max(1, mine.length) };
  }
  return { stepId: st.id, kind: st.kind, title: `${name(st.combatantId)} 的死亡豁免`, hint: '10 以上成功', count: 1 };
}

const ROLL_KINDS = ['initiative', 'attackRoll', 'save', 'deathSave'];
const facesIn = (events: EncounterEvent[], kinds: string[]): DieFace[] =>
  events.filter((e) => kinds.includes(e.kind)).flatMap((e) => ((e.data as { dice?: DieFace[] } | undefined)?.dice ?? []));

function outcomeOf(events: EncounterEvent[]): string {
  const rolls = events.filter((x) => ROLL_KINDS.includes(x.kind));
  return rolls.map((e) => {
    const d = e.data as { total?: number; natural?: number; success?: boolean; dice?: DieFace[] } | undefined;
    const nat = d?.dice?.find((f) => f.sides === 20 && f.kept)?.value ?? d?.natural ?? d?.total ?? 0;
    const total = d?.total ?? nat, mod = total - nat;
    const sum = mod ? `${nat} ${mod > 0 ? '+' : '−'} ${Math.abs(mod)} = ${total}` : String(total);
    if (e.kind === 'attackRoll') return `${sum}${nat === 20 ? '　大成功！' : nat === 1 ? '　大失敗' : ''}`;
    if (e.kind === 'save') return `${sum}　${d?.success ? '成功' : '失敗'}`;
    if (e.kind === 'deathSave') return `${sum}　${nat === 20 ? '醒來！' : nat >= 10 ? '成功' : '失敗'}`;
    return sum;
  }).join('　');
}

/**
 * The tray for this person's own roll. It stays up after the throw until the dice stop, even though the server
 * has already moved on, so the next thing (the weapon gesture, the dodge) comes after the dice, as it should.
 */
export function DiceStage({ combat, aim, frozen, setFrozen, own }: { combat: Combat; aim: Throw | null; frozen: Throw | null; setFrozen: (t: Throw | null) => void; own: React.MutableRefObject<Set<number>> }) {
  const t = frozen ?? aim;
  const [kept, setKept] = useState<boolean[] | undefined>();
  const [outcome, setOutcome] = useState<string | null>(null);
  const pending = useRef('');
  useEffect(() => { if (!frozen) { setKept(undefined); setOutcome(null); } }, [frozen]);
  if (!t) return null;
  const instant = combat.prefs.skipAnimations || prefersReducedMotion();
  return (
    <div className="dice-stage" role="dialog" aria-label={t.title}>
      <div className="dice-stage-head"><b>{t.title}</b>{t.hint && <span>{t.hint}</span>}</div>
      <DiceTray key={t.stepId} mode="throw" dice={Array.from({ length: t.count }, () => ({ sides: 20 }))} label={t.title} instant={instant} kept={kept}
        onThrow={async () => {
          setFrozen(t);
          const events = await combat.send({ type: 'release', stepId: t.stepId });
          if (!events) { setFrozen(null); return null; }
          for (const e of events) own.current.add(e.seq);
          const faces = facesIn(events, ROLL_KINDS).filter((f) => f.sides === 20);
          setKept(faces.map((f) => f.kept));
          // Said only once the dice stop, so the tray keeps its moment.
          pending.current = outcomeOf(events);
          return Array.from({ length: t.count }, (_, i) => faces[i]?.value ?? faces[0]?.value ?? 1);
        }}
        onSettled={() => { setOutcome(pending.current); setTimeout(() => setFrozen(null), instant ? 1200 : 1500); }} />
      {outcome && <p className="dice-outcome">{outcome}</p>}
    </div>
  );
}

// ---------------- other people's rolls ----------------

interface RollToast { key: number; faces: DieFace[]; caption: string; tone: Tone; more: number }

/** Rolls this person cares about (their creatures attack or are attacked), landing in a small tray. */
export function useRollToasts(combat: Combat, view: RoomView, own: React.MutableRefObject<Set<number>>) {
  const [queue, setQueue] = useState<RollToast[]>([]);
  const seen = useRef(0);
  const enc = combat.encounter;
  useEffect(() => {
    const last = combat.events.at(-1);
    if (!last || !enc) return;
    const first = seen.current === 0;
    const fresh = combat.events.filter((e) => e.seq > seen.current);
    seen.current = last.seq;
    if (first) return;
    const me = view.me.userId;
    const c = (id?: string) => (id ? enc.combatants[id] : undefined);
    const mine = (id?: string) => isMine(c(id), enc, me);
    const add: RollToast[] = [];
    for (const e of fresh) {
      if (own.current.has(e.seq)) continue;
      const d = (e.data ?? {}) as { combatantId?: string; attackerId?: string; targets?: string[]; dice?: DieFace[]; total?: number; success?: boolean; damage?: { total: number; dice?: DieFace[] }; critical?: boolean };
      const attacker = c(d.attackerId ?? (e.kind === 'attackRoll' ? d.combatantId : undefined));
      const tone: Tone = attacker?.side === 'foe' ? 'garnet' : 'ivory';
      let faces: DieFace[] = [], caption = '';
      if (e.kind === 'attackRoll' && (mine(d.combatantId) || d.targets?.some(mine))) {
        faces = d.dice ?? [];
        caption = `${c(d.combatantId)?.name ?? '?'} 的攻擊骰 ${d.total}`;
      } else if (e.kind === 'hit' && (mine(d.combatantId) || mine(d.attackerId))) {
        faces = d.damage?.dice ?? [];
        caption = `${d.critical ? '重擊！' : ''}傷害骰 ${d.damage?.total}`;
      } else if (e.kind === 'damageRoll' && (mine(d.attackerId) || d.targets?.some(mine))) {
        faces = d.damage?.dice ?? [];
        caption = `傷害骰 ${d.damage?.total}`;
      } else if (e.kind === 'save' && (mine(d.combatantId) || mine(d.attackerId))) {
        faces = d.dice ?? [];
        caption = `${c(d.combatantId)?.name ?? '?'} 豁免 ${d.total}・${d.success ? '成功' : '失敗'}`;
      } else if (e.kind === 'deathSave') {
        faces = d.dice ?? [];
        caption = `${c(d.combatantId)?.name ?? '?'} 的死亡豁免 ${d.total}`;
      }
      if (!faces.length) continue;
      add.push({ key: e.seq, faces: faces.slice(0, 8), caption, tone, more: Math.max(0, faces.length - 8) });
    }
    if (add.length) setQueue((q) => [...q, ...add].slice(-3));
  }, [combat.events, enc, view.me.userId, own]);
  return { current: queue[0] ?? null, next: () => setQueue((q) => q.slice(1)) };
}

export function RollToastView({ toast, instant, onDone }: { toast: RollToast; instant: boolean; onDone: () => void }) {
  return (
    <div className="roll-toast" role="status" aria-label={toast.caption}>
      <DiceTray key={toast.key} small mode="auto" dice={toast.faces.map((f) => ({ sides: f.sides }))} values={toast.faces.map((f) => f.value)}
        kept={toast.faces.map((f) => f.kept)} tone={toast.tone} instant={instant} label={toast.caption}
        onSettled={() => setTimeout(onDone, instant ? 1800 : 1200)} />
      <p>{toast.caption}{toast.more ? `（另外 ${toast.more} 顆）` : ''}</p>
    </div>
  );
}

export const reducedMotion = prefersReducedMotion;
