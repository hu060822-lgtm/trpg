import { canAct, weapon } from './engine';
import type { CombatAction, CombatState } from './types';

/**
 * A deliberately simple decision rule for simulations and the demo's NPCs:
 * rescue a dying ally in reach, otherwise close in and attack the weakest reachable enemy.
 */
export function autopilot(s: CombatState): CombatAction {
  const me = s.combatants[s.turn!.combatantId];
  const t = s.turn!;
  const allies = Object.values(s.combatants).filter((c) => c.side === me.side && c.id !== me.id);
  const enemies = Object.values(s.combatants).filter((c) => c.side !== me.side && canAct(c));
  const healer = (me.skills.medicine ?? 0) + (me.skills.firstAid ?? 0) > 0;
  const dyingAllies = allies.filter((a) => a.condition === 'dying');
  const dying = dyingAllies.find((a) => a.band === me.band);
  if (dying && t.ap >= 2 && healer) {
    return { type: 'rescue', targetId: dying.id, useMedkit: me.medkits > 0 };
  }
  // Support characters (healing at least as good as fighting) head for the wounded, not the enemy.
  const support = healer && Math.max(me.skills.medicine ?? 0, me.skills.firstAid ?? 0)
    >= Math.max(me.skills.melee ?? 0, me.skills.ranged ?? 0);
  if (support && dyingAllies.length && dyingAllies[0].band !== me.band && t.ap >= 1 && t.attacks === 0) {
    return { type: 'move', to: me.band + Math.sign(dyingAllies[0].band - me.band) };
  }
  if (enemies.length === 0) return { type: 'endTurn' };
  const w = weapon(me.weaponId);
  const inReach = enemies.filter((e) => Math.abs(e.band - me.band) <= w.range).sort((a, b) => a.hp - b.hp);
  if (inReach.length && t.attacks === 0) return { type: 'attack', targetId: inReach[0].id };
  if (!inReach.length && t.ap >= 1 && !support) {
    const nearest = enemies.reduce((a, b) => (Math.abs(b.band - me.band) < Math.abs(a.band - me.band) ? b : a));
    return { type: 'move', to: me.band + Math.sign(nearest.band - me.band) };
  }
  if (t.ap >= 1 && !me.defending) return { type: 'defend' };
  return { type: 'endTurn' };
}
