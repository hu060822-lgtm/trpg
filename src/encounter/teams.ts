import type { Combatant, Side } from './types';

/**
 * Factions in a fight. Every combatant belongs to one team; anyone on another team is an enemy. Without a team set,
 * the side decides: the party and its allies are 我方, foes are 敵方 — which is the old two-sided fight.
 */

export const PARTY_TEAM = '我方';
export const FOE_TEAM = '敵方';
export const TEAM_MAX = 16;

export function teamOf(c: { team?: string; side: Side }): string {
  return c.team || (c.side === 'foe' ? FOE_TEAM : PARTY_TEAM);
}

export function hostileTo(a: { team?: string; side: Side }, b: { team?: string; side: Side }): boolean {
  return teamOf(a) !== teamOf(b);
}

/** Team colours, picked in a fixed order so everyone at the table sees the same colour for the same team. */
const PALETTE = ['#6cc4a1', '#d4505e', '#f0b552', '#6f9fe0', '#b98ae0', '#e08a4f', '#9fcf5a', '#e07fb3'];

/** Teams in the order they first appear, 我方 and 敵方 first when present. */
export function teamsIn(cs: Iterable<{ team?: string; side: Side }>): string[] {
  const seen = new Set<string>();
  for (const c of cs) seen.add(teamOf(c));
  const fixed = [PARTY_TEAM, FOE_TEAM].filter((t) => seen.has(t));
  return [...fixed, ...[...seen].filter((t) => !fixed.includes(t)).sort()];
}

export function teamColor(team: string, teams: string[]): string {
  const i = teams.indexOf(team);
  if (team === PARTY_TEAM) return PALETTE[0];
  if (team === FOE_TEAM) return PALETTE[1];
  return PALETTE[(i < 0 ? 0 : i + 2) % PALETTE.length];
}

/** Cleans a team name typed by a GM. Empty means "go by side". */
export function cleanTeam(v: unknown): string | undefined {
  const s = String(v ?? '').trim().slice(0, TEAM_MAX);
  return s || undefined;
}

export type { Combatant };
