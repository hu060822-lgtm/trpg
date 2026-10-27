import v03 from '../../config/rules.v03.json';
import v02 from '../../config/rules.v02.json';
import type { RulesConfig } from './types';

export const RULES_V03 = v03 as RulesConfig;
export const RULES_V02 = v02 as RulesConfig;
export const DEFAULT_RULES = RULES_V03;
