/** Build a pure ProjectionContext from a persisted Scenario. */

import type { RuleRegistry, Scenario } from '../types';
import type { ProjectionContext } from './projection';

export function contextFromScenario(
  scenario: Scenario,
  registry: RuleRegistry,
  ruleOverrides?: Record<string, number>,
): ProjectionContext {
  return {
    household: scenario.household,
    startState: scenario.startState,
    assumptions: scenario.assumptions,
    engineSettings: scenario.engineSettings,
    registry,
    pillarOverrides: scenario.pillarOverrides,
    baseYear: 2026,
    actuals: scenario.actuals,
    ...(ruleOverrides ? { ruleOverrides } : {}),
  };
}
