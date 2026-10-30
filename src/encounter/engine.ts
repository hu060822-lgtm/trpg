import { evaluate, type Evaluation } from '../pack/expr';
import { checkFormula, rollOnSheet, type Pack, type Sheet } from '../pack/pack';
import type { Rng } from '../rules/dice';
import { pickPattern, runDodge, ticksFor, validMoves } from './dodge';
import { areaCells, canSee, feetBetween, touches, walkCosts, type BlockMap, type Footprint, type Grid } from './geometry';
import { bonusFor, factorFor, healthWords, scaledDamage, tierFor } from './rules';
import type {
  AttackFlow, AttackSource, CombatPrefs, Combatant, CombatantView, Condition, EncounterState, EncounterView, GestureInput,
  Interaction, Monster, MonsterAttack, PackCombat, PatternDef, Step, StepKind, TargetResult, Tier, Trigger,
} from './types';
import { CONDITION_LABEL, CONDITIONS, type DieFace, type SetupEntry } from './types';
export type { SetupEntry } from './types';
import { cleanTeam, hostileTo, teamOf, teamsIn } from './teams';
import { challengeFor, scoreGesture } from './weapons';

/**
 * The combat state machine. Pure: it takes the encounter, a context (the pack, the map, the sheets, a dice roller,
 * the clock) and one command, and returns the next encounter plus what happened. The server loads, locks, runs this
 * and saves; nothing here touches the database or the network, so every rule can be tested directly.
 *
 * Order inside an attack, as the GM asked: dice first, interaction after. Attack roll → weapon gesture → hit check →
 * damage roll → (saves) → dodge → damage applied. Interactions only adjust a result inside the pack's limits.
 */

export class CombatError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface TokenInfo { id: string; name: string; x: number; y: number; size: number; elevation: number; hidden: boolean; characterId: string | null; ownerUserId: string }

export interface Ctx {
  pack: Pack;
  combat: PackCombat;
  /** Pack patterns and the room's own. */
  patterns: PatternDef[];
  rng: Rng;
  now: Date;
  id: () => string;
  seed: () => number;
  grid: Grid;
  blocks: BlockMap;
  tokens: Map<string, TokenInfo>;
  sheets: Map<string, Sheet>;
  prefs: (userId: string) => CombatPrefs;
  /** The table's name for a user, for log lines. */
  name: (userId: string) => string;
}

export interface OutEvent { kind: string; text: string; gmOnly?: boolean; log?: boolean; data?: unknown }
export interface Outcome {
  state: EncounterState;
  events: OutEvent[];
  moves: { tokenId: string; x: number; y: number }[];
  reveals: string[];
  vitals: { characterId: string; hp: number }[];
}

export interface Caller { userId: string; gm: boolean }

const DEADLINE: Record<StepKind, number> = { initiative: 60000, attackRoll: 30000, attackInteract: 30000, saveRoll: 30000, dodge: 30000, deathSave: 30000, npcPending: 3000 };
/** Grace after a dodge's own length before it counts as abandoned. */
const DODGE_GRACE = 8000;

// ---------- setup ----------


export function createEncounter(ctx: Ctx, roomId: string, mapId: string, entries: SetupEntry[], opts: { mode?: EncounterState['mode']; autoNpc?: boolean; showFoeHp?: boolean; autoEnd?: boolean } = {}): Outcome {
  if (entries.length === 0) throw new CombatError(400, 'bad-request', '至少要選一個代幣加入戰鬥');
  if (entries.length > 60) throw new CombatError(400, 'bad-request', '一場戰鬥最多 60 個參戰者');
  const combatants: Record<string, Combatant> = {};
  for (const e of entries) {
    const c = combatantFrom(ctx, e);
    combatants[c.id] = c;
  }
  const state: EncounterState = {
    id: ctx.id(), roomId, mapId, status: 'initiative', round: 0, order: [], turnIndex: 0, mode: opts.mode ?? 'full',
    combatants, turn: null, step: null, flow: null, triggers: [], autoNpc: !!opts.autoNpc, showFoeHp: !!opts.showFoeHp, autoEnd: opts.autoEnd ?? true, seq: 0,
  };
  const eng = new Engine(state, ctx);
  eng.say('started', `戰鬥開始：${Object.values(combatants).filter((c) => !c.hidden).map((c) => c.name).join('、')}`, { log: true });
  eng.beginInitiative();
  eng.settle();
  eng.checkVictory();
  return eng.result();
}

export function combatantFrom(ctx: Ctx, e: SetupEntry): Combatant {
  const t = ctx.tokens.get(e.tokenId);
  if (!t) throw new CombatError(404, 'not-found', '找不到這個代幣');
  const team = cleanTeam(e.team);
  const base = { id: ctx.id(), tokenId: t.id, ...(team ? { team } : {}), initiative: null, conditions: [] as Condition[], tempHp: 0, interaction: 'auto' as const, phase: 0 };
  if (t.characterId) {
    const sheet = ctx.sheets.get(t.characterId);
    if (!sheet) throw new CombatError(404, 'not-found', `找不到「${t.name}」的角色卡`);
    const max = Math.max(1, sheet.values.get('hp') ?? 10);
    return {
      ...base, name: e.name ?? t.name, side: e.side ?? 'party', controller: t.ownerUserId, characterId: t.characterId, tier: 'elite', hidden: false,
      hp: Math.max(0, Math.min(max, e.hpNow ?? max)), maxHp: max, ac: sheet.values.get('ac') ?? 10, speed: sheet.values.get('walk') ?? 30, dex: sheet.values.get('mod.dex') ?? 0,
    };
  }
  const m = e.monsterId ? ctx.combat.monsters.find((x) => x.id === e.monsterId) : undefined;
  if (e.monsterId && !m) throw new CombatError(404, 'not-found', `沒有「${e.monsterId}」這種怪物`);
  const hp = int(e.hp ?? m?.hp ?? 10, 1, 9999, '生命值');
  const c: Combatant = {
    ...base, name: e.name ?? t.name, side: e.side ?? 'foe', controller: 'gm', tier: e.tier ?? m?.tier ?? 'minion', hidden: e.hidden ?? t.hidden,
    hp, maxHp: hp, ac: int(e.ac ?? m?.ac ?? 12, 0, 40, 'AC'), speed: int(e.speed ?? m?.speed ?? 30, 0, 300, '速度'), dex: int(e.dex ?? m?.dex ?? 0, -10, 20, '敏捷'),
  };
  if (m) c.monsterId = m.id;
  if (!m || e.attacks) {
    const attacks = (e.attacks ?? []).slice(0, 6).map(cleanAttack);
    if (attacks.length === 0) attacks.push({ id: 'strike', label: '攻擊', bonus: 3, damage: '1d6+1', damageType: '鈍擊' });
    c.custom = { attacks, ...(e.multiattack ? { multiattack: int(e.multiattack, 1, 8, '多重攻擊') } : {}) };
  }
  return c;
}

function cleanAttack(a: MonsterAttack, i: number): MonsterAttack {
  const label = String(a?.label ?? '').trim().slice(0, 30) || `攻擊 ${i + 1}`;
  const damage = String(a?.damage ?? '').trim().slice(0, 100) || '1d6';
  try { evaluate(damage, () => undefined, () => 1); } catch { throw new CombatError(400, 'bad-formula', `「${label}」的傷害公式看不懂：${damage}`); }
  const out: MonsterAttack = { id: `a${i}`, label, damage, damageType: String(a?.damageType ?? '').trim().slice(0, 20) || '傷害' };
  if (a?.save) out.save = { attr: String(a.save.attr), dc: int(a.save.dc, 1, 40, 'DC'), half: !!a.save.half };
  else out.bonus = int(a?.bonus ?? 3, -10, 30, '攻擊加值');
  if (a?.reach) out.reach = int(a.reach, 5, 60, '觸及');
  if (a?.range) out.range = [int(a.range[0], 5, 10000, '射程'), int(a.range[1], 5, 10000, '射程')];
  if (a?.pattern) out.pattern = String(a.pattern).slice(0, 48);
  return out;
}

function int(v: unknown, lo: number, hi: number, what: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new CombatError(400, 'bad-request', `${what}要是 ${lo} 到 ${hi} 的數字`);
  return Math.round(n);
}

// ---------- commands ----------

/** The faces of every die in a roll, in order. */
function facesOf(ev: Evaluation): DieFace[] {
  return ev.dice.flatMap((d) => d.rolls.map((value, i) => ({ sides: d.sides, value, kept: d.kept[i] !== false })));
}

export type Command =
  | { type: 'release'; stepId: string }
  | { type: 'gesture'; stepId: string; input: GestureInput }
  | { type: 'begin'; stepId: string }
  | { type: 'dodge'; stepId: string; moves: string }
  | { type: 'attack'; combatantId: string; source: AttackSource; targets: string[]; point?: { x: number; y: number } }
  | { type: 'dash'; combatantId: string }
  | { type: 'dodgeAction'; combatantId: string }
  | { type: 'endTurn'; combatantId: string }
  | { type: 'gm'; op: GmOp; reason?: string };

export type GmOp =
  | { kind: 'pause' } | { kind: 'resume' } | { kind: 'retry' } | { kind: 'skip' } | { kind: 'cancelAttack' } | { kind: 'end' } | { kind: 'nextTurn' } | { kind: 'auto' }
  | { kind: 'force'; quality?: number; hits?: number; total?: number }
  | { kind: 'hp'; combatantId: string; hp?: number; tempHp?: number; maxHp?: number }
  | { kind: 'condition'; combatantId: string; condition: Condition; on: boolean }
  | { kind: 'reveal'; combatantId: string }
  | { kind: 'tier'; combatantId: string; tier: Tier }
  | { kind: 'interaction'; combatantId: string; interaction: Combatant['interaction'] }
  | { kind: 'patterns'; combatantId: string; patterns: string[] }
  | { kind: 'initiative'; combatantId: string; value: number }
  | { kind: 'extraAction'; combatantId: string }
  | { kind: 'remove'; combatantId: string }
  | { kind: 'add'; entries: SetupEntry[] }
  | { kind: 'settings'; mode?: EncounterState['mode']; autoNpc?: boolean; showFoeHp?: boolean; autoEnd?: boolean }
  | { kind: 'team'; combatantId: string; team: string }
  | { kind: 'trigger'; trigger: Omit<Trigger, 'id' | 'fired'> }
  | { kind: 'untrigger'; triggerId: string };

