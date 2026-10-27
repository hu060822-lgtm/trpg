import combatJson from '../../config/combat.v03.json';
import itemsJson from '../../config/items.json';
import { resolveCheck, type CheckResult } from '../rules/check';
import { assertActive } from '../rules/config';
import type { Rng } from '../rules/dice';
import type { AttributeCode, CheckInput, RollMode, RulesConfig, TierKey } from '../rules/types';
import type {
  ArmorDef, CombatAction, CombatConfig, CombatEvent, CombatState, Combatant, CombatantSetup, Condition,
  ItemDef, Submission, WeaponDef,
} from './types';

export const COMBAT_V03 = combatJson as CombatConfig;
export const ITEMS = itemsJson as ItemDef[];

export class CombatError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const ABLE: Condition[] = ['healthy', 'wounded', 'severe'];
export const canAct = (c: Combatant) => ABLE.includes(c.condition);

export function weapon(id: string): WeaponDef {
  const w = ITEMS.find((i) => i.id === id && i.kind === 'weapon');
  if (!w) throw new CombatError('unknown-item', `unknown weapon ${id}`);
  return w as WeaponDef;
}

export function armor(id: string): ArmorDef {
  const a = ITEMS.find((i) => i.id === id && i.kind === 'armor');
  if (!a) throw new CombatError('unknown-item', `unknown armor ${id}`);
  return a as ArmorDef;
}

interface Ctx {
  s: CombatState;
  rules: RulesConfig;
  cfg: CombatConfig;
  rng: Rng;
  now: Date;
}

function emit(ctx: Ctx, kind: string, combatantId: string | undefined, data: Record<string, unknown>): CombatEvent {
  const e: CombatEvent = { seq: ++ctx.s.seq, round: ctx.s.round, at: ctx.now.toISOString(), kind, combatantId, data };
  ctx.s.events.push(e);
  return e;
}

function woundCondition(c: Combatant, cfg: CombatConfig): Condition {
  const ratio = c.hp / c.maxHp;
  if (ratio <= cfg.wounds.severeAtOrBelow) return 'severe';
  if (ratio <= cfg.wounds.woundedAtOrBelow) return 'wounded';
  return 'healthy';
}

function roll(ctx: Ctx, mode: RollMode): number[] {
  return mode === 'normal' ? [ctx.rng(20)] : [ctx.rng(20), ctx.rng(20)];
}

function check(
  ctx: Ctx, attribute: number, skill: number, tn: number, mode: RollMode,
): CheckResult {
  return resolveCheck({ attribute, skill, tn, mode }, { d20: roll(ctx, mode) }, ctx.rules);
}

/** Severe wounds impose disadvantage on every check (rules draft §6). */
const modeFor = (c: Combatant): RollMode => (c.condition === 'severe' ? 'disadvantage' : 'normal');

export function defenseOf(target: Combatant, cfg: CombatConfig): number {
  if (!canAct(target)) return cfg.defense.base; // helpless targets cannot dodge
  return cfg.defense.base + target.attributes[cfg.defense.attribute] + (target.skills[cfg.defense.skill] ?? 0)
    + armor(target.armorId).defense + (target.defending ? cfg.defense.defendBonus : 0);
}

function die(ctx: Ctx, c: Combatant, cause: string) {
  c.condition = 'dead';
  c.hp = 0;
  emit(ctx, 'death', c.id, { cause, permanent: true, characterId: c.characterId ?? null });
}

function checkDeathCounters(ctx: Ctx, c: Combatant) {
  if (c.dying.failures >= ctx.cfg.dying.failuresToDie) die(ctx, c, 'dying-failures');
  else if (c.dying.successes >= ctx.cfg.dying.successesToStabilize) stabilize(ctx, c, 'dying-successes');
}

function stabilize(ctx: Ctx, c: Combatant, reason: string) {
  c.condition = 'stable';
  c.hp = c.deathProtected && reason === 'protected' ? 0 : ctx.cfg.dying.stabilizedHp;
  c.dying = { successes: 0, failures: 0 };
  emit(ctx, 'stabilized', c.id, { reason, hp: c.hp });
}

