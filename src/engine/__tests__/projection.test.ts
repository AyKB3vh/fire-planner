/**
 * Projection engine tests (§15.3–§15.7, §15.9) — annual timing, funding
 * rules, OÜ cash-first, buffer, reserve, surplus, conservation, pillars.
 */

import { describe, expect, it } from 'vitest';
import type { StochasticState } from '../returns';
import { buildDeterministicPath } from '../returns';
import { computeHorizon, runPolicy } from '../projection';
import { buildPolicy } from '../policy';
import { pillarAccess } from '../pillars';
import { adult, ctxFor } from './fixtures';
import type { ProjectionContext } from '../projection';
import type { Policy } from '../../types';

function central(ctx: ProjectionContext): StochasticState {
  return buildDeterministicPath('central', ctx.assumptions, computeHorizon(ctx).startYear);
}

function policyFor(
  ctx: ProjectionContext,
  fundingRule: 'LoanFirst' | 'DistributionFirst',
  remuneration: number[] = [0],
  bufferMonths = 0,
): Policy {
  const levels: Record<string, number[]> = {};
  for (const a of ctx.household.adults) levels[a.id] = remuneration;
  return buildPolicy(ctx, {
    iiStartDelay: 0,
    iiiStartDelay: 0,
    bufferMonths,
    fundingRule,
    remuneration: levels,
  });
}

/* ------------------------------------------------------------------ */
/* Property test 1 — single draw, face-value wealth (§15.3)            */
/* ------------------------------------------------------------------ */

