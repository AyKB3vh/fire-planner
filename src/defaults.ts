/**
 * Default / placeholder inputs (Appendix C). These are NOT recommendations —
 * every value is editable and flagged as a placeholder where the spec requires
 * the user to set or confirm it.
 */

import type {
  Assumptions,
  EngineSettings,
  Household,
  MonteCarloSettings,
  OptimisationSettings,
  PillarOverrides,
  Scenario,
  StartingBalanceSheet,
  WithdrawalStartState,
} from './types';
import { BASE_YEAR } from './types';
import { createDefaultRegistry } from './rules/registry';

export function defaultHousehold(): Household {
  return {
    id: 'hh-main',
    name: 'Main household',
    adults: [
      {
        id: 'adult-1',
        name: 'Adult 1 (older)',
        birthYear: 1991,
        statePensionEnabled: true,
        healthcareRequired: true,
        remunerationType: 'employment',
        workRoleRecorded: false,
        voluntaryHealthcare: true,
        allowNoInsurance: false,
      },
      {
        id: 'adult-2',
        name: 'Adult 2 (younger)',
        birthYear: 1993,
        statePensionEnabled: true,
        healthcareRequired: true,
        remunerationType: 'boardMemberFee',
        workRoleRecorded: false,
        voluntaryHealthcare: true,
        allowNoInsurance: false,
      },
    ],
  };
}

export function defaultStartState(): WithdrawalStartState {
  const provenance = {
    personalCash: 'estimated' as const,
    ouCash: 'estimated' as const,
    ouInvestments: 'estimated' as const,
    shareholderLoan: 'estimated' as const,
    iiPillar: 'estimated' as const,
    iiiPillar: 'estimated' as const,
  };
  const balances: StartingBalanceSheet = {
    personalCash: 60_000,
    ouCash: 30_000,
    ouInvestments: 2_000_000,
    shareholderLoan: 300_000,
    iiPillar: 500_000,
    iiiPillar: 200_000,
    provenance,
  };
  return {
    withdrawalStartDate: '2033-01-01',
    startingBalancesAsOf: '2032-12-31',
    balances,
    minimumCashReserve: 10_000,
  };
}

export function defaultAssumptions(): Assumptions {
  return {
    generalInflation: 0.02,
    spendingInflation: 0.02,
    healthcareInflation: 0.02,
    spending: {
      targetAnnualTodayEUR: 35_000,
      multipliers: [],
      oneOffs: [],
      premiumsIncludedInSpending: false,
    },
    returns: {
      ou: { geometricReturn: 0.06, logVolatility: 0.15 },
      ii: { geometricReturn: 0.05, logVolatility: 0.12 },
      iii: { geometricReturn: 0.05, logVolatility: 0.12 },
      cashRate: 0.02,
      correlation: 0.95,
      returnFloor: null,
      stochasticInflation: {
        enabled: false,
        mean: 0.02,
        volatility: 0.01,
        persistence: 0.5,
        correlation: 0,
      },
    },
    voluntaryPremiumTodayEUR: 272,
    statePensionTodayEUR: 800,
    statePensionIndexation: 0.02,
    reinvestmentPct: 0.75,
    consumptionValuationRate: 0.06,
    pvDiscountRate: 0.06,
    maxRemunerationPerAdult: 2_000,
  };
}

export function defaultEngineSettings(): EngineSettings {
  return {
    reserveUsableAsLastResort: true,
    repaymentSolvencyRule: 'none',
    includeDistributionFirst: true,
    distributableEquityIncludesUnrealisedGains: true,
    iiContributionRate: 0,
    searchRemunerationType: false,
  };
}

export function defaultMonteCarloSettings(): MonteCarloSettings {
  return {
    screen1Paths: 100,
    screen2Paths: 400,
    quickPaths: 1_000,
    defaultPaths: 5_000,
    highPrecisionPaths: 20_000,
    seed: 42,
    screenFailureMargin1: 3,
    screenFailureMargin2: 3,
    stage2AWealthKeep: 10,
    stage2BWealthKeep: 30,
    stage2BFailureKeep: 10,
    targetSuccessProbability: 0.95,
    certifiedMode: false,
    precision: 'default',
    requireNoReserveBreach: false,
  };
}

export function defaultOptimisationSettings(): OptimisationSettings {
  return {
    tieWealthTolerance: 0.001,
    robustTieProbability: 0.001,
    lowestTaxWealthFloor: 0.95,
    simplestWealthFloor: 0.97,
    pillarDelayMin: 0,
    pillarDelayMax: 5,
    bufferCandidates: [0, 6, 12, 24],
    refinementIterations: 2,
    maxStage0Candidates: null,
  };
}

export function defaultPillarOverrides(): PillarOverrides {
  return {
    iiAccessYear: null,
    iiiAccessYear: null,
    iiEarlyWindowAssumedAvailable: true,
    iiTermOverride: null,
    iiiTermOverride: null,
    iiTermTable: {},
  };
}

export function createDefaultScenario(): Scenario {
  const now = '2026-09-24T00:00:00.000Z';
  return {
    id: `scenario-${Math.random().toString(36).slice(2, 10)}`,
    name: 'Base',
    createdAt: now,
    updatedAt: now,
    household: defaultHousehold(),
    startState: defaultStartState(),
    assumptions: defaultAssumptions(),
    engineSettings: defaultEngineSettings(),
    optimisationSettings: defaultOptimisationSettings(),
    monteCarloSettings: defaultMonteCarloSettings(),
    actuals: {},
    pillarOverrides: defaultPillarOverrides(),
  };
}

/** Registry bundled with the default scenario (UI keeps it in scenario state). */
export function defaultRegistry() {
  return createDefaultRegistry();
}

export const DEFAULT_BASE_YEAR = BASE_YEAR;
