/** Shared fixtures for engine tests. */

import type { Adult, Assumptions, Scenario } from '../../types';
import { createDefaultScenario } from '../../defaults';
import { createDefaultRegistry } from '../../rules/registry';
import type { ProjectionContext } from '../projection';

export function adult(over: Partial<Adult> & { id: string; birthYear: number }): Adult {
  return {
    name: over.name ?? over.id,
    statePensionEnabled: false,
    healthcareRequired: false,
    remunerationType: 'employment',
    workRoleRecorded: true,
    voluntaryHealthcare: false,
    allowNoInsurance: true,
    ...over,
  };
}

export interface TestCtxOptions {
  adults?: Adult[];
  startYear?: number;
  personalCash?: number;
  ouCash?: number;
  ouInvestments?: number;
  shareholderLoan?: number;
  iiPillar?: number;
  iiiPillar?: number;
  minimumCashReserve?: number;
  spending?: number;
  mutateAssumptions?: (a: Assumptions) => void;
}

export function scenarioFor(opts: TestCtxOptions = {}): Scenario {
  const s = createDefaultScenario();
  const startYear = opts.startYear ?? 2030;
  s.startState.withdrawalStartDate = `${startYear}-01-01`;
  s.startState.startingBalancesAsOf = `${startYear - 1}-12-31`;
  if (opts.personalCash !== undefined) s.startState.balances.personalCash = opts.personalCash;
  if (opts.ouCash !== undefined) s.startState.balances.ouCash = opts.ouCash;
  if (opts.ouInvestments !== undefined) s.startState.balances.ouInvestments = opts.ouInvestments;
  if (opts.shareholderLoan !== undefined) s.startState.balances.shareholderLoan = opts.shareholderLoan;
  if (opts.iiPillar !== undefined) s.startState.balances.iiPillar = opts.iiPillar;
  if (opts.iiiPillar !== undefined) s.startState.balances.iiiPillar = opts.iiiPillar;
  if (opts.minimumCashReserve !== undefined) s.startState.minimumCashReserve = opts.minimumCashReserve;
  if (opts.spending !== undefined) s.assumptions.spending.targetAnnualTodayEUR = opts.spending;
  if (opts.adults) s.household.adults = opts.adults;
  if (opts.mutateAssumptions) opts.mutateAssumptions(s.assumptions);
  return s;
}

export function ctxFor(opts: TestCtxOptions = {}): ProjectionContext {
  const s = scenarioFor(opts);
  return {
    household: s.household,
    startState: s.startState,
    assumptions: s.assumptions,
    engineSettings: s.engineSettings,
    registry: createDefaultRegistry(),
    pillarOverrides: s.pillarOverrides,
    baseYear: 2026,
    actuals: s.actuals,
  };
}
