/**
 * Withdrawal projection engine (Layer 5) — `runPolicy`.
 *
 * ONE implementation serves deterministic projection, optimisation diagnostics
 * and Monte Carlo (§16.3). Randomness/returns arrive via `StochasticState`;
 * the engine itself is pure and deterministic (no Date.now, no RNG).
 *
 * Canonical annual timing (§3.4): withdrawals and discretionary funding occur
 * at the START of the year; investment returns are applied afterwards to the
 * balances remaining after those flows. Money withdrawn at the start of the
 * year does not earn that year's investment return (deliberately conservative).
 *
 * Money: values rounded to cents at flow application points (round2).
 */

import type {
  ActualLedger,
  Assumptions,
  EngineSettings,
  FailureFlags,
  FlowBreakdown,
  HealthcareResult,
  Household,
  PillarOverrides,
  Policy,
  PolicyResult,
  RuleRegistry,
  Balances,
  TaxResult,
  YearResult,
  WithdrawalStartState,
} from '../types';
import type { StochasticState } from './returns';
import { round2 } from './money';
import {
  taxYearParams,
  remunerationPayroll,
  adultAnnualTax,
  distributionNetToGross,
  distributionGrossToNet,
  type TaxYearParams,
} from './tax';
import { healthcareYear, type HCOpts } from './healthcare';
import { pillarAccess, recommendedDuration, fixedTermPayment } from './pillars';
import { resolvePensionAge, statePensionStartYear } from './pension';
import { reachedPensionAgeInOrBefore, getRuleValue } from '../rules/registry';

export interface ProjectionContext {
  household: Household;
  startState: WithdrawalStartState;
  assumptions: Assumptions;
  engineSettings: EngineSettings;
  registry: RuleRegistry;
  pillarOverrides: PillarOverrides;
  baseYear: number;
  actuals: ActualLedger;
  /** Stress-test rule value overrides (e.g. distribution tax 24/76). */
  ruleOverrides?: Record<string, number>;
}

export class StructuralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuralError';
  }
}

export interface Horizon {
  startYear: number;
  endYear: number;
  length: number;
}

/** Horizon: first modelled year = withdrawal start; last = younger adult turns 100 (§3.3). */
export function computeHorizon(ctx: ProjectionContext): Horizon {
  const startYear = Number(ctx.startState.withdrawalStartDate.slice(0, 4));
  if (!Number.isFinite(startYear)) {
    throw new StructuralError(`Invalid withdrawalStartDate: ${ctx.startState.withdrawalStartDate}`);
  }
  const youngerBirth = Math.min(...ctx.household.adults.map((a) => a.birthYear));
  const endYear = youngerBirth + 100;
  if (endYear < startYear) {
    throw new StructuralError('Horizon is empty: end year before withdrawal start.');
  }
  return { startYear, endYear, length: endYear - startYear + 1 };
}

export interface PolicyEvents {
  phaseStartYears: number[];
  iiContractStart: number;
  iiiContractStart: number;
  iiTerm: number;
  iiiTerm: number;
  iiRemainingAtStart: number;
  iiiRemainingAtStart: number;
  pensionStartYears: Record<string, number>;
  pensionAges: Record<string, number>;
  access: ReturnType<typeof pillarAccess>;
}

/** Event years that define policy phases: start, pillar starts, pension starts (§10.3). */
export function computePolicyEvents(ctx: ProjectionContext, policy: Policy): PolicyEvents {
  const h = computeHorizon(ctx);
  const access = pillarAccess(ctx.household, ctx.pillarOverrides);
  const older = access.olderAdult;

  const iiContractStart = access.ii.year + policy.iiStartDelay;
  const iiiContractStart = access.iii.year + policy.iiiStartDelay;

  const iiTerm =
    ctx.pillarOverrides.iiTermOverride ??
    recommendedDuration(iiContractStart - older.birthYear, ctx.pillarOverrides);
  const iiiTerm =
    ctx.pillarOverrides.iiiTermOverride ??
    recommendedDuration(iiiContractStart - older.birthYear, ctx.pillarOverrides);

  const iiRemainingAtStart = iiTerm - Math.max(0, h.startYear - iiContractStart);
  const iiiRemainingAtStart = iiiTerm - Math.max(0, h.startYear - iiiContractStart);

  const pensionStartYears: Record<string, number> = {};
  const pensionAges: Record<string, number> = {};
  const eventYears = new Set<number>([h.startYear]);
  for (const a of ctx.household.adults) {
    const age = resolvePensionAge(a);
    pensionAges[a.id] = age;
    const ps = statePensionStartYear(a);
    pensionStartYears[a.id] = ps;
    if (ps > h.startYear && ps <= h.endYear) eventYears.add(ps);
  }
  if (iiContractStart > h.startYear && iiContractStart <= h.endYear) eventYears.add(iiContractStart);
  if (iiiContractStart > h.startYear && iiiContractStart <= h.endYear) eventYears.add(iiiContractStart);

  const phaseStartYears = [...eventYears].sort((a, b) => a - b);
  return {
    phaseStartYears,
    iiContractStart,
    iiiContractStart,
    iiTerm,
    iiiTerm,
    iiRemainingAtStart,
    iiiRemainingAtStart,
    pensionStartYears,
    pensionAges,
    access,
  };
}