export function runCommand(state: EncounterState, ctx: Ctx, who: Caller, cmd: Command): Outcome {
  const eng = new Engine(structuredClone(state), ctx);
  eng.command(who, cmd);
  eng.settle();
  eng.checkVictory();
  return eng.result();
}

/** Moves a token during combat: only on its turn, within the movement left, around walls and enemies. */
export function runMove(state: EncounterState, ctx: Ctx, who: Caller, tokenId: string, to: { x: number; y: number }): Outcome {
  const eng = new Engine(structuredClone(state), ctx);
  eng.move(who, tokenId, to);
  eng.settle();
  eng.checkVictory();
  return eng.result();
}

/** Applies whatever is due by the clock: steps past their deadline, NPC turns that run themselves. */
export function runClock(state: EncounterState, ctx: Ctx): Outcome | null {
  const step = state.step;
  if (state.status !== 'active' && state.status !== 'initiative') return null;
  if (!step || Date.parse(step.deadline) > ctx.now.getTime()) return null;
  const eng = new Engine(structuredClone(state), ctx);
  eng.expire();
  eng.settle();
  eng.checkVictory();
  return eng.result();
}

// ---------- the engine ----------

class Engine {
  private events: OutEvent[] = [];
  private moves: Outcome['moves'] = [];
  private reveals: string[] = [];
  private vitals = new Map<string, number>();

  constructor(private s: EncounterState, private ctx: Ctx) {}

  result(): Outcome {
    return { state: this.s, events: this.events, moves: this.moves, reveals: this.reveals, vitals: [...this.vitals].map(([characterId, hp]) => ({ characterId, hp })) };
  }

  say(kind: string, text: string, o: { gmOnly?: boolean; log?: boolean; data?: unknown } = {}) {
    this.events.push({ kind, text, ...o });
  }

  private c(id: string): Combatant {
    const c = this.s.combatants[id];
    if (!c) throw new CombatError(404, 'not-found', '找不到這個參戰者');
    return c;
  }
  private get actor(): Combatant | null { return this.s.turn ? this.s.combatants[this.s.turn.combatantId] ?? null : null; }
  private foot(c: Combatant): Footprint {
    const t = this.ctx.tokens.get(c.tokenId);
    return t ? { x: t.x, y: t.y, size: t.size, elevation: t.elevation } : { x: -999, y: -999, size: 1 };
  }
  private alive(c: Combatant) { return !c.dead && !c.defeated; }
  private hostile(a: Combatant, b: Combatant) { return hostileTo(a, b); }
  /** Still in the fight: up, or a character at 0 HP still rolling death saves (they can be healed back up). */
  private standing(c: Combatant) { return this.alive(c) && (c.hp > 0 || (!!c.characterId && !c.stable)); }

  /**
   * Ends the fight once at most one team still has anyone standing — the turn loop would otherwise go round and
   * round with nobody to fight. Only fights that began with two or more teams end this way, and never mid-attack.
   */
  checkVictory() {
    if (this.s.status !== 'active' || this.s.flow || this.s.autoEnd === false) return;
    const all = Object.values(this.s.combatants);
    if (teamsIn(all).length < 2) return;
    const up = all.filter((c) => this.standing(c));
    const left = teamsIn(up);
    if (left.length > 1) return;
    const winner = left[0] ?? null;
    this.s.status = 'ended';
    this.s.step = null;
    this.s.turn = null;
    this.s.outcome = { winner, at: this.s.round };
    for (const c of all) this.vital(c);
    const out = all.filter((c) => c.characterId && c.hp <= 0 && !c.dead).map((c) => c.name);
    const tail = out.length ? `。${out.join('、')} 昏迷中，由 GM 決定後續` : '';
    const seen = up.filter((c) => !c.hidden);
    const text = winner === null ? `所有參戰者都倒下了，戰鬥結束${tail}` : `${winner} 獲勝，戰鬥結束${tail}`;
    if (winner !== null && seen.length === 0) {
      // Only hidden creatures are left: the table learns the fight is over, not who is still lurking.
      this.say('victory', text, { gmOnly: true, data: { winner } });
      this.say('victory', `戰鬥結束${tail}`, { log: true, data: { winner: null } });
    } else this.say('victory', text, { log: true, data: { winner } });
  }
  /** May this caller act for this combatant? */
  private controls(who: Caller, c: Combatant) { return who.gm ? true : c.controller === who.userId; }
  private iso(ms: number) { return new Date(this.ctx.now.getTime() + ms).toISOString(); }
  private pref(c: Combatant): CombatPrefs | null { return c.controller === 'gm' ? null : this.ctx.prefs(c.controller); }

  // ----- initiative and turns -----

  beginInitiative() {
    const waiting = new Set<string>();
    for (const c of Object.values(this.s.combatants)) if (this.humanDice(c)) waiting.add(c.controller);
    this.s.step = this.newStep('initiative', [...waiting]);
    this.s.step.rolled = {};
    // Creatures the GMs run roll at once.
    for (const c of Object.values(this.s.combatants)) if (!this.humanDice(c)) this.rollInitiative(c);
    if (waiting.size === 0) return this.finishInitiative();
    this.say('step', '擲先攻');
  }

  private rollInitiative(c: Combatant) {
    if (c.initiative !== null) return;
    const ev = this.rollFor(c, c.characterId ? '1d20 + @initiative' : `1d20 + ${c.dex}`);
    c.initiative = ev.total;
    if (this.s.step?.rolled) this.s.step.rolled[c.id] = ev.total;
    this.say('initiative', `${c.name} 先攻 ${ev.total}（${ev.text}）`, { gmOnly: c.hidden, data: { combatantId: c.id, total: ev.total, text: ev.text, dice: facesOf(ev) } });
  }

  private finishInitiative() {
    for (const c of Object.values(this.s.combatants)) this.rollInitiative(c);
    this.s.order = Object.values(this.s.combatants)
      .sort((a, b) => (b.initiative! - a.initiative!) || (b.dex - a.dex) || a.id.localeCompare(b.id)).map((c) => c.id);
    this.s.status = 'active';
    this.s.round = 1;
    this.s.turnIndex = 0;
    this.s.step = null;
    this.say('order', `先攻順序：${this.s.order.map((id) => this.s.combatants[id]).filter((c) => !c.hidden).map((c) => `${c.name} ${c.initiative}`).join('、')}`, { log: true });
    this.fireTriggers();
    this.startTurn();
  }

  private startTurn() {
    for (let guard = 0; guard <= this.s.order.length; guard++) {
      const c = this.s.combatants[this.s.order[this.s.turnIndex]];
      if (c && !c.defeated && !c.dead) {
        c.conditions = c.conditions.filter((x) => x !== 'dodging');
        this.s.turn = { combatantId: c.id, movementUsed: 0, dashed: false, actionUsed: false, attacksLeft: 0 };
        this.say('turn', `第 ${this.s.round} 輪：輪到 ${c.name}`, { gmOnly: c.hidden, data: { combatantId: c.id } });
        if (c.characterId && c.hp <= 0 && !c.stable && !c.dead) {
          if (this.humanDice(c)) this.s.step = this.newStep('deathSave', [c.controller], c.id);
          else this.deathSave(c);
        } else if (c.hp <= 0) {
          this.say('skip', `${c.name} 昏迷中，跳過`, { gmOnly: c.hidden });
          this.advanceIndex();
          continue;
        } else if (c.controller === 'gm' && this.s.autoNpc) {
          this.s.step = this.newStep('npcPending', [], c.id);
        }
        return;
      }
      this.advanceIndex();
    }
    // Nobody left who can act.
    this.s.turn = null;
  }

  private advanceIndex() {
    this.s.turnIndex++;
    if (this.s.turnIndex >= this.s.order.length) {
      this.s.turnIndex = 0;
      this.s.round++;
      this.fireTriggers();
    }
  }

  private endTurn() {
    if (this.s.flow) throw new CombatError(409, 'busy', '這次攻擊還沒結算完');
    const c = this.actor;
    if (c) this.say('turnEnd', `${c.name} 結束回合`, { gmOnly: c.hidden });
    this.s.step = null;
    this.advanceIndex();
    this.startTurn();
  }

  // ----- commands -----

  command(who: Caller, cmd: Command) {
    if (this.s.status === 'ended') throw new CombatError(409, 'ended', '這場戰鬥已經結束了');
    if (cmd.type === 'gm') {
      if (!who.gm) throw new CombatError(403, 'forbidden', '只有 GM 可以這麼做');
      return this.gm(who, cmd.op, cmd.reason);
    }
    if (this.s.status === 'paused') throw new CombatError(409, 'paused', 'GM 暫停了戰鬥，請稍等');
    switch (cmd.type) {
      case 'release': return this.release(who, cmd.stepId);
      case 'gesture': return this.gesture(who, cmd.stepId, cmd.input);
      case 'begin': return this.begin(who, cmd.stepId);
      case 'dodge': return this.dodge(who, cmd.stepId, cmd.moves);
      case 'attack': return this.declare(who, cmd.combatantId, cmd.source, cmd.targets, cmd.point);
      case 'dash': {
        const c = this.myTurn(who, cmd.combatantId);
        this.useAction(c);
        this.s.turn!.dashed = true;
        this.say('dash', `${c.name} 衝刺，移動距離加倍`, { gmOnly: c.hidden });
        return;
      }
      case 'dodgeAction': {
        const c = this.myTurn(who, cmd.combatantId);
        this.useAction(c);
        if (!c.conditions.includes('dodging')) c.conditions.push('dodging');
        this.say('dodgeAction', `${c.name} 採取閃避動作：到下個回合前，攻擊他的人有劣勢`, { gmOnly: c.hidden });
        return;
      }
      case 'endTurn': {
        this.myTurn(who, cmd.combatantId);
        if (this.s.step && this.s.step.kind !== 'npcPending') throw new CombatError(409, 'busy', '還有步驟沒完成');
        return this.endTurn();
      }
    }
  }