function applyDamage(ctx: Ctx, target: Combatant, dmg: number, sourceId: string) {
  if (dmg <= 0) return;
  const { cfg } = ctx;
  if (canAct(target)) {
    target.hp = Math.max(0, target.hp - dmg);
    if (target.hp > 0) {
      target.condition = woundCondition(target, cfg);
      return;
    }
    if (target.deathProtected) {
      stabilize(ctx, target, 'protected');
      return;
    }
    target.condition = 'dying';
    target.dying = { successes: 0, failures: 0 };
    emit(ctx, 'dying', target.id, { by: sourceId });
    return;
  }
  if (target.condition === 'stable') {
    if (target.deathProtected) return;
    target.condition = 'dying';
    target.dying = { successes: 0, failures: 1 };
    emit(ctx, 'dying', target.id, { by: sourceId, reopened: true });
    checkDeathCounters(ctx, target);
    return;
  }
  if (target.condition === 'dying') {
    if (dmg >= target.maxHp) {
      die(ctx, target, 'massive-damage');
      return;
    }
    target.dying.failures += 1;
    emit(ctx, 'dyingHit', target.id, { by: sourceId, failures: target.dying.failures });
    checkDeathCounters(ctx, target);
  }
}

function deathSave(ctx: Ctx, c: Combatant, automatic = false) {
  const d = ctx.cfg.dying;
  const r = check(ctx, c.attributes[d.attribute], 0, d.tn, 'normal');
  const auto = automatic ? { automatic: true } : {};
  if (r.natural === 20) {
    emit(ctx, 'deathSave', c.id, { d20: r.d20, total: r.total, result: 'natural-20', ...auto });
    stabilize(ctx, c, 'natural-20');
    return;
  }
  if (r.success) c.dying.successes += 1;
  else c.dying.failures += r.natural === 1 ? 2 : 1;
  emit(ctx, 'deathSave', c.id, {
    d20: r.d20, total: r.total, success: r.success, successes: c.dying.successes, failures: c.dying.failures, ...auto,
  });
  checkDeathCounters(ctx, c);
}

function ableSides(s: CombatState): Set<string> {
  return new Set(Object.values(s.combatants).filter(canAct).map((c) => c.side));
}

function endIfDecided(ctx: Ctx): boolean {
  const sides = ableSides(ctx.s);
  if (sides.size > 1) return false;
  ctx.s.status = 'ended';
  ctx.s.winner = sides.size === 1 ? [...sides][0] : null;
  ctx.s.turn = null;
  emit(ctx, 'combatEnded', undefined, {
    winner: ctx.s.winner,
    outcome: Object.fromEntries(Object.values(ctx.s.combatants).map((c) => [c.id, { condition: c.condition, hp: c.hp }])),
  });
  return true;
}

/**
 * Moves to the next combatant who can act. A dying GM-controlled combatant rolls its death save on the way;
 * a dying player-controlled one gets a turn whose only action is to roll it (the server still makes the roll).
 */
function advance(ctx: Ctx) {
  const s = ctx.s;
  let idx = s.turn ? s.order.indexOf(s.turn.combatantId) : -1;
  for (let guard = 0; guard < s.order.length * 2 + 2; guard++) {
    if (endIfDecided(ctx)) return;
    idx += 1;
    if (idx >= s.order.length) {
      idx = 0;
      s.round += 1;
      emit(ctx, 'roundStarted', undefined, {});
    }
    const c = s.combatants[s.order[idx]];
    c.defending = false; // defend lasts until the defender's next turn
    const deadline = new Date(ctx.now.getTime() + ctx.cfg.turnDeadlineHours * 3600_000).toISOString();
    if (c.condition === 'dying') {
      if (!ctx.cfg.dying.playerRolls || c.controller === 'gm') {
        deathSave(ctx, c);
        continue;
      }
      s.turn = { combatantId: c.id, kind: 'deathSave', ap: 0, attacks: 0, startedAt: ctx.now.toISOString(), deadline };
      emit(ctx, 'turnStarted', c.id, { ap: 0, deadline, deathSave: true });
      return;
    }
    if (!canAct(c)) continue;
    s.turn = { combatantId: c.id, kind: 'act', ap: ctx.cfg.apPerTurn, attacks: 0, startedAt: ctx.now.toISOString(), deadline };
    emit(ctx, 'turnStarted', c.id, { ap: s.turn.ap, deadline });
    return;
  }
  endIfDecided(ctx) || emit(ctx, 'stalled', undefined, {});
}