describe('property 1: single draw face-value wealth', () => {
  function scenario(geometricReturn: number) {
    const ctx = ctxFor({
      adults: [adult({ id: 'a', birthYear: 1940 })],
      startYear: 2030,
      personalCash: 0,
      ouCash: 0,
      ouInvestments: 500_000,
      shareholderLoan: 100_000,
      iiPillar: 0,
      iiiPillar: 0,
      minimumCashReserve: 0,
      spending: 10_000,
      mutateAssumptions: (a) => {
        a.spendingInflation = 0;
        a.spending.multipliers = [{ fromYear: 2031, toYear: 2200, multiplier: 0 }];
        a.returns.ou.geometricReturn = geometricReturn;
        a.returns.ii.geometricReturn = geometricReturn;
        a.returns.iii.geometricReturn = geometricReturn;
        a.returns.cashRate = 0;
        a.consumptionValuationRate = 0;
      },
    });
    const h = computeHorizon(ctx);
    const state = buildDeterministicPath('central', ctx.assumptions, h.startYear);
    const lf = runPolicy(ctx, policyFor(ctx, 'LoanFirst'), state);
    const df = runPolicy(ctx, policyFor(ctx, 'DistributionFirst'), state);
    return { lf, df, G: (1 + geometricReturn) ** h.length };
  }

  it('at G = 1.0 the difference is x × 22/78 ≈ €2,820.51', () => {
    const { lf, df, G } = scenario(0);
    expect(G).toBe(1);
    expect(lf.feasible && df.feasible).toBe(true);
    expect(lf.terminalWealth - df.terminalWealth).toBeCloseTo(10_000 * (22 / 78) * G, 1);
    expect(lf.terminalWealth - df.terminalWealth).toBeCloseTo(2_820.51, 1);
  });

  it('at G = 1.5 the difference is x × 22/78 × G ≈ €4,230.77', () => {
    const g = Math.pow(1.5, 1 / 11) - 1; // 11 growth periods (2030..2040)
    const { lf, df, G } = scenario(g);
    expect(G).toBeCloseTo(1.5, 10);
    expect(lf.feasible && df.feasible).toBe(true);
    expect(lf.terminalWealth - df.terminalWealth).toBeCloseTo(10_000 * (22 / 78) * 1.5, 1);
    expect(lf.terminalWealth - df.terminalWealth).toBeCloseTo(4_230.77, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Property test 2 — two equal draws (§15.3)                           */
/* ------------------------------------------------------------------ */

describe('property 2: two equal draws', () => {
  function scenario(G1: number): number {
    const ctx = ctxFor({
      adults: [adult({ id: 'a', birthYear: 1940 })],
      startYear: 2030,
      personalCash: 0,
      ouCash: 0,
      ouInvestments: 30_000,
      shareholderLoan: 10_000,
      iiPillar: 0,
      iiiPillar: 0,
      minimumCashReserve: 0,
      spending: 10_000,
      mutateAssumptions: (a) => {
        a.spendingInflation = 0;
        a.spending.multipliers = [
          { fromYear: 2030, toYear: 2030, multiplier: 1 },
          { fromYear: 2031, toYear: 2031, multiplier: 0 },
          { fromYear: 2032, toYear: 2032, multiplier: 1 },
          { fromYear: 2033, toYear: 2200, multiplier: 0 },
        ];
        a.returns.cashRate = 0;
        a.consumptionValuationRate = 0;
      },
    });
    // time-varying returns: G(t→s) = G1 over 2030–2031, G(s→T) = 1.5 over 2032–2040
    const g1 = Math.sqrt(G1) - 1;
    const g2 = Math.pow(1.5, 1 / 9) - 1;
    const state: StochasticState = {
      ouReturn: (y) => (y <= 2031 ? g1 : g2),
      iiReturn: (y) => (y <= 2031 ? g1 : g2),
      iiiReturn: (y) => (y <= 2031 ? g1 : g2),
      spendingInflation: () => 0,
      healthcareInflation: () => 0,
    };
    const lf = runPolicy(ctx, policyFor(ctx, 'LoanFirst'), state);
    const df = runPolicy(ctx, policyFor(ctx, 'DistributionFirst'), state);
    expect(lf.feasible && df.feasible).toBe(true);
    return lf.terminalWealth - df.terminalWealth;
  }

  it('G(t→s) = 0.8, G(s→T) = 1.5 → ≈ −€846.15', () => {
    const diff = scenario(0.8);
    expect(diff).toBeCloseTo(-846.15, 1);
  });

  it('G(t→s) = 1.2, G(s→T) = 1.5 → ≈ +€846.15', () => {
    const diff = scenario(1.2);
    expect(diff).toBeCloseTo(846.15, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Annual timing, cash-first and buffer (§15.3, §15.6)                 */
/* ------------------------------------------------------------------ */

describe('annual timing and OÜ mechanics', () => {
  it('withdrawals occur before annual investment returns (start-of-year convention)', () => {
    const ctx = ctxFor({
      adults: [adult({ id: 'a', birthYear: 1940 })],
      startYear: 2030,
      personalCash: 0,
      ouCash: 0,
      ouInvestments: 100_000,
      shareholderLoan: 50_000,
      minimumCashReserve: 0,
      spending: 10_000,
      mutateAssumptions: (a) => {
        a.spendingInflation = 0;
        a.returns.ou.geometricReturn = 0.1;
        a.returns.cashRate = 0;
        a.spending.multipliers = [{ fromYear: 2031, toYear: 2200, multiplier: 0 }];
      },
    });
    const r = runPolicy(ctx, policyFor(ctx, 'LoanFirst'), central(ctx));
    const y0 = r.years[0];
    // €10,000 leaves at the start of 2030; remaining €90,000 then earns 10%.
    expect(y0.end.ouInvestments).toBeCloseTo(90_000 * 1.1, 1);
    expect(y0.end.ouInvestments).not.toBeCloseTo(100_000 * 1.1 - 10_000, 1);
  });

  it('OÜ cash is used first for a distribution; investments are sold only for the residual', () => {
    const ctx = ctxFor({
      adults: [adult({ id: 'a', birthYear: 1940 })],
      startYear: 2030,
      personalCash: 0,
      ouCash: 10_000,
      ouInvestments: 200_000,
      shareholderLoan: 0,
      minimumCashReserve: 0,
      spending: 15_000,
      mutateAssumptions: (a) => {
        a.spendingInflation = 0;
        a.spending.multipliers = [{ fromYear: 2031, toYear: 2200, multiplier: 0 }];
      },
    });
    const r = runPolicy(ctx, policyFor(ctx, 'DistributionFirst', [0], 12), central(ctx));
    const y0 = r.years[0];
    // buffer 12 months of expected need => OÜ cash set to €15,000 at start
    expect(y0.start.ouCash).toBe(10_000);
    expect(y0.inflows.ouCashFromInvestments).toBeCloseTo(5_000, 2);
    // outlay = 15,000 / 0.78 = 19,230.77; cash covers 15,000, sales cover the rest
    expect(y0.inflows.ouInvestmentSales).toBeCloseTo(19_230.77 - 15_000, 1);
    expect(y0.end.ouCash).toBeCloseTo(0, 1);
    expect(r.feasible).toBe(true);
  });

  it('no investment sale while sufficient OÜ cash is available (loan repayment)', () => {
    const ctx = ctxFor({
      adults: [adult({ id: 'a', birthYear: 1940 })],
      startYear: 2030,
      personalCash: 0,
      ouCash: 10_000,
      ouInvestments: 200_000,
      shareholderLoan: 50_000,
      minimumCashReserve: 0,
      spending: 15_000,
      mutateAssumptions: (a) => {
        a.spendingInflation = 0;
        a.spending.multipliers = [{ fromYear: 2031, toYear: 2200, multiplier: 0 }];
      },
    });
    const r = runPolicy(ctx, policyFor(ctx, 'LoanFirst', [0], 12), central(ctx));
    const y0 = r.years[0];
    expect(y0.inflows.loanRepayment).toBeCloseTo(15_000, 2);
    expect(y0.inflows.ouInvestmentSales).toBe(0);
    expect(y0.end.ouCash).toBeCloseTo(0, 1);
    expect(y0.end.shareholderLoan).toBeCloseTo(35_000, 2);
  });

  it('OÜ cash buffer is allocated at the start of the year, before outflows', () => {
    const ctx = ctxFor({
      adults: [adult({ id: 'a', birthYear: 1940 })],
      startYear: 2030,
      personalCash: 0,
      ouCash: 0,
      ouInvestments: 100_000,
      shareholderLoan: 50_000,
      minimumCashReserve: 0,
      spending: 10_000,
      mutateAssumptions: (a) => {
        a.spendingInflation = 0;
        a.spending.multipliers = [{ fromYear: 2031, toYear: 2200, multiplier: 0 }];
      },
    });
    const r = runPolicy(ctx, policyFor(ctx, 'LoanFirst', [0], 6), central(ctx));
    const y0 = r.years[0];
    // expected OÜ need = €10,000; 6-month buffer = €5,000 moved cash BEFORE the outflow
    expect(y0.inflows.ouCashFromInvestments).toBeCloseTo(5_000, 2);
    expect(y0.inflows.loanRepayment).toBeCloseTo(10_000, 2);
    // €5,000 came from cash (no extra sales), €5,000 was sold
    expect(y0.inflows.ouInvestmentSales).toBeCloseTo(5_000, 2);
  });
});

/* ------------------------------------------------------------------ */
/* Surplus rule (§6.6, §15.7)                                          */
/* ------------------------------------------------------------------ */

describe('retirement surplus rule', () => {
  function surplusCtx() {
    return ctxFor({
      adults: [adult({ id: 'a', birthYear: 1975 })], // III access 2030
      startYear: 2030,
      personalCash: 0,
      ouCash: 0,
      ouInvestments: 50_000,
      shareholderLoan: 0,
      iiPillar: 0,
      iiiPillar: 80_000 * 28, // 28-year term at age 55 => €80,000 in year 1
      minimumCashReserve: 0,
      spending: 60_000,
      mutateAssumptions: (a) => {
        a.spendingInflation = 0;
      },
    });
  }

  it('target €60k / income €80k → surplus €20k, reinvest €15k, extra spend €5k, actual €65k', () => {
    const ctx = surplusCtx();
    const r = runPolicy(ctx, policyFor(ctx, 'LoanFirst'), central(ctx));
    const y0 = r.years[0];
    expect(y0.inflows.pillarIIIPayment).toBeCloseTo(80_000, 2);
    expect(y0.extraSpending).toBeCloseTo(5_000, 2);
    expect(y0.inflows.reinvestment).toBeCloseTo(15_000, 2);
    expect(y0.realisedSpending).toBeCloseTo(65_000, 2);
    // recycling creates shareholder-loan principal
    expect(y0.end.shareholderLoan).toBeCloseTo(15_000, 2);
    // a repayment and a new loan never occur in the same year
    expect(y0.inflows.loanRepayment).toBe(0);
    // extra spending is not left as accidental cash
    expect(y0.end.personalCash).toBeCloseTo(0, 2);
  });

  it('ranked wealth adds back extra spending at the consumption valuation rate', () => {
    const ctx = surplusCtx();
    const r = runPolicy(ctx, policyFor(ctx, 'LoanFirst'), central(ctx));
    const h = computeHorizon(ctx);
    let expectedExtraValue = 0;
    for (const y of r.years) {
      expectedExtraValue += y.extraSpending * (1 + ctx.assumptions.consumptionValuationRate) ** (h.endYear - y.year);
    }
    expect(r.rankedWealth - r.terminalWealth).toBeCloseTo(expectedExtraValue, 1);
  });

  it('never repays and lends in the same year across a full default run', () => {
    const ctx = ctxFor({});
    const p = buildPolicy(ctx, {
      iiStartDelay: 0,
      iiiStartDelay: 0,
      bufferMonths: 12,
      fundingRule: 'LoanFirst',
      remuneration: Object.fromEntries(ctx.household.adults.map((a) => [a.id, [886]])),
    });
    const r = runPolicy(ctx, p, central(ctx));
    for (const y of r.years) {
      expect(y.inflows.loanRepayment > 0 && y.inflows.reinvestment > 0).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Reserve behaviour (§6.7)                                            */
/* ------------------------------------------------------------------ */

describe('emergency reserve', () => {
  function reserveCtx() {
    return ctxFor({
      adults: [adult({ id: 'a', birthYear: 1940 })],
      startYear: 2030,
      personalCash: 10_000,
      ouCash: 0,
      ouInvestments: 0,
      shareholderLoan: 0,
      minimumCashReserve: 10_000,
      spending: 10_000,
      mutateAssumptions: (a) => {
        a.spendingInflation = 0;
        a.returns.cashRate = 0;
        a.spending.multipliers = [{ fromYear: 2031, toYear: 2200, multiplier: 0 }];
      },
    });
  }

  it('reserve usable as last resort: breach is reported but is NOT a deterministic failure', () => {
    const ctx = reserveCtx();
    expect(ctx.engineSettings.reserveUsableAsLastResort).toBe(true);
    const r = runPolicy(ctx, policyFor(ctx, 'LoanFirst'), central(ctx));
    expect(r.feasible).toBe(true);
    expect(r.anyReserveBreach).toBe(true);
    expect(r.firstReserveBreachYear).toBe(2030);
    expect(r.years[0].inflows.emergencyReserveUsed).toBeCloseTo(10_000, 2);
    expect(r.years[0].end.personalCash).toBeCloseTo(0, 2);
  });

  it('reserve as hard floor: residual becomes a spending shortfall and infeasibility', () => {
    const ctx = reserveCtx();
    ctx.engineSettings = { ...ctx.engineSettings, reserveUsableAsLastResort: false };
    const r = runPolicy(ctx, policyFor(ctx, 'LoanFirst'), central(ctx));
    expect(r.feasible).toBe(false);
    expect(r.firstShortfallYear).toBe(2030);
    expect(r.years[0].inflows.emergencyReserveUsed).toBe(0);
    expect(r.years[0].end.personalCash).toBeCloseTo(10_000, 2);
  });
});

/* ------------------------------------------------------------------ */
/* Pillars (§7, §15.4)                                                 */
/* ------------------------------------------------------------------ */

describe('pillar mechanics', () => {
  it('household access dates use the older adult', () => {
    const ctx = ctxFor({}); // adults born 1991 & 1993
    const access = pillarAccess(ctx.household, ctx.pillarOverrides);
    expect(access.olderAdult.birthYear).toBe(1991);
    expect(access.iii.year).toBe(2046); // 1991 + 55 (unknown month)
    expect(access.ii.year).toBe(2056); // pension age 70 (placeholder projection), five years early
  });

  it('no pillar payment before the access year; start delay shifts the contract', () => {
    const ctx = ctxFor({});
    const p0 = buildPolicy(ctx, {
      iiStartDelay: 0,
      iiiStartDelay: 0,
      bufferMonths: 0,
      fundingRule: 'LoanFirst',
      remuneration: Object.fromEntries(ctx.household.adults.map((a) => [a.id, [0]])),
    });
    const r = runPolicy(ctx, p0, central(ctx));
    for (const y of r.years) {
      if (y.year < 2046) expect(y.inflows.pillarIIIPayment).toBe(0);
      if (y.year < 2056) expect(y.inflows.pillarIIPayment).toBe(0);
    }
    const pay2046 = r.years.find((y) => y.year === 2046)!;
    expect(pay2046.inflows.pillarIIIPayment).toBeCloseTo(pay2046.start.iiiPillar / 28, 1);

    const p2 = buildPolicy(ctx, {
      iiStartDelay: 2,
      iiiStartDelay: 2,
      bufferMonths: 0,
      fundingRule: 'LoanFirst',
      remuneration: Object.fromEntries(ctx.household.adults.map((a) => [a.id, [0]])),
    });
    const r2 = runPolicy(ctx, p2, central(ctx));
    expect(r2.years.find((y) => y.year === 2046)?.inflows.pillarIIIPayment).toBe(0);
    expect(r2.years.find((y) => y.year === 2048)!.inflows.pillarIIIPayment).toBeGreaterThan(0);
  });

  it('pillar payments carry no personal income tax and do not consume exemption', () => {
    const ctx = ctxFor({});
    const p = buildPolicy(ctx, {
      iiStartDelay: 0,
      iiiStartDelay: 0,
      bufferMonths: 0,
      fundingRule: 'LoanFirst',
      remuneration: Object.fromEntries(ctx.household.adults.map((a) => [a.id, [0]])),
    });
    const r = runPolicy(ctx, p, central(ctx));
    const firstPay = r.years.find((y) => y.inflows.pillarIIIPayment > 0)!;
    // Pillar payments are not personal income: no PIT by adult, no UI, no social tax.
    // (Company-side distribution tax may coexist in the same year — that is not personal tax.)
    expect(firstPay.taxes.totalPIT).toBe(0);
    expect(firstPay.taxes.personalTaxes).toBe(0);
    for (const v of Object.values(firstPay.taxes.pitByAdult)) expect(v).toBe(0);
    expect(firstPay.taxes.employeeUI).toBe(0);
    expect(firstPay.taxes.employeeII).toBe(0);
    expect(firstPay.inflows.pillarIIIPayment).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Healthcare (§8.2, §15.5)                                            */
/* ------------------------------------------------------------------ */

describe('healthcare coverage', () => {
  it('coverage failure when required and no route is active', () => {
    const ctx = ctxFor({
      adults: [adult({ id: 'a', birthYear: 1940, healthcareRequired: true, voluntaryHealthcare: false, allowNoInsurance: false })],
      startYear: 2030,
      personalCash: 100_000,
      ouCash: 0,
      ouInvestments: 0,
      shareholderLoan: 0,
      minimumCashReserve: 0,
      spending: 10_000,
    });
    const r = runPolicy(ctx, policyFor(ctx, 'LoanFirst'), central(ctx));
    expect(r.feasible).toBe(false);
    expect(r.firstCoverageFailureYear).toBe(2030);
    expect(r.years[0].healthcare.coverageFailure).toBe(true);
  });

  it('remuneration-based coverage activates at the registry threshold', () => {
    const ctx = ctxFor({
      adults: [adult({ id: 'a', birthYear: 1940, healthcareRequired: true, voluntaryHealthcare: false, allowNoInsurance: false })],
      startYear: 2030,
      personalCash: 200_000,
      ouCash: 100_000,
      ouInvestments: 300_000,
      shareholderLoan: 0,
      minimumCashReserve: 0,
      spending: 10_000,
      mutateAssumptions: (a) => {
        a.spendingInflation = 0;
        a.spending.multipliers = [{ fromYear: 2031, toYear: 2200, multiplier: 0 }];
      },
    });
    const r = runPolicy(ctx, policyFor(ctx, 'LoanFirst', [1200], 12), central(ctx));
    expect(r.feasible).toBe(true);
    expect(r.years[0].healthcare.perAdult['a'].route).toBe('remuneration');
    // coverage persists while remuneration stays above the inflation-indexed threshold
    expect(r.years[r.years.length - 1].healthcare.perAdult['a'].route).toBe('remuneration');
    expect(r.years.some((y) => y.healthcare.coverageFailure)).toBe(false);
  });

  it('state-pension toggle off removes both state pension income and the pensioner route', () => {
    const base = {
      adults: [adult({ id: 'a', birthYear: 1955, statePensionEnabled: true, healthcareRequired: true, voluntaryHealthcare: false, allowNoInsurance: false })],
      startYear: 2030,
      personalCash: 100_000,
      ouCash: 0,
      ouInvestments: 0,
      shareholderLoan: 0,
      minimumCashReserve: 0,
      spending: 10_000,
    };
    const on = ctxFor(base);
    const rOn = runPolicy(on, policyFor(on, 'LoanFirst'), central(on));
    expect(rOn.years[0].healthcare.perAdult['a'].route).toBe('statePensioner');
    expect(rOn.years[0].inflows.statePensionGross).toBeGreaterThan(0);

    const off = ctxFor({
      ...base,
      adults: [adult({ id: 'a', birthYear: 1955, statePensionEnabled: false, healthcareRequired: true, voluntaryHealthcare: false, allowNoInsurance: false })],
    });
    const rOff = runPolicy(off, policyFor(off, 'LoanFirst'), central(off));
    expect(rOff.years[0].inflows.statePensionGross).toBe(0);
    expect(rOff.years[0].healthcare.coverageFailure).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Inflation, conservation, determinism (§15.6, §15.9)                 */
/* ------------------------------------------------------------------ */

describe('inflation and determinism', () => {
  it('spending inflates exactly once per year at the spending rate', () => {
    const ctx = ctxFor({ spending: 60_000 });
    const r = runPolicy(ctx, policyFor(ctx, 'LoanFirst', [886], 12), central(ctx));
    const h = computeHorizon(ctx);
    const first = r.years[0];
    // values are rounded to cents at flow application points (documented policy)
    expect(Math.abs(first.nominalSpending - 60_000 * 1.02 ** (h.startYear - 2026))).toBeLessThan(0.01);
    for (let i = 1; i < r.years.length; i++) {
      expect(Math.abs(r.years[i].nominalSpending - r.years[i - 1].nominalSpending * 1.02)).toBeLessThan(0.01);
    }
  });

  it('identical inputs produce identical results (deterministic repeatability)', () => {
    const a = ctxFor({});
    const b = ctxFor({});
    const pa = policyFor(a, 'LoanFirst', [886], 12);
    const pb = policyFor(b, 'LoanFirst', [886], 12);
    const ra = runPolicy(a, pa, central(a));
    const rb = runPolicy(b, pb, central(b));
    expect(JSON.stringify(ra.years)).toBe(JSON.stringify(rb.years));
    expect(ra.terminalWealth).toBe(rb.terminalWealth);
    expect(ra.lifetimeTaxNominal).toBe(rb.lifetimeTaxNominal);
  });

  it('no asset balance is negative after executing valid flows', () => {
    const ctx = ctxFor({});
    // a deliberately aggressive policy: high remuneration + DistributionFirst
    const r = runPolicy(ctx, policyFor(ctx, 'DistributionFirst', [2000], 24), central(ctx));
    for (const y of r.years) {
      expect(y.end.personalCash).toBeGreaterThanOrEqual(-0.005);
      expect(y.end.ouCash).toBeGreaterThanOrEqual(-0.005);
      expect(y.end.ouInvestments).toBeGreaterThanOrEqual(-0.005);
      expect(y.end.shareholderLoan).toBeGreaterThanOrEqual(-0.005);
      expect(y.end.iiPillar).toBeGreaterThanOrEqual(-0.005);
      expect(y.end.iiiPillar).toBeGreaterThanOrEqual(-0.005);
      expect(y.inflows.loanRepayment).toBeLessThanOrEqual(y.start.shareholderLoan + 0.005);
    }
    // negative OÜ equity is reported as an insolvency flag, not silently repaired (D-26)
    if (r.minOUEquity < 0) expect(r.ouInsolvencyAnyYear).toBe(true);
  });
});

describe('conservation identity (§15.9)', () => {
  it('each year: ΔNW = returns + gross pension − taxes − premiums − spending (+ variance)', () => {
    const ctx = ctxFor({}); // full default household: pensions, pillars, remuneration, premiums
    const p = buildPolicy(ctx, {
      iiStartDelay: 0,
      iiiStartDelay: 0,
      bufferMonths: 12,
      fundingRule: 'LoanFirst',
      remuneration: Object.fromEntries(ctx.household.adults.map((a) => [a.id, [886]])),
    });
    const r = runPolicy(ctx, p, central(ctx));
    let prevNW =
      ctx.startState.balances.personalCash +
      ctx.startState.balances.ouCash +
      ctx.startState.balances.ouInvestments +
      ctx.startState.balances.iiPillar +
      ctx.startState.balances.iiiPillar;
    for (const y of r.years) {
      const nwStart = prevNW;
      const delta = y.netWorthEnd - nwStart;
      const rhs =
        y.investmentReturns.total +
        y.inflows.statePensionGross -
        y.taxes.total -
        y.healthPremium -
        y.realisedSpending +
        y.revaluationVariance;
      expect(Math.abs(delta - rhs)).toBeLessThan(0.1);
      prevNW = y.netWorthEnd;
    }
  });

  it('pillar transfers, loan repayments and new lending are net-worth neutral', () => {
    // covered implicitly by conservation across years with heavy pillar/loan activity
    const ctx = ctxFor({});
    const p = buildPolicy(ctx, {
      iiStartDelay: 0,
      iiiStartDelay: 0,
      bufferMonths: 0,
      fundingRule: 'LoanFirst',
      remuneration: Object.fromEntries(ctx.household.adults.map((a) => [a.id, [0]])),
    });
    const r = runPolicy(ctx, p, central(ctx));
    let prevNW =
      ctx.startState.balances.personalCash +
      ctx.startState.balances.ouCash +
      ctx.startState.balances.ouInvestments +
      ctx.startState.balances.iiPillar +
      ctx.startState.balances.iiiPillar;
    for (const y of r.years) {
      const delta = y.netWorthEnd - prevNW;
      const rhs =
        y.investmentReturns.total +
        y.inflows.statePensionGross -
        y.taxes.total -
        y.healthPremium -
        y.realisedSpending +
        y.revaluationVariance;
      expect(Math.abs(delta - rhs)).toBeLessThan(0.1);
      prevNW = y.netWorthEnd;
    }
  });
});

describe('actuals ledger (§12.1)', () => {
  it('actual overrides the projected start and records a revaluation variance', () => {
    const ctx = ctxFor({});
    ctx.actuals = {
      2035: { year: 2035, personalCash: 12_345, provenance: 'actual' },
    };
    const p = policyFor(ctx, 'LoanFirst', [886], 12);
    const r = runPolicy(ctx, p, central(ctx));
    const y = r.years.find((x) => x.year === 2035)!;
    expect(y.start.personalCash).toBe(12_345);
    expect(y.revaluationVariance).toBeCloseTo(12_345 - r.years.find((x) => x.year === 2034)!.end.personalCash, 6);
    // following year continues from the actual
    const next = r.years.find((x) => x.year === 2036)!;
    expect(next.start.personalCash).not.toBe(12_345); // projected forward from 2035 end
    expect(next.start.ouInvestments).toBeCloseTo(y.end.ouInvestments, 6);
  });
});

describe('starting-state validation (§15.1)', () => {
  it('rejects non-1-January withdrawal dates, negative balances, and stops the run', async () => {
    const { validateStartingState } = await import('../validate');
    const ctx = ctxFor({});
    expect(validateStartingState(ctx).ok).toBe(true);

    const badDate = ctxFor({});
    badDate.startState.withdrawalStartDate = '2033-06-15';
    const v1 = validateStartingState(badDate);
    expect(v1.ok).toBe(false);
    expect(v1.issues.some((i) => i.field === 'withdrawalStartDate')).toBe(true);

    const negative = ctxFor({ personalCash: -1 });
    const v2 = validateStartingState(negative);
    expect(v2.ok).toBe(false);
    expect(v2.issues.some((i) => i.field === 'personalCash')).toBe(true);
  });
});

describe('real value helpers', () => {
  it('toNominal and toToday round-trip', async () => {
    const { toNominal, toToday } = await import('../money');
    const v = toNominal(100, 0.02, 2026, 2036);
    expect(v).toBeCloseTo(100 * 1.02 ** 10, 8);
    expect(toToday(v, 0.02, 2026, 2036)).toBeCloseTo(100, 8);
  });
});