  private myTurn(who: Caller, combatantId: string): Combatant {
    if (this.s.status !== 'active' || !this.s.turn) throw new CombatError(409, 'not-active', '戰鬥還沒開始輪流行動');
    if (this.s.turn.combatantId !== combatantId) throw new CombatError(409, 'not-your-turn', '還沒輪到這個角色');
    const c = this.c(combatantId);
    if (!this.controls(who, c)) throw new CombatError(403, 'forbidden', '只能操作自己的角色');
    if (this.s.step?.kind === 'npcPending') { this.s.step = null; this.say('gm', 'GM 接手這個回合'); }
    if (this.s.step || this.s.flow) throw new CombatError(409, 'busy', '還有步驟沒完成');
    return c;
  }

  private useAction(c: Combatant) {
    const t = this.s.turn!;
    if (t.actionUsed) throw new CombatError(409, 'no-action', `${c.name} 這回合的動作已經用掉了`);
    t.actionUsed = true;
    t.attacksLeft = 0;
  }

  private stepFor(who: Caller, stepId: string, kind: StepKind | StepKind[]): Step {
    const st = this.s.step;
    if (!st || st.id !== stepId) throw new CombatError(409, 'stale-step', '這個步驟已經結束了，畫面會更新到最新狀態');
    if (!(Array.isArray(kind) ? kind : [kind]).includes(st.kind)) throw new CombatError(409, 'wrong-step', '現在不是這個步驟');
    if (!st.awaiting.includes(who.userId) && !who.gm) throw new CombatError(403, 'forbidden', '這個步驟不是在等你');
    return st;
  }

  private release(who: Caller, stepId: string) {
    const st = this.stepFor(who, stepId, ['initiative', 'attackRoll', 'saveRoll', 'deathSave']);
    const actor = who.gm && !st.awaiting.includes(who.userId) ? null : who.userId;
    if (st.kind === 'initiative') {
      for (const c of Object.values(this.s.combatants)) if (c.initiative === null && (actor === null ? true : c.controller === actor)) this.rollInitiative(c);
      st.awaiting = st.awaiting.filter((u) => u !== (actor ?? u));
      if (st.awaiting.length === 0) this.finishInitiative();
      return;
    }
    if (st.kind === 'deathSave') return this.deathSave(this.c(st.combatantId!));
    if (st.kind === 'attackRoll') { this.s.step = null; return this.rollAttack(); }
    // A save: each player rolls for their own creatures among the targets.
    const flow = this.s.flow!;
    for (const r of flow.results) {
      const c = this.c(r.combatantId);
      if (!r.save && (actor === null || c.controller === actor)) this.rollSave(flow, r);
    }
    st.awaiting = st.awaiting.filter((u) => u !== (actor ?? u));
    if (st.awaiting.length === 0) this.s.step = null;
  }

  private gesture(who: Caller, stepId: string, input: GestureInput) {
    const st = this.stepFor(who, stepId, 'attackInteract');
    const flow = this.s.flow!;
    const ch = challengeFor(flow.interaction, st.seed, this.runesFor(flow));
    const q = ch ? scoreGesture(ch, input) : 0;
    this.setQuality(flow, q, `${this.c(flow.attackerId).name} 的${gestureName(flow.interaction)}品質 ${Math.round(q * 100)}%`);
  }

  private setQuality(flow: AttackFlow, q: number, text: string) {
    flow.quality = q;
    flow.bonus = bonusFor(this.ctx.combat.rules, q);
    this.s.step = null;
    this.say('gesture', `${text}，攻擊 +${flow.bonus}`, { data: { quality: q, bonus: flow.bonus } });
    this.judgeHits(flow);
  }

  private begin(who: Caller, stepId: string) {
    const st = this.stepFor(who, stepId, 'dodge');
    if (st.begunAt) throw new CombatError(409, 'already-begun', '這次閃避已經開始過了，中斷後不能重來；等 GM 處理或時間到就會照一般結果算');
    st.begunAt = this.ctx.now.toISOString();
    st.deadline = this.iso(st.dodge!.duration + DODGE_GRACE);
  }

  private dodge(who: Caller, stepId: string, moves: string) {
    const st = this.stepFor(who, stepId, 'dodge');
    if (!st.begunAt) throw new CombatError(409, 'not-begun', '閃避還沒開始');
    if (!validMoves(moves, st.dodge!)) throw new CombatError(400, 'bad-input', '閃避紀錄格式不對');
    const hits = runDodge(st.dodge!, st.seed, moves);
    this.finishDodge(hits, { moves });
  }

  private finishDodge(hits: number | null, extra: { moves?: string; forced?: boolean; skipped?: string } = {}) {
    const flow = this.s.flow!, st = this.s.step!;
    const r = flow.results.find((x) => x.combatantId === st.combatantId)!;
    const factor = hits === null ? 1 : factorFor(this.ctx.combat.rules, hits);
    r.dodge = { hits: hits ?? -1, factor, ...(extra.skipped ? { skipped: extra.skipped } : {}) };
    const c = this.c(r.combatantId);
    const words = hits === null ? `${c.name} 沒有閃避（${extra.skipped ?? '時間到'}），傷害照骰子` : `${c.name} 閃避被打中 ${hits} 次，傷害 ×${factor}`;
    this.say('dodge', words, { data: { combatantId: c.id, hits, factor, seed: st.seed, setup: st.dodge, moves: extra.moves, forced: extra.forced } });
    this.s.step = null;
  }

  // ----- attacks -----

