import v03 from '../../config/rules.v03.json';
import v02 from '../../config/rules.v02.json';
import type { RulesConfig } from './types';

export const RULES_V03 = v03 as RulesConfig;
/** Historical ruleset, kept for comparison only. The game refuses to run on it. */
export const RULES_V02 = v02 as RulesConfig;
export const DEFAULT_RULES = RULES_V03;

const ALL: Record<string, RulesConfig> = { '0.3': RULES_V03, '0.2': RULES_V02 };

export function getRules(version: string, opts: { allowHistorical?: boolean } = {}): RulesConfig {
  const config = ALL[version];
  if (!config) throw new Error(`unknown rules version ${version}`);
  if (config.status !== 'active' && !opts.allowHistorical) {
    throw new Error(`rules v${version} is historical and cannot be used for the game`);
  }
  return config;
}

/** Guard for anything that changes game state (character creation, real rolls). */
export function assertActive(config: RulesConfig): void {
  if (config.status !== 'active') {
    throw new Error(`rules v${config.version} is historical and cannot be used for the game`);
  }
}