export interface StartOptions {
  id: string;
  combatants: CombatantSetup[];
  rules: RulesConfig;
  cfg?: CombatConfig;
  rng: Rng;
  now: Date;
}

export function startCombat(o: StartOptions): CombatState {
  assertActive(o.rules);
  const cfg = o.cfg ?? COMBAT_V03;
  if (new Set(o.combatants.map((c) => c.id)).size !== o.combatants.length) {
    throw new CombatError('duplicate-combatant', 'combatant ids must be unique');
  }
  const s: CombatState = {
    id: o.id, status: 'active', round: 1, order: [], combatants: {}, turn: null,
    processed: {}, events: [], winner: null, seq: 0,
  };
  const ctx: Ctx = { s, rules: o.rules, cfg, rng: o.rng, now: o.now };
  for (const setup of o.combatants) {
    weapon(setup.weaponId);
    armor(setup.armorId);
    if (setup.band < 0 || setup.band >= cfg.bands.count) throw new CombatError('bad-band', `band ${setup.band} out of range`);
    const c: Combatant = {
      potions: 0, medkits: 0, deathProtected: false, ...setup,
      hp: setup.hp ?? setup.maxHp, condition: 'healthy', dying: { successes: 0, failures: 0 },
      defending: false, initiative: 0,
    };
    c.condition = c.hp <= 0 ? 'dying' : woundCondition(c, cfg);
    const d20 = o.rng(20);
    c.initiative = d20 + cfg.initiative.attributes.reduce((sum, a) => sum + c.attributes[a], 0);
    s.combatants[c.id] = c;
    emit(ctx, 'initiative', c.id, { d20, total: c.initiative });
  }
  s.order = Object.values(s.combatants)
    .sort((a, b) => b.initiative - a.initiative || b.attributes.AGI - a.attributes.AGI || a.id.localeCompare(b.id))
    .map((c) => c.id);
  emit(ctx, 'combatStarted', undefined, { order: s.order });
  s.round = 1;
  advance(ctx);
  return s;
}

function controls(sub: Submission, c: Combatant): boolean {
  if (c.controller === sub.actor.userId) return true;
  return sub.actor.role === 'gm' && c.controller === 'gm';
}

function spend(ctx: Ctx, cost: number) {
  const t = ctx.s.turn!;
  if (t.ap < cost) throw new CombatError('not-enough-ap', `需要 ${cost} AP，剩 ${t.ap}`);
  t.ap -= cost;
}

function target(ctx: Ctx, id: string): Combatant {
  const t = ctx.s.combatants[id];
  if (!t) throw new CombatError('unknown-target', `unknown target ${id}`);
  return t;
}

function best(c: Combatant, attrs: AttributeCode[]): AttributeCode {
  return attrs.reduce((a, b) => (c.attributes[b] > c.attributes[a] ? b : a));
}

/*
 * The check each action rolls, exposed so a client can preview odds with the exact same
 * numbers the engine will use (sim/enumerate over these inputs).
 */
export function attackCheck(me: Combatant, t: Combatant, cfg: CombatConfig, attr?: AttributeCode): CheckInput {
  const w = weapon(me.weaponId);
  const a = attr ?? best(me, w.attributes);
  return { attribute: me.attributes[a], skill: me.skills[w.skill] ?? 0, tn: defenseOf(t, cfg), mode: modeFor(me) };
}

export function attackDamage(w: WeaponDef, tierKey: TierKey, t: Combatant, cfg: CombatConfig): number {
  const tier = cfg.damageByTier[tierKey];
  const raw = Math.floor(w.damage * tier.multiplier) + (tier.multiplier > 0 ? tier.bonus : 0);
  return raw > 0 ? Math.max(0, raw - armor(t.armorId).reduction) : 0;
}

export function rescueCheck(me: Combatant, useKit: boolean, cfg: CombatConfig): CheckInput {
  const rc = cfg.rescue;
  const skill = Math.max(...rc.skills.map((k) => me.skills[k] ?? 0));
  return { attribute: me.attributes[best(me, rc.attributes)], skill, tn: rc.tn, mode: useKit ? 'advantage' : modeFor(me) };
}

export function escapeCheck(me: Combatant, cfg: CombatConfig): CheckInput {
  const e = cfg.escape;
  return { attribute: me.attributes[e.attribute], skill: me.skills[e.skill] ?? 0, tn: e.tn, mode: modeFor(me) };
}