  private declare(who: Caller, attackerId: string, source: AttackSource, targetIds: string[], point?: { x: number; y: number }) {
    const a = this.myTurn(who, attackerId);
    const t = this.s.turn!;
    const spec = this.attackSpec(a, source);
    // Spend the action: the first attack of the Attack action opens it; spells and area attacks (a breath) take the whole action.
    if (spec.spell || spec.area) this.useAction(a);
    else if (!t.actionUsed) { t.actionUsed = true; t.attacksLeft = this.attacksPerAction(a) - 1; }
    else if (t.attacksLeft > 0) t.attacksLeft--;
    else throw new CombatError(409, 'no-action', `${a.name} 這回合已經不能再攻擊了`);

    const me = this.foot(a);
    let targets: Combatant[];
    if (spec.area) {
      if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y)) throw new CombatError(400, 'bad-request', '範圍攻擊要選一個位置');
      const reachFt = spec.range ?? 0;
      const at: Footprint = { x: point.x, y: point.y, size: 1, elevation: me.elevation };
      if (reachFt > 0 && feetBetween(this.ctx.grid, me, at) > reachFt) throw new CombatError(400, 'out-of-range', `超出射程（${reachFt} 呎）`);
      if (reachFt > 0 && !canSee(this.ctx.grid, this.ctx.blocks, me, at)) throw new CombatError(400, 'no-sight', '看不到那個位置');
      const cells = areaCells(this.ctx.grid, spec.area, me, point);
      targets = Object.values(this.s.combatants).filter((c) => c.id !== a.id && this.alive(c) && touches(this.foot(c), cells) && canSee(this.ctx.grid, this.ctx.blocks, spec.area!.kind === 'sphere' || spec.area!.kind === 'cube' ? at : me, this.foot(c)));
      if (targets.length === 0) throw new CombatError(400, 'no-target', '範圍裡沒有任何目標');
    } else {
      if (targetIds.length !== 1) throw new CombatError(400, 'bad-request', '選一個目標');
      const target = this.c(targetIds[0]);
      if (!this.alive(target) || target.id === a.id) throw new CombatError(400, 'bad-target', '不能攻擊這個目標');
      if (target.hidden && a.controller !== 'gm') throw new CombatError(404, 'not-found', '找不到這個參戰者');
      const dist = feetBetween(this.ctx.grid, me, this.foot(target));
      const max = spec.long ?? spec.range ?? spec.reach ?? 5;
      if (dist > max) throw new CombatError(400, 'out-of-range', `${target.name} 在 ${dist} 呎外，超出${spec.ranged ? '射程' : '觸及'}（${max} 呎）`);
      if (!canSee(this.ctx.grid, this.ctx.blocks, me, this.foot(target))) throw new CombatError(400, 'no-sight', `看不到 ${target.name}，中間有東西擋住`);
      targets = [target];
    }
    if (a.hidden) { a.hidden = false; this.reveals.push(a.tokenId); this.say('reveal', `${a.name} 現身了`, { log: true }); }
    const [mode, why] = spec.save ? ['normal' as const, []] : this.advantage(a, targets[0], spec.ranged);
    const flow: AttackFlow = {
      id: this.ctx.id(), attackerId: a.id, source, label: spec.label, interaction: spec.interaction, targets: targets.map((x) => x.id),
      ...(point ? { point } : {}), mode, results: targets.map((x) => ({ combatantId: x.id })),
      ...(spec.save ? { dc: spec.save.dc } : {}),
    };
    this.s.flow = flow;
    const names = targets.map((x) => (x.hidden ? '某個東西' : x.name)).join('、');
    this.say('declare', `${a.name} 用${spec.label}攻擊 ${names}${mode !== 'normal' ? `（${mode === 'advantage' ? '優勢' : '劣勢'}：${why.join('、')}）` : ''}`, { data: { flowId: flow.id } });
    if (spec.save) return this.startSaveFlow(flow, spec);
    // Dice first: the attack roll, released by the attacker's player when they get to roll by hand.
    if (this.humanDice(a)) this.s.step = this.newStep('attackRoll', [a.controller], a.id);
    else this.rollAttack();
  }

  private attacksPerAction(c: Combatant): number {
    if (c.characterId) {
      const sheet = this.ctx.sheets.get(c.characterId);
      return sheet?.features.some((f) => f.name.includes('額外攻擊')) ? 2 : 1;
    }
    return c.custom?.multiattack ?? this.monster(c)?.multiattack ?? 1;
  }

  private monster(c: Combatant): Monster | undefined { return c.monsterId ? this.ctx.combat.monsters.find((m) => m.id === c.monsterId) : undefined; }
  private attacksOf(c: Combatant): MonsterAttack[] { return c.custom?.attacks ?? this.monster(c)?.attacks ?? []; }

  /** Everything the rules say about one way of attacking, worked out for this attacker. */
  private attackSpec(a: Combatant, source: AttackSource) {
    const combat = this.ctx.combat;
    if (source.kind === 'weapon') {
      if (!a.characterId) throw new CombatError(400, 'bad-request', '只有角色能用武器清單');
      const w = combat.weapons.find((x) => x.id === source.id);
      if (!w) throw new CombatError(404, 'not-found', '沒有這把武器');
      const mod = w.ability === 'finesse' ? 'max(@mod.str, @mod.dex)' : `@mod.${w.ability}`;
      const ranged = !!w.range && !w.reach;
      return {
        label: w.label, interaction: w.interaction, ranged, spell: false, reach: w.reach ?? 5, range: w.range?.[0], long: w.range?.[1],
        attack: `${mod} + @prof`, damage: w.damage === '1' ? `1 + ${mod}` : `${w.damage} + ${mod}`, damageType: w.damageType,
        area: undefined, save: undefined as undefined | { attr: string; dc: number; half: boolean }, pattern: undefined as string | undefined,
      };
    }
    if (source.kind === 'spell') {
      if (!a.characterId) throw new CombatError(400, 'bad-request', '只有角色能施展清單上的法術');
      const sp = combat.spells.find((x) => x.id === source.id);
      if (!sp) throw new CombatError(404, 'not-found', '沒有這個法術');
      const sheet = this.ctx.sheets.get(a.characterId)!;
      if ((sheet.values.get('cast') ?? 0) <= 0) throw new CombatError(400, 'cannot-cast', `${a.name} 不會施法`);
      if (sp.level > 0) throw new CombatError(400, 'cannot-cast', '目前只支援戲法（不耗法術位），一環以上的法術請用擲骰');
      return {
        label: sp.label, interaction: 'rune' as Interaction, ranged: sp.range > 5, spell: true, reach: sp.range <= 5 ? 5 : undefined, range: sp.range > 5 ? sp.range : undefined, long: undefined,
        attack: '@spell_attack', damage: sp.damage, damageType: sp.damageType, area: sp.area,
        save: sp.save ? { attr: sp.save, dc: sheet.values.get('spell_dc') ?? 10, half: !!sp.halfOnSave } : undefined, pattern: undefined as string | undefined,
      };
    }
    const at = this.attacksOf(a).find((x) => x.id === source.id);
    if (!at) throw new CombatError(404, 'not-found', '這個生物沒有這種攻擊');
    const ranged = !!at.range;
    return {
      label: at.label, interaction: 'none' as Interaction, ranged, spell: false, reach: at.reach ?? 5, range: at.range?.[0] ?? (at.area ? 0 : undefined), long: at.range?.[1],
      attack: String(at.bonus ?? 0), damage: at.damage, damageType: at.damageType, area: at.area, save: at.save, pattern: at.pattern,
    };
  }

  /** 5E advantage and disadvantage from conditions and range; both cancel out. */
  private advantage(a: Combatant, t: Combatant, ranged: boolean): ['normal' | 'advantage' | 'disadvantage', string[]] {
    const adv: string[] = [], dis: string[] = [];
    const has = (c: Combatant, k: Condition) => c.conditions.includes(k);
    const near = feetBetween(this.ctx.grid, this.foot(a), this.foot(t)) <= 5;
    for (const k of ['poisoned', 'blinded', 'restrained', 'frightened', 'prone'] as Condition[]) if (has(a, k)) dis.push(`自己${CONDITION_LABEL[k]}`);
    for (const k of ['blinded', 'restrained', 'unconscious'] as Condition[]) if (has(t, k) || (k === 'unconscious' && t.hp <= 0 && t.characterId)) adv.push(`目標${CONDITION_LABEL[k]}`);
    if (has(t, 'prone')) (near ? adv : dis).push('目標倒地');
    if (has(t, 'dodging')) dis.push('目標在閃避');
    if (ranged) {
      const threatened = Object.values(this.s.combatants).some((o) => o.id !== a.id && this.alive(o) && o.hp > 0 && this.hostile(a, o) && feetBetween(this.ctx.grid, this.foot(a), this.foot(o)) <= 5);
      if (threatened) dis.push('身邊有敵人');
    }
    const unique = (x: string[]) => [...new Set(x)];
    if (adv.length && !dis.length) return ['advantage', unique(adv)];
    if (dis.length && !adv.length) return ['disadvantage', unique(dis)];
    return ['normal', []];
  }

  private rollAttack() {
    const flow = this.s.flow!;
    const a = this.c(flow.attackerId);
    const spec = this.attackSpec(a, flow.source);
    // Long range is decided here, from where everyone stands now.
    if (spec.ranged && spec.range && !spec.area) {
      const t = this.c(flow.targets[0]);
      if (feetBetween(this.ctx.grid, this.foot(a), this.foot(t)) > spec.range) flow.mode = flow.mode === 'advantage' ? 'normal' : 'disadvantage';
    }
    const die = flow.mode === 'advantage' ? '2d20kh1' : flow.mode === 'disadvantage' ? '2d20kl1' : '1d20';
    const ev = this.rollFor(a, `${die} + ${spec.attack}`);
    const nat = keptD20(ev);
    flow.roll = { total: ev.total, text: ev.text, natural: nat };
    this.say('attackRoll', `${a.name} 的攻擊擲骰 ${ev.total}（${ev.text}）${nat === 20 ? '，大成功！' : nat === 1 ? '，大失敗' : ''}`, { data: { flowId: flow.id, combatantId: a.id, targets: flow.targets, total: ev.total, natural: nat, text: ev.text, dice: facesOf(ev) } });
    // Interaction after the dice: the gesture can add a little; a natural 1 or 20 is already settled.
    const gesture = flow.interaction !== 'none' && nat !== 1 && nat !== 20 && this.interactive(a, a);
    if (gesture) this.s.step = this.newStep('attackInteract', [a.controller], a.id);
    else this.judgeHits(flow);
  }

  private judgeHits(flow: AttackFlow) {
    const a = this.c(flow.attackerId);
    const spec = this.attackSpec(a, flow.source);
    const total = flow.roll!.total + (flow.bonus ?? 0);
    for (const r of flow.results) {
      const t = this.c(r.combatantId);
      const nat = flow.roll!.natural;
      r.hit = nat === 20 || (nat !== 1 && total >= t.ac);
      // A hit on an unconscious creature from within 5 feet is a critical.
      r.critical = nat === 20 || (!!r.hit && t.hp <= 0 && !!t.characterId && !spec.ranged && feetBetween(this.ctx.grid, this.foot(a), this.foot(t)) <= 5);
      r.margin = t.ac - total;
      if (!r.hit) { this.say('miss', `沒有命中 ${t.hidden ? '目標' : t.name}（${total}${flow.bonus ? `，含操作 +${flow.bonus}` : ''}）`, { data: { combatantId: t.id } }); continue; }
      r.damage = this.rollDamage(a, spec.damage, r.critical);
      r.tier = tierFor(this.ctx.combat.rules, r.margin, r.critical).id;
      this.say('hit', `${r.critical ? '重擊！' : '命中'} ${t.hidden ? '目標' : t.name}，傷害擲骰 ${r.damage.total}（${r.damage.text}）`, { data: { combatantId: t.id, attackerId: a.id, damage: r.damage, critical: r.critical, tier: r.tier } });
    }
  }

  private startSaveFlow(flow: AttackFlow, spec: ReturnType<Engine['attackSpec']>) {
    const a = this.c(flow.attackerId);
    // Damage is rolled once for every target, before anyone saves.
    const dmg = this.rollDamage(a, spec.damage, false);
    for (const r of flow.results) r.damage = { ...dmg };
    this.say('damageRoll', `${flow.label}的傷害擲骰 ${dmg.total}（${dmg.text}），DC ${flow.dc} ${attrName(this.ctx.pack, spec.save!.attr)}豁免`, { data: { flowId: flow.id, attackerId: a.id, targets: flow.targets, damage: dmg } });
    const waiting = new Set<string>();
    for (const r of flow.results) {
      const t = this.c(r.combatantId);
      if (this.humanDice(t)) waiting.add(t.controller);
      else this.rollSave(flow, r);
    }
    if (waiting.size) this.s.step = this.newStep('saveRoll', [...waiting]);
  }

  private rollSave(flow: AttackFlow, r: TargetResult) {
    const t = this.c(r.combatantId);
    const a = this.c(flow.attackerId);
    const spec = this.attackSpec(a, flow.source);
    const save = spec.save!;
    let ev: Evaluation;
    if (t.characterId) {
      const formula = checkFormula(this.ctx.pack, { attribute: save.attr, extra: this.ctx.pack.checks.extra?.some((x) => x.id === 'save') ? 'save' : undefined });
      ev = this.rollFor(t, formula);
    } else {
      const bonus = t.custom?.saves?.[save.attr] ?? this.monster(t)?.saves?.[save.attr] ?? (save.attr === 'dex' ? t.dex : 0);
      ev = evaluate(`1d20 + ${bonus}`, () => undefined, this.ctx.rng);
    }
    const success = ev.total >= save.dc;
    r.save = { total: ev.total, text: ev.text, success };
    r.margin = ev.total - save.dc;
    r.tier = tierFor(this.ctx.combat.rules, r.margin).id;
    if (success) r.damage = { total: save.half ? Math.floor(r.damage!.total / 2) : 0, text: save.half ? `${r.damage!.text}，豁免成功減半` : '豁免成功，不受傷害', dice: r.damage!.dice };
    r.hit = r.damage!.total > 0;
    this.say('save', `${t.hidden ? '目標' : t.name} 的豁免 ${ev.total}（${ev.text}）${success ? '成功' : '失敗'}`, { gmOnly: t.hidden, data: { combatantId: t.id, attackerId: a.id, total: ev.total, success, dice: facesOf(ev) } });
  }

  private rollDamage(a: Combatant, formula: string, critical: boolean) {
    const ev = this.rollFor(a, formula);
    let total = ev.total, text = ev.text;
    const dice = facesOf(ev);
    if (critical) {
      // 5E criticals roll the damage dice twice.
      let extra = 0;
      const parts: string[] = [];
      for (const d of ev.dice) {
        const again = d.rolls.map(() => this.ctx.rng(d.sides));
        for (const v of again) dice.push({ sides: d.sides, value: v, kept: true });
        extra += again.reduce((s, x) => s + x, 0);
        parts.push(`${d.rolls.length}d${d.sides}[${again.join(',')}]`);
      }
      total += extra;
      text = `${text} + 重擊 ${parts.join(' + ') || '0'}`;
    }
    return { total: Math.max(0, total), text, dice };
  }

  private rollFor(c: Combatant, formula: string): Evaluation {
    if (c.characterId) {
      const sheet = this.ctx.sheets.get(c.characterId);
      if (sheet) return rollOnSheet(this.ctx.pack, sheet, formula, this.ctx.rng);
    }
    return evaluate(formula, () => undefined, this.ctx.rng);
  }

  /** Walks an attack forward through everything automatic, stopping at the next step a person must take. */
  private progressFlow() {
    const flow = this.s.flow!;
    if (!flow.roll && !flow.dc) return; // waiting on the attack roll
    if (flow.dc && flow.results.some((r) => !r.save)) return; // waiting on saves
    const a = this.c(flow.attackerId);
    // Dodges, one target at a time, for the creatures players run.
    for (const r of flow.results) {
      if (!r.hit || r.dodge) continue;
      const t = this.c(r.combatantId);
      if ((r.damage?.total ?? 0) <= 0) { r.dodge = { hits: -1, factor: 1, skipped: '沒有傷害' }; continue; }
      if (!this.dodges(a, t)) { r.dodge = { hits: -1, factor: 1, skipped: t.controller === 'gm' ? 'GM 的生物' : '快速結算' }; continue; }
      this.s.step = this.newStep('dodge', [t.controller], t.id);
      this.s.step.dodge = this.dodgeSetup(a, t, r, this.s.step.seed);
      this.say('dodgeReady', `${t.name} 準備閃避：${this.s.step.dodge.tier.label}，${this.s.step.dodge.duration / 1000} 秒`, { data: { combatantId: t.id } });
      return;
    }
    this.applyFlow(flow);
  }

  private dodgeSetup(a: Combatant, t: Combatant, r: TargetResult, seed: number) {
    const rules = this.ctx.combat.rules;
    const tier = rules.tiers.find((x) => x.id === r.tier) ?? tierFor(rules, r.margin ?? 0, r.critical);
    const short = a.tier === 'minion' && !(this.s.mode === 'custom' && a.interaction === 'full');
    const duration = short ? Math.min(rules.shortDodgeMs, tier.duration) : tier.duration;
    const spec = this.attackSpec(a, this.s.flow!.source);
    const m = this.monster(a);
    const phase = m?.phases && a.phase > 0 ? m.phases[a.phase - 1]?.patterns : undefined;
    const ids = a.patterns?.length ? a.patterns : phase?.length ? phase : spec.pattern ? [spec.pattern] : m?.patterns ?? [];
    return { tier, duration, pattern: pickPattern(ids, this.ctx.patterns, seed), reduced: this.pref(t)?.interaction === 'reduced', damage: r.damage!.total };
  }

  private applyFlow(flow: AttackFlow) {
    const a = this.c(flow.attackerId);
    const lines: string[] = [];
    for (const r of flow.results) {
      const t = this.c(r.combatantId);
      if (!r.hit || !r.damage) { lines.push(`${t.hidden ? '目標' : t.name}：沒受傷`); continue; }
      const dealt = scaledDamage(r.damage.total, r.dodge?.factor ?? 1);
      r.applied = dealt;
      this.harm(t, dealt, !!r.critical);
      lines.push(`${t.hidden ? '目標' : t.name} 受到 ${dealt} 點${r.dodge && r.dodge.hits >= 0 ? `（閃避 ×${r.dodge.factor}）` : ''}`);
    }
    this.say('resolved', `${a.name} 的${flow.label}：${lines.join('；')}`, { log: true, data: { flow } });
    this.s.flow = null;
    this.s.step = null;
  }

  private harm(t: Combatant, dmg: number, critical: boolean) {
    if (dmg <= 0) return;
    const fromTemp = Math.min(t.tempHp, dmg);
    t.tempHp -= fromTemp;
    let left = dmg - fromTemp;
    if (t.characterId && t.hp <= 0) {
      // Hurt while dying: a failed death save, two for a critical; enough damage at once kills outright.
      if (left >= t.maxHp) return this.die(t, '傷勢過重');
      t.stable = false;
      t.dying = { successes: t.dying?.successes ?? 0, failures: (t.dying?.failures ?? 0) + (critical ? 2 : 1) };
      this.say('deathFail', `${t.name} 倒地時受傷，死亡豁免失敗 ${t.dying.failures} 次`, { log: true });
      if (t.dying.failures >= 3) this.die(t, '死亡豁免失敗三次');
      this.vital(t);
      return;
    }
    const before = t.hp;
    t.hp = Math.max(0, t.hp - left);
    left -= before;
    if (t.hp === 0) {
      if (t.characterId) {
        if (left >= t.maxHp) return this.die(t, '一次受到的傷害超過生命上限');
        if (!t.conditions.includes('unconscious')) t.conditions.push('unconscious');
        t.dying = { successes: 0, failures: 0 };
        t.stable = false;
        this.say('down', `${t.name} 倒下了，開始進行死亡豁免`, { log: true, data: { combatantId: t.id } });
      } else {
        t.defeated = true;
        this.say('defeated', `${t.hidden ? '某個東西' : t.name} 被擊倒了`, { log: true, gmOnly: t.hidden, data: { combatantId: t.id } });
      }
    }
    this.vital(t);
    this.fireTriggers();
    this.checkPhase(t);
  }

  private die(t: Combatant, why: string) {
    t.hp = 0;
    t.dead = true;
    t.dying = undefined;
    this.say('dead', `${t.name} 死亡（${why}）`, { log: true, data: { combatantId: t.id } });
    this.vital(t);
  }

  private vital(t: Combatant) { if (t.characterId) this.vitals.set(t.characterId, t.hp); }

  private checkPhase(t: Combatant) {
    const m = this.monster(t);
    if (!m?.phases || t.defeated) return;
    const pct = (t.hp / t.maxHp) * 100;
    let phase = 0;
    m.phases.forEach((p, i) => { if (pct <= p.below) phase = i + 1; });
    if (phase > t.phase) {
      t.phase = phase;
      const p = m.phases[phase - 1];
      this.say('phase', p.say ?? `${t.name} 進入第 ${phase + 1} 階段`, { log: true, gmOnly: t.hidden });
    }
  }

  private deathSave(c: Combatant) {
    const ev = this.rollFor(c, '1d20');
    const n = ev.total;
    c.dying ??= { successes: 0, failures: 0 };
    let text: string;
    if (n === 20) {
      c.hp = 1; c.dying = undefined; c.stable = false;
      c.conditions = c.conditions.filter((x) => x !== 'unconscious');
      text = `${c.name} 的死亡豁免擲出 20，恢復 1 點生命並醒來！`;
    } else if (n === 1) { c.dying.failures += 2; text = `${c.name} 的死亡豁免擲出 1，算兩次失敗（${c.dying.failures}/3）`; }
    else if (n >= 10) { c.dying.successes++; text = `${c.name} 的死亡豁免 ${n}，成功（${c.dying.successes}/3）`; }
    else { c.dying.failures++; text = `${c.name} 的死亡豁免 ${n}，失敗（${c.dying.failures}/3）`; }
    this.say('deathSave', text, { log: true, data: { combatantId: c.id, total: n, dice: facesOf(ev) } });
    if (c.dying && c.dying.failures >= 3) this.die(c, '死亡豁免失敗三次');
    else if (c.dying && c.dying.successes >= 3) { c.stable = true; c.dying = undefined; this.say('stable', `${c.name} 穩定下來了（仍然昏迷）`, { log: true }); }
    this.vital(c);
    this.s.step = null;
    // A creature at 0 HP does nothing else on its turn; one that came back with a natural 20 may act.
    if (c.hp <= 0 || c.dead) this.endTurn();
  }

  // ----- movement -----

  move(who: Caller, tokenId: string, to: { x: number; y: number }) {
    const c = Object.values(this.s.combatants).find((x) => x.tokenId === tokenId);
    if (!c || this.s.status === 'ended') return;
    const gmFree = who.gm && (c.controller === 'gm' ? false : true);
    // GMs place anything anywhere except the creature whose turn it is, which walks like everyone else.
    if (who.gm && !(this.s.turn?.combatantId === c.id && this.s.status === 'active')) return;
    if (this.s.status === 'paused' && !who.gm) throw new CombatError(409, 'paused', 'GM 暫停了戰鬥，請稍等');
    if (this.s.status !== 'active' || this.s.turn?.combatantId !== c.id) {
      if (gmFree) return;
      throw new CombatError(409, 'not-your-turn', `戰鬥中只有輪到 ${c.name} 時才能移動`);
    }
    if (!this.controls(who, c)) throw new CombatError(403, 'forbidden', '只能移動自己的角色');
    if (this.s.flow || (this.s.step && this.s.step.kind !== 'npcPending')) throw new CombatError(409, 'busy', '攻擊結算完才能移動');
    if (this.s.step?.kind === 'npcPending') this.s.step = null;
    if (c.hp <= 0) throw new CombatError(409, 'down', `${c.name} 倒下了，不能移動`);
    const t = this.s.turn!;
    const left = this.speedOf(c) * (t.dashed ? 2 : 1) - t.movementUsed;
    const cost = this.walk(c, to, left);
    if (cost === null) throw new CombatError(400, 'blocked', left <= 0 ? `${c.name} 這回合的移動用完了` : `走不到那裡（剩 ${left} 呎，牆和敵人會擋路）`);
    t.movementUsed += cost;
    this.applyMove(c, to);
  }

  private speedOf(c: Combatant) { return c.conditions.includes('restrained') ? 0 : c.conditions.includes('prone') ? Math.floor(c.speed / 2) : c.speed; }

  private walk(c: Combatant, to: { x: number; y: number }, feet: number): number | null {
    const from = this.foot(c);
    const occupied = Object.values(this.s.combatants).filter((o) => o.id !== c.id && this.alive(o) && this.hostile(c, o)).map((o) => this.foot(o));
    const costs = walkCosts(this.ctx.grid, this.ctx.blocks, from, occupied, Math.max(0, feet));
    if (to.x === from.x && to.y === from.y) return 0;
    const cost = costs.get(to.y * this.ctx.grid.cols + to.x);
    if (cost === undefined || cost > feet) return null;
    // Nobody ends a move standing in another creature's space.
    const end: Footprint = { x: to.x, y: to.y, size: from.size };
    const clash = Object.values(this.s.combatants).some((o) => o.id !== c.id && this.alive(o) && overlaps(end, this.foot(o)));
    return clash ? null : cost;
  }

  private applyMove(c: Combatant, to: { x: number; y: number }) {
    const t = this.ctx.tokens.get(c.tokenId);
    if (t) { t.x = to.x; t.y = to.y; }
    this.moves.push({ tokenId: c.tokenId, x: to.x, y: to.y });
    for (const tr of this.s.triggers) {
      if (tr.fired || tr.when.kind !== 'enter') continue;
      const w = tr.when;
      if (c.side !== 'foe' && overlaps({ x: to.x, y: to.y, size: this.foot(c).size }, { x: w.x, y: w.y, size: 1, w: w.w, h: w.h } as Footprint & { w: number; h: number })) this.fire(tr);
    }
  }

  // ----- creatures the GMs run -----

  /** One decision for a creature on autopilot: walk toward the nearest enemy and attack, or end the turn. */
  private autoAct() {
    const c = this.actor!;
    const t = this.s.turn!;
    const foes = Object.values(this.s.combatants).filter((o) => this.alive(o) && o.hp > 0 && this.hostile(c, o) && !o.hidden);
    const attacks = this.attacksOf(c);
    if (!foes.length || !attacks.length || (t.actionUsed && t.attacksLeft <= 0)) return this.endTurn();
    const me = () => this.foot(c);
    const byDist = (o: Combatant) => feetBetween(this.ctx.grid, me(), this.foot(o));
    foes.sort((p, q) => byDist(p) - byDist(q) || p.hp - q.hp);
    const target = foes[0];
    const melee = attacks.filter((a) => !a.range && !a.area && a.bonus !== undefined);
    const ranged = attacks.filter((a) => a.range && a.bonus !== undefined);
    const reachOf = (a: MonsterAttack) => a.reach ?? 5;
    const seesTarget = () => canSee(this.ctx.grid, this.ctx.blocks, me(), this.foot(target));
    // An area attack is worth it when it catches two or more enemies.
    const area = !t.actionUsed ? attacks.find((a) => a.area && a.save) : undefined;
    if (area) {
      const cells = areaCells(this.ctx.grid, area.area!, me(), { x: this.foot(target).x, y: this.foot(target).y });
      const caught = foes.filter((o) => touches(this.foot(o), cells)).length;
      if (caught >= 2 && byDist(target) <= area.area!.size) {
        return this.declareAuto(c, { kind: 'monster', id: area.id }, [], { x: this.foot(target).x, y: this.foot(target).y });
      }
    }
    let pick = melee.find((a) => byDist(target) <= reachOf(a) && seesTarget());
    if (!pick && !t.actionUsed && t.movementUsed < this.speedOf(c) * (t.dashed ? 2 : 1) && melee.length) {
      this.approach(c, target, Math.max(...melee.map(reachOf)));
      pick = melee.find((a) => byDist(target) <= reachOf(a) && seesTarget());
    }
    if (!pick) pick = ranged.find((a) => byDist(target) <= a.range![1] && seesTarget());
    if (!pick) {
      if (!t.actionUsed && melee.length) { this.say('auto', `${c.name} 往 ${target.name} 移動`, { gmOnly: c.hidden }); }
      return this.endTurn();
    }
    this.declareAuto(c, { kind: 'monster', id: pick.id }, [target.id]);
  }

  private declareAuto(c: Combatant, source: AttackSource, targets: string[], point?: { x: number; y: number }) {
    try {
      this.declare({ userId: 'gm', gm: true }, c.id, source, targets, point);
    } catch (e) {
      if (!(e instanceof CombatError)) throw e;
      this.say('auto', `${c.name} 沒辦法攻擊（${e.message}），結束回合`, { gmOnly: c.hidden });
      this.s.flow = null;
      this.s.step = null;
      this.endTurn();
    }
  }

  /** Walks as close to the target as movement allows, ideally into reach. */
  private approach(c: Combatant, target: Combatant, reach: number) {
    const t = this.s.turn!;
    const left = this.speedOf(c) * (t.dashed ? 2 : 1) - t.movementUsed;
    const from = this.foot(c);
    const others = Object.values(this.s.combatants).filter((o) => o.id !== c.id && this.alive(o));
    const occupied = others.map((o) => this.foot(o));
    const costs = walkCosts(this.ctx.grid, this.ctx.blocks, from, others.filter((o) => this.hostile(c, o)).map((o) => this.foot(o)), left);
    let best: { x: number; y: number; d: number; cost: number } | null = null;
    for (const [cell, cost] of costs) {
      const x = cell % this.ctx.grid.cols, y = Math.floor(cell / this.ctx.grid.cols);
      const spot: Footprint = { x, y, size: from.size, elevation: from.elevation };
      if (occupied.some((o) => overlaps(spot, o))) continue;
      const d = feetBetween(this.ctx.grid, spot, this.foot(target));
      const score = Math.max(0, d - reach);
      if (!best || score < Math.max(0, best.d - reach) || (score === Math.max(0, best.d - reach) && cost < best.cost)) best = { x, y, d, cost };
    }
    if (!best || (best.x === from.x && best.y === from.y)) return;
    t.movementUsed += best.cost;
    this.applyMove(c, best);
    this.say('auto', `${c.name} 移動 ${best.cost} 呎`, { gmOnly: c.hidden });
  }

  // ----- the GM's console -----

  private gm(who: Caller, op: GmOp, reason?: string) {
    const why = reason?.trim() ? `（理由：${reason.trim().slice(0, 200)}）` : '';
    const note = (text: string, gmOnly = false) => this.say('override', `GM ${text}${why}`, { log: !gmOnly, gmOnly, data: { op, by: who.userId } });
    const st = this.s.step;
    switch (op.kind) {
      case 'pause':
        if (this.s.status === 'paused') return;
        this.s.pausedFrom = this.s.status === 'initiative' ? 'initiative' : 'active';
        this.s.pausedAt = this.ctx.now.toISOString();
        this.s.status = 'paused';
        return note('暫停了戰鬥');
      case 'resume': {
        const x = this.s;
        if (this.s.status !== 'paused') return;
        this.s.status = x.pausedFrom ?? 'active';
        // The clock stood still while paused: push the step's deadline back by the pause.
        if (st && x.pausedAt) st.deadline = new Date(Date.parse(st.deadline) + (this.ctx.now.getTime() - Date.parse(x.pausedAt))).toISOString();
        delete x.pausedFrom; delete x.pausedAt;
        return note('繼續戰鬥');
      }
      case 'retry': {
        if (!st) throw new CombatError(409, 'no-step', '現在沒有可以重做的步驟');
        st.seed = this.ctx.seed();
        delete st.begunAt;
        st.deadline = this.iso(DEADLINE[st.kind]);
        if (st.dodge && this.s.flow) {
          const r = this.s.flow.results.find((x) => x.combatantId === st.combatantId)!;
          st.dodge = this.dodgeSetup(this.c(this.s.flow.attackerId), this.c(st.combatantId!), r, st.seed);
        }
        return note(`讓「${STEP_NAME[st.kind]}」重來一次`);
      }
      case 'skip':
        if (!st) throw new CombatError(409, 'no-step', '現在沒有可以跳過的步驟');
        note(`跳過「${STEP_NAME[st.kind]}」，照預設結果算`);
        return this.expire();
      case 'force': {
        if (!st) throw new CombatError(409, 'no-step', '現在沒有可以指定結果的步驟');
        if (st.kind === 'attackInteract') {
          const q = Math.max(0, Math.min(1, Number(op.quality)));
          if (!Number.isFinite(q)) throw new CombatError(400, 'bad-request', '品質要是 0 到 1');
          note(`把操作品質定為 ${Math.round(q * 100)}%`);
          return this.setQuality(this.s.flow!, q, '指定的操作');
        }
        if (st.kind === 'dodge') {
          const h = int(op.hits, 0, 20, '被打中次數');
          note(`把閃避結果定為被打中 ${h} 次`);
          return this.finishDodge(h, { forced: true });
        }
        if (st.kind === 'attackRoll') {
          const total = int(op.total, -20, 60, '攻擊總值');
          const flow = this.s.flow!;
          flow.roll = { total, text: `GM 指定 ${total}`, natural: 0 };
          this.s.step = null;
          note(`把攻擊擲骰定為 ${total}`);
          return this.judgeHits(flow);
        }
        throw new CombatError(400, 'bad-request', '這個步驟不能指定結果，請用跳過');
      }
      case 'cancelAttack': {
        if (!this.s.flow) throw new CombatError(409, 'no-attack', '現在沒有進行中的攻擊');
        this.s.flow = null;
        this.s.step = null;
        if (this.s.turn) { this.s.turn.actionUsed = false; this.s.turn.attacksLeft = 0; }
        return note('取消了這次攻擊，動作還給角色');
      }
      case 'end': {
        this.s.status = 'ended';
        this.s.outcome = { winner: null, at: this.s.round };
        this.s.step = null;
        this.s.flow = null;
        for (const c of Object.values(this.s.combatants)) this.vital(c);
        return note('結束了戰鬥');
      }
      case 'nextTurn':
        this.s.flow = null;
        this.s.step = null;
        note('跳到下一位');
        this.advanceIndex();
        return this.startTurn();
      case 'auto': {
        const c = this.actor;
        if (!c || c.controller !== 'gm') throw new CombatError(409, 'not-npc', '現在不是 GM 生物的回合');
        if (this.s.step?.kind === 'npcPending') this.s.step = null;
        if (this.s.flow || this.s.step) throw new CombatError(409, 'busy', '還有步驟沒完成');
        this.s.turn!.auto = true;
        return;
      }
      case 'hp': {
        const c = this.c(op.combatantId);
        const before = `${c.hp}/${c.maxHp}`;
        if (op.maxHp !== undefined) c.maxHp = int(op.maxHp, 1, 9999, '生命上限');
        if (op.hp !== undefined) c.hp = int(op.hp, 0, c.maxHp, '生命值');
        if (op.tempHp !== undefined) c.tempHp = int(op.tempHp, 0, 999, '暫時生命');
        if (c.hp > 0) {
          c.dying = undefined; c.stable = false; c.dead = false; c.defeated = false;
          c.conditions = c.conditions.filter((x) => x !== 'unconscious');
        } else if (!c.characterId) c.defeated = true;
        else if (!c.dead && !c.dying && !c.stable) {
          // A character the GM drops to 0 falls as from a blow: unconscious, rolling death saves.
          if (!c.conditions.includes('unconscious')) c.conditions.push('unconscious');
          c.dying = { successes: 0, failures: 0 };
          this.say('down', `${c.name} 倒下了，開始進行死亡豁免`, { log: true, data: { combatantId: c.id } });
        }
        this.vital(c);
        note(`把 ${c.name} 的生命從 ${before} 改成 ${c.hp}/${c.maxHp}${c.tempHp ? `（暫時 ${c.tempHp}）` : ''}`, c.hidden);
        this.fireTriggers();
        return this.checkPhase(c);
      }
      case 'condition': {
        const c = this.c(op.combatantId);
        if (!CONDITIONS.includes(op.condition)) throw new CombatError(400, 'bad-request', '沒有這種狀態');
        c.conditions = c.conditions.filter((x) => x !== op.condition);
        if (op.on) c.conditions.push(op.condition);
        return note(`${op.on ? '讓' : '解除'} ${c.name} ${op.on ? '進入' : '的'}「${CONDITION_LABEL[op.condition]}」`, c.hidden);
      }
      case 'reveal': {
        const c = this.c(op.combatantId);
        if (!c.hidden) return;
        c.hidden = false;
        this.reveals.push(c.tokenId);
        return note(`讓 ${c.name} 現身`);
      }
      case 'team': {
        const c = this.c(op.combatantId);
        const team = cleanTeam(op.team);
        if (team) c.team = team; else delete c.team;
        if (teamsIn(Object.values(this.s.combatants)).length > 12) throw new CombatError(400, 'bad-request', '一場戰鬥最多 12 個陣營');
        return note(`把 ${c.name} 編入「${teamOf(c)}」`, c.hidden);
      }
      case 'tier': {
        const c = this.c(op.combatantId);
        if (!['minion', 'elite', 'boss'].includes(op.tier)) throw new CombatError(400, 'bad-request', '重要度只能是一般、重要或 Boss');
        c.tier = op.tier;
        return note(`把 ${c.name} 設為${TIER_NAME[op.tier]}`, c.hidden);
      }
      case 'interaction': {
        const c = this.c(op.combatantId);
        if (!['auto', 'full', 'quick'].includes(op.interaction)) throw new CombatError(400, 'bad-request', '互動設定只能是 auto、full 或 quick');
        c.interaction = op.interaction;
        return note(`把 ${c.name} 的互動設為${{ auto: '照重要度', full: '完整互動', quick: '快速結算' }[op.interaction]}`, c.hidden);
      }
      case 'patterns': {
        const c = this.c(op.combatantId);
        const ids = (op.patterns ?? []).filter((p) => this.ctx.patterns.some((x) => x.id === p)).slice(0, 10);
        c.patterns = ids.length ? ids : undefined;
        return note(`把 ${c.name} 的彈幕換成 ${ids.map((p) => this.ctx.patterns.find((x) => x.id === p)!.name).join('、') || '預設'}`, true);
      }
      case 'initiative': {
        const c = this.c(op.combatantId);
        c.initiative = int(op.value, -10, 60, '先攻');
        if (this.s.status !== 'initiative') {
          const current = this.s.order[this.s.turnIndex];
          this.s.order = Object.values(this.s.combatants).sort((a, b) => (b.initiative! - a.initiative!) || (b.dex - a.dex) || a.id.localeCompare(b.id)).map((x) => x.id);
          this.s.turnIndex = Math.max(0, this.s.order.indexOf(current));
        }
        return note(`把 ${c.name} 的先攻改成 ${c.initiative}`, c.hidden);
      }
      case 'extraAction': {
        const c = this.c(op.combatantId);
        if (this.s.turn?.combatantId !== c.id) throw new CombatError(409, 'not-turn', '只能給正在行動的角色');
        this.s.turn.actionUsed = false;
        this.s.turn.attacksLeft = 0;
        return note(`給 ${c.name} 再一個動作`, c.hidden);
      }
      case 'remove': {
        const c = this.c(op.combatantId);
        if (this.s.flow?.attackerId === c.id || this.s.flow?.targets.includes(c.id)) throw new CombatError(409, 'busy', '這個參戰者正在攻擊結算中，先取消攻擊');
        const current = this.s.order[this.s.turnIndex];
        delete this.s.combatants[c.id];
        this.s.order = this.s.order.filter((x) => x !== c.id);
        note(`讓 ${c.name} 離開戰鬥`, c.hidden);
        if (current === c.id) { this.s.step = null; this.s.turnIndex = Math.max(0, this.s.turnIndex - 1); this.advanceIndex(); this.startTurn(); }
        else this.s.turnIndex = Math.max(0, this.s.order.indexOf(current));
        return;
      }
      case 'add': {
        const added: Combatant[] = [];
        for (const e of op.entries ?? []) {
          if (Object.values(this.s.combatants).some((x) => x.tokenId === e.tokenId)) continue;
          const c = combatantFrom(this.ctx, e);
          this.s.combatants[c.id] = c;
          added.push(c);
        }
        if (Object.keys(this.s.combatants).length > 60) throw new CombatError(400, 'bad-request', '一場戰鬥最多 60 個參戰者');
        if (this.s.status !== 'initiative') {
          const current = this.s.order[this.s.turnIndex];
          for (const c of added) this.rollInitiative(c);
          this.s.order = Object.values(this.s.combatants).sort((a, b) => (b.initiative! - a.initiative!) || (b.dex - a.dex) || a.id.localeCompare(b.id)).map((x) => x.id);
          this.s.turnIndex = Math.max(0, this.s.order.indexOf(current));
        } else if (this.s.step) {
          for (const c of added) if (this.humanDice(c)) { if (!this.s.step.awaiting.includes(c.controller)) this.s.step.awaiting.push(c.controller); } else this.rollInitiative(c);
        }
        return note(`讓 ${added.map((c) => c.name).join('、') || '沒有人'} 加入戰鬥`, added.every((c) => c.hidden));
      }
      case 'settings': {
        if (op.mode) {
          if (!['full', 'quick', 'custom'].includes(op.mode)) throw new CombatError(400, 'bad-request', '模式只能是完整互動、快速結算或 GM 自訂');
          this.s.mode = op.mode;
        }
        if (op.autoNpc !== undefined) this.s.autoNpc = !!op.autoNpc;
        if (op.showFoeHp !== undefined) this.s.showFoeHp = !!op.showFoeHp;
        if (op.autoEnd !== undefined) this.s.autoEnd = !!op.autoEnd;
        return note(`調整了戰鬥設定：${MODE_NAME[this.s.mode]}${this.s.autoNpc ? '、NPC 自動行動' : ''}${this.s.showFoeHp ? '、公開敵人生命' : ''}${this.s.autoEnd === false ? '、不自動結束' : ''}`);
      }
      case 'trigger': {
        if (this.s.triggers.length >= 30) throw new CombatError(400, 'bad-request', '觸發器最多 30 個');
        const tr = cleanTrigger(op.trigger, this.s, this.ctx);
        this.s.triggers.push({ ...tr, id: this.ctx.id() });
        return note('加了一個觸發器', true);
      }
      case 'untrigger':
        this.s.triggers = this.s.triggers.filter((t) => t.id !== op.triggerId);
        return note('刪掉一個觸發器', true);
    }
  }

  // ----- the clock -----

  expire() {
    const st = this.s.step;
    if (!st) return;
    switch (st.kind) {
      case 'initiative': this.say('timeout', '時間到，替還沒擲的人擲先攻'); return this.finishInitiative();
      case 'attackRoll': this.say('timeout', '時間到，自動擲攻擊骰'); this.s.step = null; return this.rollAttack();
      case 'attackInteract': return this.setQuality(this.s.flow!, 0, '沒有在時間內完成操作');
      case 'saveRoll': {
        this.say('timeout', '時間到，自動擲豁免');
        for (const r of this.s.flow!.results) if (!r.save) this.rollSave(this.s.flow!, r);
        this.s.step = null;
        return;
      }
      case 'dodge': return this.finishDodge(null, { skipped: st.begunAt ? '閃避中斷' : '沒有開始閃避' });
      case 'deathSave': this.say('timeout', '時間到，自動擲死亡豁免'); return this.deathSave(this.c(st.combatantId!));
      case 'npcPending':
        this.s.step = null;
        this.s.turn!.auto = true;
        return;
    }
  }

  /** Keeps going through everything that needs nobody: automatic steps, AI decisions. */
  settle() {
    for (let guard = 0; guard < 200; guard++) {
      if (this.s.status !== 'active') return;
      if (this.s.step) return;
      if (this.s.flow) {
        const before = JSON.stringify([this.s.flow, this.s.step]);
        this.progressFlow();
        if (this.s.step || JSON.stringify([this.s.flow, this.s.step]) === before) return;
        continue;
      }
      const t = this.s.turn;
      if (t?.auto && this.actor) { this.autoAct(); continue; }
      return;
    }
  }

  // ----- triggers -----

  private fireTriggers() {
    for (const tr of this.s.triggers) {
      if (tr.fired) continue;
      const w = tr.when;
      if (w.kind === 'round' && this.s.round >= w.round) this.fire(tr);
      if (w.kind === 'hpBelow') {
        const c = this.s.combatants[w.combatantId];
        if (c && (c.hp / c.maxHp) * 100 <= w.percent) this.fire(tr);
      }
    }
  }

  private fire(tr: Trigger) {
    tr.fired = true;
    const d = tr.then;
    if (d.kind === 'say') this.say('trigger', d.text, { log: true });
    else if (d.kind === 'reveal') {
      const c = this.s.combatants[d.combatantId];
      if (c?.hidden) { c.hidden = false; this.reveals.push(c.tokenId); this.say('trigger', `${c.name} 出現了！`, { log: true }); }
    } else if (d.kind === 'patterns') {
      const c = this.s.combatants[d.combatantId];
      if (c) { c.patterns = d.patterns; this.say('trigger', `${c.name} 換了攻擊方式`, { gmOnly: c.hidden }); }
    } else if (d.kind === 'tier') {
      const c = this.s.combatants[d.combatantId];
      if (c) { c.tier = d.tier; this.say('trigger', `${c.name} 變得更危險了`, { gmOnly: c.hidden }); }
    }
  }

  // ----- helpers -----

  private newStep(kind: StepKind, awaiting: string[], combatantId?: string): Step {
    return { id: this.ctx.id(), kind, awaiting, ...(combatantId ? { combatantId } : {}), seed: this.ctx.seed(), startsAt: this.ctx.now.toISOString(), deadline: this.iso(DEADLINE[kind]) };
  }

  /** Whether a creature's player rolls this die by hand (press, shake, let go) instead of the server rolling at once. */
  private humanDice(c: Combatant) {
    if (c.controller === 'gm' || this.s.mode === 'quick') return false;
    if (this.s.mode === 'custom' && c.interaction === 'quick') return false;
    return this.pref(c)?.interaction !== 'off';
  }

  /** Whether a gesture or a dodge happens between these two. */
  private interactive(attacker: Combatant, player: Combatant) {
    if (player.controller === 'gm' || this.s.mode === 'quick') return false;
    if (this.pref(player)?.interaction === 'off') return false;
    if (this.s.mode === 'custom' && (attacker.interaction === 'quick' || player.interaction === 'quick')) return false;
    return true;
  }

  private dodges(attacker: Combatant, target: Combatant) {
    return target.controller !== 'gm' && this.interactive(attacker, target);
  }

  private runesFor(flow: AttackFlow) {
    const sp = flow.source.kind === 'spell' ? this.ctx.combat.spells.find((x) => x.id === flow.source.id) : undefined;
    return 4 + Math.min(3, sp?.level ?? 0);
  }
}