/** Structural policy validation (Stage 1 discard reasons). */
export function validatePolicyStructure(ctx: ProjectionContext, policy: Policy): string | null {
  try {
    const h = computeHorizon(ctx);
    const events = computePolicyEvents(ctx, policy);
    if (policy.phaseStartYears.length === 0 || policy.phaseStartYears[0] !== h.startYear) {
      return 'policy phases must start at the withdrawal start year';
    }
    if (JSON.stringify(policy.phaseStartYears) !== JSON.stringify(events.phaseStartYears)) {
      return 'policy phase boundaries do not match event years';
    }
    if (policy.bufferMonths < 0) return 'buffer months negative';
    if (policy.iiStartDelay < 0 || policy.iiiStartDelay < 0) return 'negative pillar start delay';
    for (const a of ctx.household.adults) {
      const arr = policy.remunerationByPhase[a.id];
      if (!Array.isArray(arr) || arr.length !== policy.phaseStartYears.length) {
        return `remuneration schedule missing/short for adult ${a.id}`;
      }
      for (const v of arr) {
        if (!Number.isFinite(v) || v < 0) return 'remuneration must be a non-negative finite number';
        if (v > ctx.assumptions.maxRemunerationPerAdult + 1e-9) {
          return 'remuneration exceeds the configured defensible maximum';
        }
      }
    }
    if (policy.fundingRule !== 'LoanFirst' && policy.fundingRule !== 'DistributionFirst') {
      return 'unknown funding rule';
    }
    return null;
  } catch (e) {
    if (e instanceof StructuralError) return e.message;
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* runPolicy                                                           */
/* ------------------------------------------------------------------ */

interface MutableBalances {
  cash: number;
  ouCash: number;
  ouInv: number;
  loan: number;
  ii: number;
  iii: number;
}

export function runPolicy(
  ctx: ProjectionContext,
  policy: Policy,
  state: StochasticState,
): PolicyResult {
  const { household, startState, assumptions, engineSettings, registry, baseYear, actuals } = ctx;
  const adults = household.adults;
  const horizon = computeHorizon(ctx);
  const events = computePolicyEvents(ctx, policy);

  if (policy.phaseStartYears[0] !== horizon.startYear) {
    throw new StructuralError('policy.phaseStartYears[0] must equal the withdrawal start year');
  }
  if (JSON.stringify(policy.phaseStartYears) !== JSON.stringify(events.phaseStartYears)) {
    throw new StructuralError('policy phase boundaries do not match computed event years');
  }

  const reserve = startState.minimumCashReserve;
  const ruleOpts = {
    generalInflation: assumptions.generalInflation,
    healthcareInflation: assumptions.healthcareInflation,
    overrides: ctx.ruleOverrides,
  };
  const hcOpts: HCOpts = {
    generalInflation: assumptions.generalInflation,
    healthcareInflation: assumptions.healthcareInflation,
    baseYear,
  };
  const cvr = assumptions.consumptionValuationRate;
  const phaseLabels = policy.phaseStartYears.map((sy, idx) => ({
    startYear: sy,
    label: `Phase ${idx + 1}`,
  }));
  const distNum = getRuleValue(registry, 'distributionTaxNum', horizon.startYear, ruleOpts).value;
  const distDen = getRuleValue(registry, 'distributionTaxDen', horizon.startYear, ruleOpts).value;
  const latentFactor = distNum / (distNum + distDen); // tax as share of company outlay

  // --- running nominal growth factors (indexation exactly once, §3.4) ---
  let spendAnnual = assumptions.spending.targetAnnualTodayEUR;
  let premiumMonthly = assumptions.voluntaryPremiumTodayEUR;
  const pensionMonthly: Record<string, number> = {};
  for (const a of adults) {
    let m = a.statePensionTodayEUR ?? assumptions.statePensionTodayEUR;
    for (let y = baseYear + 1; y <= horizon.startYear; y++) m *= 1 + assumptions.statePensionIndexation;
    pensionMonthly[a.id] = m;
  }
  for (let y = baseYear + 1; y <= horizon.startYear; y++) {
    spendAnnual *= 1 + state.spendingInflation(y);
    premiumMonthly *= 1 + state.healthcareInflation(y);
  }

  // --- balances ---
  const bal: MutableBalances = {
    cash: startState.balances.personalCash,
    ouCash: startState.balances.ouCash,
    ouInv: startState.balances.ouInvestments,
    loan: startState.balances.shareholderLoan,
    ii: startState.balances.iiPillar,
    iii: startState.balances.iiiPillar,
  };
  let iiRemaining = events.iiRemainingAtStart;
  let iiiRemaining = events.iiiRemainingAtStart;

  // --- accumulators ---
  const years: YearResult[] = [];
  let lifetimeTax = 0;
  let lifetimeTaxToday = 0;
  let lifetimeTaxPV = 0;
  let taxPersonalAcc = 0;
  let taxCompanyAcc = 0;
  let healthcareCostTotal = 0;
  let extraTotal = 0;
  let rankedExtra = 0;
  let totalSpending = 0;
  let minOUEquity = Infinity;
  let anyShortfall = false;
  let anyCoverageFailure = false;
  let anyReserveBreach = false;
  let anyOUInsolvency = false;
  let firstShortfallYear: number | null = null;
  let firstCoverageFailureYear: number | null = null;
  let firstReserveBreachYear: number | null = null;
  let firstLiquidDepletionYear: number | null = null;
  let firstTotalDepletionYear: number | null = null;
  const failureYears: number[] = [];

  for (let i = 0; i < horizon.length; i++) {
    const year = horizon.startYear + i;

    // indexation once per year, using that year's effective rates
    if (i > 0) {
      spendAnnual *= 1 + state.spendingInflation(year);
      premiumMonthly *= 1 + state.healthcareInflation(year);
      for (const a of adults) pensionMonthly[a.id] *= 1 + assumptions.statePensionIndexation;
    }

    /* STEP 1 — start state (actuals override projections) ---------------- */
    const actual = actuals[year];
    let revaluationVariance = 0;
    const projectedStart: Balances = i === 0
      ? { ...startState.balances }
      : {
          personalCash: years[i - 1].end.personalCash,
          ouCash: years[i - 1].end.ouCash,
          ouInvestments: years[i - 1].end.ouInvestments,
          shareholderLoan: years[i - 1].end.shareholderLoan,
          iiPillar: years[i - 1].end.iiPillar,
          iiiPillar: years[i - 1].end.iiiPillar,
        };
    const startBalances: Balances = { ...projectedStart };
    if (actual) {
      const apply = (k: keyof Balances, v: number | undefined): void => {
        if (typeof v === 'number') {
          revaluationVariance += v - projectedStart[k];
          startBalances[k] = v;
        }
      };
      apply('personalCash', actual.personalCash);
      apply('ouCash', actual.ouCash);
      apply('ouInvestments', actual.ouInvestments);
      apply('shareholderLoan', actual.shareholderLoan);
      apply('iiPillar', actual.iiPillar);
      apply('iiiPillar', actual.iiiPillar);
    }
    bal.cash = startBalances.personalCash;
    bal.ouCash = startBalances.ouCash;
    bal.ouInv = startBalances.ouInvestments;
    bal.loan = startBalances.shareholderLoan;
    bal.ii = startBalances.iiPillar;
    bal.iii = startBalances.iiiPillar;
    const equityStart = round2(bal.ouCash + bal.ouInv - bal.loan);

    /* STEP 2 — year parameters ------------------------------------------ */
    const taxP = taxYearParams(registry, year, ruleOpts);
    let phaseIdx = 0;
    for (let p = 0; p < policy.phaseStartYears.length; p++) {
      if (policy.phaseStartYears[p] <= year) phaseIdx = p;
    }
    const remunerationMonthly: Record<string, number> = {};
    const multipliers = assumptions.spending.multipliers.filter((m) => year >= m.fromYear && year <= m.toYear);
    const multiplier = multipliers.length > 0 ? multipliers[0].multiplier : 1;
    const oneOff = assumptions.spending.oneOffs
      .filter((o) => o.year === year)
      .reduce((s, o) => s + o.amount, 0);
    let nominalTarget = round2(spendAnnual * multiplier + oneOff);
    if (actual && typeof actual.spending === 'number') nominalTarget = actual.spending;

    /* STEP 3–4 — contract-driven income & payroll (computed) ------------- */
    const pensionNetByAdult: Record<string, number> = {};
        const remNetByAdult: Record<string, number> = {};
    const payrollByAdult: Record<string, ReturnType<typeof remunerationPayroll>> = {};
    const taxByAdult: Record<string, ReturnType<typeof adultAnnualTax>> = {};
    const remTypes = policy.remunerationTypes ?? {};

    let employerCostTotal = 0;
    let pensionGrossTotal = 0;
    let remGrossTotal = 0;
    let remNetTotal = 0;

    for (const a of adults) {
      const schedule = policy.remunerationByPhase[a.id];
      if (!schedule || schedule[phaseIdx] === undefined) {
        throw new StructuralError(`Missing remuneration for adult ${a.id} at phase ${phaseIdx}`);
      }
      const monthlyGross = schedule[phaseIdx];
      remunerationMonthly[a.id] = monthlyGross;
      const pensionAge = events.pensionAges[a.id];
      const pensionActive = a.statePensionEnabled && year >= events.pensionStartYears[a.id];
      const pensionGross = pensionActive ? round2(pensionMonthly[a.id] * 12) : 0;
      const remType = remTypes[a.id] ?? a.remunerationType;

      const payroll = remunerationPayroll(
        taxP,
        monthlyGross,
        remType,
        engineSettings.iiContributionRate,
        a.birthYear,
        a.birthMonth,
        pensionAge,
        year,
      );
      payrollByAdult[a.id] = payroll;
      employerCostTotal = round2(employerCostTotal + payroll.employerCost);
      pensionGrossTotal = round2(pensionGrossTotal + pensionGross);
      remGrossTotal = round2(remGrossTotal + payroll.annualGross);

      const adultTax = adultAnnualTax(taxP, {
        adultId: a.id,
        year,
        birthYear: a.birthYear,
        birthMonth: a.birthMonth,
        pensionAge,
        statePensionEnabled: a.statePensionEnabled,
        statePensionAnnual: pensionGross,
        remuneration: payroll,
      });
      taxByAdult[a.id] = adultTax;
      pensionNetByAdult[a.id] = round2(pensionGross - adultTax.pitPension);
      remNetByAdult[a.id] = round2(
        payroll.annualGross - payroll.employeeUI - payroll.employeeII - adultTax.pitRemuneration,
      );
      remNetTotal = round2(remNetTotal + remNetByAdult[a.id]);
    }

    /* STEP 3b — pillar fixed-term payments (start of year, 0% tax) ------- */
    let pillarIIIPayment = 0;
    let pillarIIPayment = 0;
    if (
      year >= events.iiiContractStart &&
      iiiRemaining > 0 &&
      bal.iii > 0
    ) {
      const pay = round2(fixedTermPayment(bal.iii, iiiRemaining));
      bal.iii = round2(bal.iii - pay);
      pillarIIIPayment = pay;
      iiiRemaining -= 1;
    }
    if (
      year >= events.iiContractStart &&
      iiRemaining > 0 &&
      bal.ii > 0
    ) {
      const pay = round2(fixedTermPayment(bal.ii, iiRemaining));
      bal.ii = round2(bal.ii - pay);
      pillarIIPayment = pay;
      iiRemaining -= 1;
    }
    const pillarPayments = round2(pillarIIIPayment + pillarIIPayment);
    const contractInflows = round2(
      Object.values(pensionNetByAdult).reduce((s, v) => s + v, 0) + pillarPayments,
    );

    /* STEP 5 — healthcare coverage --------------------------------------- */
    const hcPlans = adults.map((a) =>
      healthcareYear(
        {
          adult: a,
          year,
          monthlyGross: remunerationMonthly[a.id],
          atPensionAge: reachedPensionAgeInOrBefore(a.birthYear, events.pensionAges[a.id], year),
          voluntaryPremiumTodayEUR: premiumMonthly,
        },
        registry,
        hcOpts,
      ),
    );
    const premiumDue = round2(hcPlans.reduce((s, p) => s + p.premium, 0));
    const coverageInactive = hcPlans.filter((p) => p.failure).map((p) => p.adultId);

    /* STEP 6 — expected OÜ-funded cash need ------------------------------ */
    const cashPre = bal.cash;
    const cashAboveReservePre = Math.max(0, cashPre - reserve);
    const netIncomeExpected = round2(contractInflows + remNetTotal);
    const needBase = round2(premiumDue + nominalTarget);
    const expectedWithdrawal = Math.max(
      0,
      round2(needBase - netIncomeExpected - cashAboveReservePre),
    );
    const expectedOUCashNeed = round2(expectedWithdrawal + employerCostTotal);

    /* STEP 7 — OÜ cash-buffer allocation (before outflows and returns) ---- */
    const bufferTarget = Math.min(
      round2((policy.bufferMonths / 12) * expectedOUCashNeed),
      round2(bal.ouCash + bal.ouInv),
    );
    let ouCashFromInvestments = 0;
    let ouCashToInvestments = 0;
    if (bufferTarget > bal.ouCash) {
      const move = round2(Math.min(bufferTarget - bal.ouCash, bal.ouInv));
      bal.ouInv = round2(bal.ouInv - move);
      bal.ouCash = round2(bal.ouCash + move);
      ouCashFromInvestments = move;
    } else if (bufferTarget < bal.ouCash) {
      const move = round2(bal.ouCash - bufferTarget);
      bal.ouCash = round2(bal.ouCash - move);
      bal.ouInv = round2(bal.ouInv + move);
      ouCashToInvestments = move;
    }

    /* STEP 8 — pay remuneration & company charges (OÜ cash first, D-25) --- */
    let ouInvestmentSales = 0;
    const cost = employerCostTotal;
    let paidFraction = 1;
    if (cost > 0) {
      const available = round2(bal.ouCash + bal.ouInv);
      const paid = Math.min(cost, available);
      paidFraction = paid / cost;
      const fromCash = Math.min(bal.ouCash, paid);
      bal.ouCash = round2(bal.ouCash - fromCash);
      const sell = round2(paid - fromCash);
      bal.ouInv = round2(bal.ouInv - sell);
      ouInvestmentSales = round2(ouInvestmentSales + sell);
    }
    let remNetPaid = 0;
    for (const a of adults) {
      const paidNet = round2(remNetByAdult[a.id] * paidFraction);
      remNetPaid = round2(remNetPaid + paidNet);
    }
    bal.cash = round2(bal.cash + remNetPaid);
    // contract-driven inflows credited to personal cash
    bal.cash = round2(bal.cash + contractInflows);

    /* STEP 9–13 — household need funding --------------------------------- */
    const netIncome = round2(contractInflows + remNetPaid);
    const surplus = Math.max(0, round2(netIncome - needBase));

    let healthLeft = premiumDue;
    let spendLeft = nominalTarget;
    const consume = (amount: number): number => {
      const h = Math.min(amount, healthLeft);
      healthLeft = round2(healthLeft - h);
      const rest = round2(amount - h);
      const s = Math.min(rest, spendLeft);
      spendLeft = round2(spendLeft - s);
      return round2(h + s);
    };

    let cashUsedAboveReserve = 0;
    let emergencyUsed = 0;
    let loanRepayment = 0;
    let distributionNet = 0;
    let distributionTaxPaid = 0;
    let reinvestment = 0;
    let extraSpending = 0;

    if (surplus > 0) {
      /* STEP 14 — retirement surplus rule (6.6). Income covers ordinary
         need, so no OÜ draw occurs and no repayment can coexist with a new
         shareholder loan. */
      consume(needBase);
      bal.cash = round2(bal.cash - needBase);
      reinvestment = round2(surplus * assumptions.reinvestmentPct);
      extraSpending = round2(surplus - reinvestment);
      bal.cash = round2(bal.cash - reinvestment - extraSpending);
      bal.loan = round2(bal.loan + reinvestment);
      bal.ouCash = round2(bal.ouCash + reinvestment);
      // re-establish the buffer target after the new loan proceeds arrive
      const t2 = Math.min(bufferTarget, round2(bal.ouCash + bal.ouInv));
      if (bal.ouCash > t2) {
        const move = round2(bal.ouCash - t2);
        bal.ouCash = round2(bal.ouCash - move);
        bal.ouInv = round2(bal.ouInv + move);
        ouCashToInvestments = round2(ouCashToInvestments + move);
      }
    } else {
      // STEP 11 — personal cash above the minimum reserve
      const avail = Math.max(0, round2(bal.cash - reserve));
      const gap0 = round2(healthLeft + spendLeft);
      const use1 = Math.min(avail, gap0);
      if (use1 > 0) {
        consume(use1);
        bal.cash = round2(bal.cash - use1);
        cashUsedAboveReserve = use1;
      }

      const equityNow = (): number => round2(bal.ouCash + bal.ouInv - bal.loan);

      const drawLoan = (): void => {
        let gap = round2(healthLeft + spendLeft);
        if (gap <= 0) return;
        if (
          engineSettings.repaymentSolvencyRule === 'blockIfEquityNegative' &&
          equityNow() < 0
        ) return;
        if (bal.loan <= 0) return;
        const ouAssets = round2(bal.ouCash + bal.ouInv);
        if (ouAssets <= 0) return;
        let R = Math.min(gap, bal.loan, ouAssets);
        if (R <= 0) return;
        const fromCash = Math.min(bal.ouCash, R);
        bal.ouCash = round2(bal.ouCash - fromCash);
        const sell = round2(Math.min(bal.ouInv, R - fromCash));
        bal.ouInv = round2(bal.ouInv - sell);
        ouInvestmentSales = round2(ouInvestmentSales + sell);
        const paid = round2(fromCash + sell);
        bal.loan = round2(bal.loan - paid);
        // The repayment proceeds are applied directly to the household's
        // remaining need in this same funding step (equivalent to crediting
        // personal cash and immediately paying it out — §3.4 step 12).
        loanRepayment = round2(loanRepayment + paid);
        consume(paid);
      };

      const drawDistribution = (p: TaxYearParams): void => {
        const gap = round2(healthLeft + spendLeft);
        if (gap <= 0) return;
        const equity = equityNow();
        if (equity <= 0) return; // distributions impossible under the base model
        const ouAssets = round2(bal.ouCash + bal.ouInv);
        const maxOutlay = Math.min(equity, ouAssets);
        const maxNet = distributionGrossToNet(maxOutlay, p);
        // §6.3.5: a distribution is allowed only if the resulting company
        // outlay is supported by the distributable-equity rule. If the full
        // required net draw is not supported, this source is skipped entirely
        // and the funding rule falls through to the next source.
        if (maxNet + 1e-9 < gap) return;
        let D = distributionNetToGross(gap, p);
        const fromCash = Math.min(bal.ouCash, D);
        bal.ouCash = round2(bal.ouCash - fromCash);
        const sell = round2(Math.min(bal.ouInv, D - fromCash));
        bal.ouInv = round2(bal.ouInv - sell);
        ouInvestmentSales = round2(ouInvestmentSales + sell);
        D = round2(fromCash + sell);
        const N = distributionGrossToNet(D, p);
        const tax = round2(D - N);
        // Net distribution proceeds are applied directly to the remaining
        // household need in this same funding step (§3.4 step 12).
        distributionNet = round2(distributionNet + N);
        distributionTaxPaid = round2(distributionTaxPaid + tax);
        consume(N);
      };

      // STEP 12 — OÜ under the selected funding rule
      if (policy.fundingRule === 'LoanFirst') {
        drawLoan();
        drawDistribution(taxP);
      } else {
        drawDistribution(taxP);
        drawLoan();
      }

      // STEP 13 — emergency reserve as the final source
      const gapNow = round2(healthLeft + spendLeft);
      if (gapNow > 0 && engineSettings.reserveUsableAsLastResort) {
        const em = Math.min(bal.cash, gapNow);
        if (em > 0) {
          consume(em);
          bal.cash = round2(bal.cash - em);
          emergencyUsed = em;
        }
      }
    }

    const shortfall = spendLeft > 1 ? spendLeft : 0;
    const premiumUnfunded = healthLeft > 1 ? healthLeft : 0;
    const coverageFailure = premiumUnfunded > 1 || coverageInactive.length > 0;
    const spendingShortfall = shortfall > 1;

    // cash level after all start-of-year flows, before returns
    const minCashDuringYear = round2(bal.cash);
    const reserveBreach = emergencyUsed > 0.005 || bal.cash < reserve - 0.005;

    /* STEP 15 — investment returns (after all flows) --------------------- */
    const rOu = Math.max(state.ouReturn(year), ctx.assumptions.returns.returnFloor ?? -Infinity);
    const rIi = Math.max(state.iiReturn(year), ctx.assumptions.returns.returnFloor ?? -Infinity);
    const rIii = Math.max(state.iiiReturn(year), ctx.assumptions.returns.returnFloor ?? -Infinity);
    const cashRate = assumptions.returns.cashRate;

    const ouInvBeforeReturn = bal.ouInv;
    const iiBeforeReturn = bal.ii;
    const iiiBeforeReturn = bal.iii;
    const cashBeforeReturn = bal.cash;
    const ouCashBeforeReturn = bal.ouCash;

    bal.ouInv = round2(bal.ouInv * (1 + rOu));
    bal.ii = round2(bal.ii * (1 + rIi));
    bal.iii = round2(bal.iii * (1 + rIii));
    bal.cash = round2(bal.cash * (1 + cashRate));
    bal.ouCash = round2(bal.ouCash * (1 + cashRate));

    // II contributions from remuneration are credited at year end (default 0%)
    let iiContributions = 0;
    for (const a of adults) {
      iiContributions = round2(iiContributions + payrollByAdult[a.id].employeeII * paidFraction);
    }
    bal.ii = round2(bal.ii + iiContributions);

    const ouReturnAmount = round2(bal.ouInv - ouInvBeforeReturn);
    const iiReturnAmount = round2(bal.ii - iiBeforeReturn - iiContributions);
    const iiiReturnAmount = round2(bal.iii - iiiBeforeReturn);
    const cashReturnAmount = round2(
      bal.cash - cashBeforeReturn + (bal.ouCash - ouCashBeforeReturn),
    );

    /* STEP 16 — end-of-year aggregation ---------------------------------- */
    const endBalances: Balances = {
      personalCash: bal.cash,
      ouCash: bal.ouCash,
      ouInvestments: bal.ouInv,
      shareholderLoan: bal.loan,
      iiPillar: bal.ii,
      iiiPillar: bal.iii,
    };
    const equityEnd = round2(bal.ouCash + bal.ouInv - bal.loan);
    const netWorthEnd = round2(bal.cash + bal.ouCash + bal.ouInv + bal.ii + bal.iii);

    // taxes (payroll lines pro-rated by paidFraction; pension lines always in full)
    const pitByAdult: Record<string, number> = {};
    let totalPIT = 0;
    let employeeUI = 0;
    let employeeII = 0;
    let employerSocialTax = 0;
    let employerUI = 0;
    for (const a of adults) {
      const t = taxByAdult[a.id];
      const pr = payrollByAdult[a.id];
      const pitAdult = round2(t.pitPension + t.pitRemuneration * paidFraction);
      pitByAdult[a.id] = pitAdult;
      totalPIT = round2(totalPIT + pitAdult);
      employeeUI = round2(employeeUI + pr.employeeUI * paidFraction);
      employeeII = round2(employeeII + pr.employeeII * paidFraction);
      employerSocialTax = round2(employerSocialTax + pr.employerSocialTax * paidFraction);
      employerUI = round2(employerUI + pr.employerUI * paidFraction);
    }
    const taxResult: TaxResult = {
      year,
      pitByAdult,
      employeeUI,
      employerSocialTax,
      employerUI,
      employeeII,
      distributionTax: distributionTaxPaid,
      totalPIT,
      personalTaxes: round2(totalPIT + employeeUI),
      companyCharges: round2(employerSocialTax + employerUI),
      total: round2(totalPIT + employeeUI + employerSocialTax + employerUI + distributionTaxPaid),
      ruleIds: ['pitRate', 'basicExemptionMonthly', 'socialTaxRate', 'employeeUIRate', 'employerUIRate'],
    };

    const healthcareResult: HealthcareResult = {
      year,
      premiumPaid: round2(premiumDue - premiumUnfunded),
      coverageFailure,
      uncoveredAdults: coverageInactive,
      perAdult: Object.fromEntries(
        hcPlans.map((p) => [
          p.adultId,
          {
            route: p.route,
            coveredMonths:
              coverageInactive.includes(p.adultId) || (p.premium > 0 && premiumUnfunded > 1)
                ? 0
                : p.coveredMonths,
            premium: p.premium > 0 && premiumUnfunded > 1 ? 0 : p.premium,
          },
        ]),
      ),
    };

    const realisedTarget = round2(nominalTarget - spendLeft);
    const realisedSpending = round2(realisedTarget + extraSpending);

    const failures: FailureFlags = {
      spendingShortfall,
      coverageFailure,
      reserveBreach,
      ouInsolvency: equityEnd < -0.005 || equityStart < -0.005,
    };

    const liquidAssets = round2(bal.ouCash + bal.ouInv + Math.max(0, bal.cash - reserve));
    const totalAssets = round2(bal.cash + bal.ouCash + bal.ouInv + bal.ii + bal.iii);
    const liquidDepleted = liquidAssets <= 0.005;
    const totalDepleted = totalAssets <= 0.005;

    // first-failure bookkeeping
    if (spendingShortfall) {
      anyShortfall = true;
      if (firstShortfallYear === null) firstShortfallYear = year;
    }
    if (coverageFailure) {
      anyCoverageFailure = true;
      if (firstCoverageFailureYear === null) firstCoverageFailureYear = year;
    }
    if (reserveBreach) {
      anyReserveBreach = true;
      if (firstReserveBreachYear === null) firstReserveBreachYear = year;
    }
    if (failures.ouInsolvency) anyOUInsolvency = true;
    if (liquidDepleted && firstLiquidDepletionYear === null) firstLiquidDepletionYear = year;
    if (totalDepleted && firstTotalDepletionYear === null) firstTotalDepletionYear = year;
    if (spendingShortfall || coverageFailure) failureYears.push(year);
    minOUEquity = Math.min(minOUEquity, equityStart, equityEnd);

    // flows & lifetime accounting
    const flows: FlowBreakdown = {
      statePensionGross: pensionGrossTotal,
      statePensionNet: round2(
        adults.reduce(
          (s, a) => s + (pensionNetByAdult[a.id] ?? 0),
          0,
        ),
      ),
      pillarIIIPayment,
      pillarIIPayment,
      remunerationGross: remGrossTotal,
      remunerationNet: remNetPaid,
      employerCost: round2(cost * paidFraction),
      healthcarePremium: healthcareResult.premiumPaid,
      personalCashUsedAboveReserve: cashUsedAboveReserve,
      emergencyReserveUsed: emergencyUsed,
      loanRepayment,
      distributionNet,
      distributionTax: distributionTaxPaid,
      ouInvestmentSales,
      ouCashFromInvestments,
      ouCashToInvestments,
      reinvestment,
      extraSpending,
      targetSpending: nominalTarget,
      spendingShortfall: shortfall,
      taxes: taxResult,
    };

    lifetimeTax = round2(lifetimeTax + taxResult.total);
    lifetimeTaxToday = round2(
      lifetimeTaxToday + taxResult.total / (1 + assumptions.generalInflation) ** (year - baseYear),
    );
    lifetimeTaxPV = round2(
      lifetimeTaxPV + taxResult.total / (1 + assumptions.pvDiscountRate) ** (year - horizon.startYear),
    );
    taxPersonalAcc = round2(taxPersonalAcc + taxResult.personalTaxes);
    taxCompanyAcc = round2(
      taxCompanyAcc + taxResult.companyCharges + taxResult.distributionTax,
    );
    healthcareCostTotal = round2(healthcareCostTotal + healthcareResult.premiumPaid);
    extraTotal = round2(extraTotal + extraSpending);
    rankedExtra = round2(rankedExtra + extraSpending * (1 + cvr) ** (horizon.endYear - year));
    totalSpending = round2(totalSpending + realisedSpending);

    years.push({
      year,
      ageOlder: year - events.access.olderAdult.birthYear,
      ageYounger: year - Math.min(...adults.map((a) => a.birthYear)),
      start: startBalances,
      end: endBalances,
      ouEquityStart: equityStart,
      ouEquityEnd: equityEnd,
      netWorthEnd,
      nominalSpending: nominalTarget,
      realisedSpending,
      extraSpending,
      healthPremium: healthcareResult.premiumPaid,
      inflows: flows,
      taxes: taxResult,
      healthcare: healthcareResult,
      failures,
      investmentReturns: {
        ou: ouReturnAmount,
        ii: iiReturnAmount,
        iii: iiiReturnAmount,
        cash: cashReturnAmount,
        total: round2(ouReturnAmount + iiReturnAmount + iiiReturnAmount + cashReturnAmount),
      },
      latentTax: round2(Math.max(0, equityEnd) * latentFactor),
      healthcareCost: healthcareResult.premiumPaid,
      minCashDuringYear,
      remunerationMonthly,
      statePensionMonthly: Object.fromEntries(
        adults.map((a) => [
          a.id,
          a.statePensionEnabled && year >= events.pensionStartYears[a.id]
            ? round2(pensionMonthly[a.id])
            : 0,
        ]),
      ),
      phases: phaseLabels,
      revaluationVariance,
    });
  }

  const last = years[years.length - 1];
  const terminalWealth = last.netWorthEnd;
  const rankedWealth = round2(terminalWealth + rankedExtra);
  const feasible = !anyShortfall && !anyCoverageFailure;

  return {
    policyId: policy.id,
    years,
    feasible,
    anyReserveBreach,
    ouInsolvencyAnyYear: anyOUInsolvency,
    terminalWealth,
    rankedWealth,
    lifetimeTaxNominal: lifetimeTax,
    lifetimeTaxTodayEUR: lifetimeTaxToday,
    lifetimeTaxPV,
    lifetimeTaxPersonal: taxPersonalAcc,
    lifetimeTaxCompany: taxCompanyAcc,
    lifetimeHealthcareCost: healthcareCostTotal,
    totalExtraSpending: extraTotal,
    firstShortfallYear,
    firstCoverageFailureYear,
    firstReserveBreachYear,
    firstLiquidDepletionYear,
    firstTotalDepletionYear,
    minOUEquity: Number.isFinite(minOUEquity) ? minOUEquity : 0,
    totalSpending,
    failureYears,
  };
}