function perform(ctx: Ctx, me: Combatant, action: CombatAction) {
  const { cfg } = ctx;
  switch (action.type) {
    case 'move': {
      if (!Number.isInteger(action.to) || action.to < 0 || action.to >= cfg.bands.count) throw new CombatError('bad-band', '目標距離不存在');
      if (Math.abs(action.to - me.band) !== 1) throw new CombatError('bad-move', '每次移動只能前進或後退一個距離');
      spend(ctx, cfg.actionCosts.move);
      const from = me.band;
      me.band = action.to;
      emit(ctx, 'moved', me.id, { from, to: me.band });
      return;
    }
    case 'attack': {
      const t = target(ctx, action.targetId);
      if (t.id === me.id) throw new CombatError('bad-target', '不能攻擊自己');
      if (t.condition === 'dead' || t.condition === 'escaped') throw new CombatError('bad-target', '目標已不在戰鬥中');
      if (ctx.s.turn!.attacks >= cfg.maxAttacksPerTurn) throw new CombatError('attack-limit', '本回合攻擊次數已用完');
      const w = weapon(me.weaponId);
      if (Math.abs(t.band - me.band) > w.range) throw new CombatError('out-of-range', `${w.name} 打不到這個距離`);
      const attr = action.attribute ?? best(me, w.attributes);
      if (!w.attributes.includes(attr)) throw new CombatError('bad-attribute', `${w.name} 不能用這項屬性攻擊`);
      spend(ctx, cfg.actionCosts.attack);
      ctx.s.turn!.attacks += 1;
      const input = attackCheck(me, t, cfg, attr);
      const tn = input.tn;
      const r = check(ctx, input.attribute, input.skill, tn, input.mode!);
      const dmg = attackDamage(w, r.tier, t, cfg);
      emit(ctx, 'attack', me.id, {
        targetId: t.id, weapon: w.id, attribute: attr, d20: r.rolls.d20, total: r.total, defense: tn,
        tier: r.tier, damage: dmg,
      });
      applyDamage(ctx, t, dmg, me.id);
      return;
    }
    case 'defend': {
      spend(ctx, cfg.actionCosts.defend);
      me.defending = true;
      emit(ctx, 'defend', me.id, { bonus: cfg.defense.defendBonus });
      return;
    }
    case 'usePotion': {
      const t = target(ctx, action.targetId ?? me.id);
      if (me.potions <= 0) throw new CombatError('no-item', '沒有藥水');
      if (!canAct(t)) throw new CombatError('bad-target', '藥水只能給還能行動的角色；瀕死要用救援');
      if (t.band !== me.band) throw new CombatError('out-of-range', '要在同一距離才能給藥水');
      spend(ctx, cfg.actionCosts.useItem);
      me.potions -= 1;
      t.hp = Math.min(t.maxHp, t.hp + cfg.potionHeal);
      t.condition = woundCondition(t, cfg);
      emit(ctx, 'potion', me.id, { targetId: t.id, hp: t.hp });
      return;
    }
    case 'rescue': {
      const t = target(ctx, action.targetId);
      if (t.condition !== 'dying') throw new CombatError('bad-target', '只能救援瀕死的角色');
      if (t.side !== me.side) throw new CombatError('bad-target', '只能救援同陣營的角色');
      if (t.band !== me.band) throw new CombatError('out-of-range', '要在同一距離才能救援');
      const useKit = !!action.useMedkit;
      if (useKit && me.medkits <= 0) throw new CombatError('no-item', '沒有醫療包');
      spend(ctx, cfg.actionCosts.rescue);
      if (useKit) me.medkits -= 1;
      const input = rescueCheck(me, useKit, cfg);
      const r = check(ctx, input.attribute, input.skill, input.tn, input.mode!);
      emit(ctx, 'rescue', me.id, { targetId: t.id, d20: r.rolls.d20, total: r.total, tier: r.tier, medkit: useKit });
      if (r.tier === 'strong' || r.tier === 'exceptional') {
        t.hp = Math.max(1, Math.floor(t.maxHp * cfg.rescue.strongHealRatio));
        t.dying = { successes: 0, failures: 0 };
        t.condition = woundCondition(t, cfg);
        emit(ctx, 'revivedToFight', t.id, { hp: t.hp });
      } else if (r.success) {
        stabilize(ctx, t, 'rescue');
      } else if (r.tier === 'catastrophe') {
        t.dying.failures += 1;
        emit(ctx, 'dyingHit', t.id, { by: me.id, failures: t.dying.failures, cause: 'botched-rescue' });
        checkDeathCounters(ctx, t);
      }
      return;
    }
    case 'escape': {
      spend(ctx, cfg.actionCosts.escape);
      const input = escapeCheck(me, cfg);
      const r = check(ctx, input.attribute, input.skill, input.tn, input.mode!);
      emit(ctx, 'escapeAttempt', me.id, { d20: r.rolls.d20, total: r.total, tier: r.tier });
      if (r.success) {
        me.condition = 'escaped';
        emit(ctx, 'escaped', me.id, {});
        ctx.s.turn!.ap = 0;
      }
      return;
    }
    case 'deathSave':
      deathSave(ctx, me);
      return;
    case 'endTurn':
      ctx.s.turn!.ap = 0;
      return;
  }
}