function overlaps(a: Footprint & { w?: number; h?: number }, b: Footprint & { w?: number; h?: number }) {
  const aw = a.w ?? a.size, ah = a.h ?? a.size, bw = b.w ?? b.size, bh = b.h ?? b.size;
  return a.x < b.x + bw && b.x < a.x + aw && a.y < b.y + bh && b.y < a.y + ah;
}

function keptD20(ev: Evaluation): number {
  const d = ev.dice[0];
  if (!d || d.sides !== 20) return 0;
  const kept = d.rolls.filter((_, i) => d.kept[i]);
  return kept.length === 1 ? kept[0] : 0;
}

function attrName(pack: Pack, id: string) { return pack.attributes.find((a) => a.id === id)?.name ?? id; }
function gestureName(i: Interaction) { return { slash: '斬擊', thrust: '突刺', sweep: '橫掃', draw: '拉弓', rune: '符文', none: '攻擊' }[i]; }

export const STEP_NAME: Record<StepKind, string> = {
  initiative: '擲先攻', attackRoll: '攻擊擲骰', attackInteract: '武器操作', saveRoll: '豁免擲骰', dodge: '閃避', deathSave: '死亡豁免', npcPending: 'NPC 自動行動',
};
export const TIER_NAME: Record<Tier, string> = { minion: '一般敵人', elite: '重要敵人', boss: 'Boss' };
export const MODE_NAME: Record<EncounterState['mode'], string> = { full: '完整互動', quick: '快速結算', custom: 'GM 自訂' };

function cleanTrigger(t: Omit<Trigger, 'id' | 'fired'>, s: EncounterState, ctx: Ctx): Omit<Trigger, 'id' | 'fired'> {
  const w = t?.when, d = t?.then;
  const known = (id: unknown) => {
    if (typeof id !== 'string' || !s.combatants[id]) throw new CombatError(400, 'bad-request', '觸發器指定的參戰者不在戰鬥裡');
    return id;
  };
  let when: Trigger['when'];
  if (w?.kind === 'hpBelow') when = { kind: 'hpBelow', combatantId: known(w.combatantId), percent: int(w.percent, 1, 99, '生命百分比') };
  else if (w?.kind === 'round') when = { kind: 'round', round: int(w.round, 1, 99, '輪數') };
  else if (w?.kind === 'enter') when = { kind: 'enter', x: int(w.x, 0, 99, 'x'), y: int(w.y, 0, 99, 'y'), w: int(w.w, 1, 100, '寬'), h: int(w.h, 1, 100, '高') };
  else throw new CombatError(400, 'bad-request', '觸發條件只能是生命低於、第幾輪或進入區域');
  let then: Trigger['then'];
  if (d?.kind === 'say') {
    const text = String(d.text ?? '').trim();
    if (!text || text.length > 300) throw new CombatError(400, 'bad-request', '要說的話要有 1 到 300 字');
    then = { kind: 'say', text };
  } else if (d?.kind === 'reveal') then = { kind: 'reveal', combatantId: known(d.combatantId) };
  else if (d?.kind === 'patterns') then = { kind: 'patterns', combatantId: known(d.combatantId), patterns: (d.patterns ?? []).filter((p) => ctx.patterns.some((x) => x.id === p)).slice(0, 10) };
  else if (d?.kind === 'tier') {
    if (!['minion', 'elite', 'boss'].includes(d.tier)) throw new CombatError(400, 'bad-request', '重要度只能是一般、重要或 Boss');
    then = { kind: 'tier', combatantId: known(d.combatantId), tier: d.tier };
  } else throw new CombatError(400, 'bad-request', '觸發結果只能是說一段話、現身、換彈幕或改重要度');
  return { when, then };
}