export interface SubmitResult {
  state: CombatState;
  events: CombatEvent[];
  duplicate: boolean;
}

/**
 * Applies one player or GM command. Pure: returns a new state and never mutates the input.
 * Re-sending the same actionId returns the state unchanged with duplicate = true.
 */
export function submitAction(
  state: CombatState, sub: Submission, rules: RulesConfig, rng: Rng, now: Date, cfg: CombatConfig = COMBAT_V03,
): SubmitResult {
  if (state.processed[sub.actionId] !== undefined) return { state, events: [], duplicate: true };
  if (state.status !== 'active' || !state.turn) throw new CombatError('combat-ended', '戰鬥已經結束');
  const me = state.combatants[sub.combatantId];
  if (!me) throw new CombatError('unknown-combatant', `unknown combatant ${sub.combatantId}`);
  if (!controls(sub, me)) throw new CombatError('forbidden', '你不能操作這個角色');
  if (sub.round !== state.round) throw new CombatError('stale', `回合已經變成第 ${state.round} 輪`);
  if (state.turn.combatantId !== me.id) throw new CombatError('not-your-turn', '還沒輪到這個角色');
  const savingTurn = state.turn.kind === 'deathSave';
  if (savingTurn && sub.action.type !== 'deathSave') throw new CombatError('death-save-pending', '角色瀕死中，這回合只能擲瀕死判定');
  if (!savingTurn && sub.action.type === 'deathSave') throw new CombatError('not-dying', '角色沒有瀕死，不需要瀕死判定');

  const s = structuredClone(state);
  const ctx: Ctx = { s, rules, cfg, rng, now };
  const first = s.seq + 1;
  perform(ctx, s.combatants[me.id], sub.action);
  s.processed[sub.actionId] = s.seq;
  if (!endIfDecided(ctx) && s.turn && (s.turn.ap <= 0 || !canAct(s.combatants[me.id]))) advance(ctx);
  return { state: s, events: s.events.filter((e) => e.seq >= first), duplicate: false };
}

/**
 * Called by the server scheduler. If the current turn's deadline passed, the combatant takes the
 * safe default (defend) and the turn ends. Never attacks or spends rare items on the player's behalf.
 */
export function applyTimeout(
  state: CombatState, rules: RulesConfig, rng: Rng, now: Date, cfg: CombatConfig = COMBAT_V03,
): SubmitResult {
  if (state.status !== 'active' || !state.turn || now < new Date(state.turn.deadline)) {
    return { state, events: [], duplicate: false };
  }
  const s = structuredClone(state);
  const ctx: Ctx = { s, rules, cfg, rng, now };
  const first = s.seq + 1;
  const me = s.combatants[s.turn!.combatantId];
  emit(ctx, 'timeout', me.id, { deadline: s.turn!.deadline });
  if (s.turn!.kind === 'deathSave') {
    deathSave(ctx, me, true); // the roll is never skipped: the server makes it on the player's behalf
  } else if (s.turn!.ap >= cfg.actionCosts.defend) {
    s.turn!.ap -= cfg.actionCosts.defend;
    me.defending = true;
    emit(ctx, 'defend', me.id, { bonus: cfg.defense.defendBonus, automatic: true });
  }
  advance(ctx);
  // A defender keeps the bonus until their next turn; advance() cleared only the next combatant's flag.
  return { state: s, events: s.events.filter((e) => e.seq >= first), duplicate: false };
}