// ---------- what each person sees ----------

/** The encounter as one member may see it: hidden creatures dropped, enemy numbers turned into words. */
export function viewFor(s: EncounterState, userId: string, gm: boolean, prefs: CombatPrefs): EncounterView {
  const combatants: Record<string, CombatantView> = {};
  for (const c of Object.values(s.combatants)) {
    if (c.hidden && !gm) continue;
    const exact = gm || c.side !== 'foe' || s.showFoeHp;
    const { custom, ...rest } = c;
    combatants[c.id] = {
      ...rest, ...(gm && custom ? { custom } : {}), hp: exact ? c.hp : null, maxHp: exact ? c.maxHp : null, ac: gm || c.side !== 'foe' ? c.ac : null,
      health: healthWords(c.hp, c.maxHp, !!c.defeated || !!c.dead), ...(gm ? {} : { patterns: undefined }),
    };
  }
  const visible = (id: string) => !!combatants[id];
  const flow = s.flow && (gm || visible(s.flow.attackerId)) ? { ...s.flow, targets: s.flow.targets.filter(visible), results: s.flow.results.filter((r) => visible(r.combatantId)) } : s.flow ? null : null;
  const step = s.step && (gm || !s.step.combatantId || visible(s.step.combatantId)) ? s.step : null;
  return {
    ...s, combatants, order: s.order.filter(visible), flow, step,
    triggers: gm ? s.triggers : [],
    turn: s.turn && visible(s.turn.combatantId) ? s.turn : s.turn ? { ...s.turn, combatantId: '' } : null,
    you: { userId, gm, prefs },
  };
}

/** How long a dodge step's own play lasts in ticks, for clients that pace their timers. */
export const dodgeTicks = (ms: number) => ticksFor(ms);
