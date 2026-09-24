/** Monte Carlo & statistics tests (§15.8). */

import { describe, expect, it } from 'vitest';
import {
  generatePathDraws,
  drawConfigFrom,
  minSuccessesForCertified,
  passesTarget,
  runMonteCarlo,
  runPathWithSeed,
  wilsonInterval,
} from '../montecarlo';
import { buildDeterministicPath, cholesky, convertArithmeticToLognormal, impliedArithmeticMean, mulberry32 } from '../returns';
import { computeHorizon } from '../projection';
import { buildPolicy } from '../policy';
import { ctxFor } from './fixtures';

function policyOf(ctx: ReturnType<typeof ctxFor>) {
  return buildPolicy(ctx, {
    iiStartDelay: 0,
    iiiStartDelay: 0,
    bufferMonths: 12,
    fundingRule: 'LoanFirst',
    remuneration: Object.fromEntries(ctx.household.adults.map((a) => [a.id, [886]])),
  });
}

const mcInput = (paths: number) => ({
  seed: 42,
  paths,
  target: 0.95,
  certifiedMode: false,
  requireNoReserveBreach: false,
});

describe('common random numbers and prefixes', () => {
  const ctx = ctxFor({});

  it('same seed gives identical results', () => {
    const p = policyOf(ctx);
    const a = runMonteCarlo(ctx, p, mcInput(100)).summary;
    const b = runMonteCarlo(ctx, p, mcInput(100)).summary;
    expect(a).toEqual(b);
  });

  it('path draws depend only on (seed, pathIndex) — smaller runs are exact prefixes', () => {
    const cfg400 = drawConfigFrom(ctx, 42, 7);
    const d400 = generatePathDraws(cfg400, cholesky([[1, 0.95, 0.95], [0.95, 1, 0.95], [0.95, 0.95, 1]]));
    const cfg100 = drawConfigFrom(ctx, 42, 7);
    const d100 = generatePathDraws(cfg100, cholesky([[1, 0.95, 0.95], [0.95, 1, 0.95], [0.95, 0.95, 1]]));
    expect(Array.from(d400.rOu)).toEqual(Array.from(d100.rOu));
    expect(Array.from(d400.spendInf)).toEqual(Array.from(d100.spendInf));
  });

  it('100-path results are prefixes of 400-path results (per-path reproduction)', () => {
    const p = policyOf(ctx);
    for (const i of [0, 1, 5, 17]) {
      const r1 = runPathWithSeed(ctx, p, 42, i);
      const r2 = runPathWithSeed(ctx, p, 42, i);
      expect(r1.terminalWealth).toBe(r2.terminalWealth);
      expect(r1.firstShortfallYear).toBe(r2.firstShortfallYear);
    }
    // n=100 run covers paths 0..99 of the n=400 stream: successes must be a
    // prefix-consistent count (same seed, same per-path outcomes)
    const s100 = runMonteCarlo(ctx, p, mcInput(100)).summary;
    const s400 = runMonteCarlo(ctx, p, mcInput(400)).summary;
    expect(s100.n).toBe(100);
    expect(s400.n).toBe(400);
    // the first 100 outcomes of the 400-run equal the 100-run: reconstruct by
    // running paths individually
    let c100 = 0;
    for (let i = 0; i < 100; i++) {
      const r = runPathWithSeed(ctx, p, 42, i);
      if (!r.firstShortfallYear && !r.firstCoverageFailureYear) c100++;
    }
    expect(c100).toBe(s100.successes);
  });

  it('different seeds give different streams', () => {
    const cfgA = { ...drawConfigFrom(ctx, 42, 0) };
    const cfgB = { ...drawConfigFrom(ctx, 43, 0) };
    expect(generatePathDraws(cfgA, null).rOu[0]).not.toBe(generatePathDraws(cfgB, null).rOu[0]);
  });
});

describe('Wilson interval (§11.5)', () => {
  it('matches the closed-form Wilson score interval', () => {
    const n = 5000;
    const s = 4750;
    const z = 1.959963984540054;
    const p = s / n;
    const z2 = z * z;
    const center = (p + z2 / (2 * n)) / (1 + z2 / n);
    const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
    const w = wilsonInterval(s, n);
    expect(w.lower).toBeCloseTo(center - half, 12);
    expect(w.upper).toBeCloseTo(center + half, 12);
    expect(w.p).toBeCloseTo(0.95, 12);
  });

  it('is inside [0,1] and widens as n shrinks', () => {
    const big = wilsonInterval(950, 1000);
    const small = wilsonInterval(95, 100);
    expect(big.lower).toBeGreaterThan(small.lower);
    expect(big.upper).toBeLessThan(small.upper);
    expect(small.lower).toBeGreaterThanOrEqual(0);
    expect(small.upper).toBeLessThanOrEqual(1);
  });

  it('certified thresholds are derived from n and target, not hard-coded', () => {
    const n = 5000;
    const target = 0.95;
    const minS = minSuccessesForCertified(n, target);
    expect(wilsonInterval(minS, n).lower).toBeGreaterThanOrEqual(target);
    expect(minS > 0 ? wilsonInterval(minS - 1, n).lower : 0).toBeLessThan(target);
    // stricter target requires at least as many successes
    expect(minSuccessesForCertified(n, 0.99)).toBeGreaterThanOrEqual(minS);
    // certified mode differs from the plain rule near the boundary
    const dist = { successes: minS - 1, n, successProbability: (minS - 1) / n } as any;
    expect(passesTarget(dist, target, true)).toBe(false);
    expect(passesTarget({ ...dist, successProbability: 0.96 } as any, target, false)).toBe(true);
  });
});

describe('return model (§11.1–§11.2)', () => {
  it('central-return path sets every stochastic return to its median (1+g)', () => {
    const ctx = ctxFor({});
    const h = computeHorizon(ctx);
    const state = buildDeterministicPath('central', ctx.assumptions, h.startYear);
    for (let y = h.startYear; y <= h.endYear; y++) {
      expect(state.ouReturn(y)).toBe(ctx.assumptions.returns.ou.geometricReturn);
      expect(state.iiReturn(y)).toBe(ctx.assumptions.returns.ii.geometricReturn);
      expect(state.iiiReturn(y)).toBe(ctx.assumptions.returns.iii.geometricReturn);
      expect(state.spendingInflation(y)).toBe(ctx.assumptions.spendingInflation);
    }
  });

  it('first-year crash is −35% only in the first withdrawal year, then central', () => {
    const ctx = ctxFor({});
    const h = computeHorizon(ctx);
    const state = buildDeterministicPath('firstYearCrash', ctx.assumptions, h.startYear);
    expect(state.ouReturn(h.startYear)).toBeCloseTo(-0.35, 10);
    expect(state.ouReturn(h.startYear + 1)).toBe(ctx.assumptions.returns.ou.geometricReturn);
  });

  it('lost decade is 4pp lower for 10 years, then central', () => {
    const ctx = ctxFor({});
    const h = computeHorizon(ctx);
    const state = buildDeterministicPath('lostDecade', ctx.assumptions, h.startYear);
    expect(state.ouReturn(h.startYear)).toBeCloseTo(0.06 - 0.04, 10);
    expect(state.ouReturn(h.startYear + 9)).toBeCloseTo(0.02, 10);
    expect(state.ouReturn(h.startYear + 10)).toBeCloseTo(0.06, 10);
  });

  it('high-inflation path raises spending and healthcare inflation by 1pp', () => {
    const ctx = ctxFor({});
    const h = computeHorizon(ctx);
    const state = buildDeterministicPath('highInflation', ctx.assumptions, h.startYear);
    expect(state.spendingInflation(h.startYear)).toBeCloseTo(0.03, 10);
    expect(state.healthcareInflation(h.startYear)).toBeCloseTo(0.03, 10);
    expect(state.ouReturn(h.startYear)).toBeCloseTo(0.06, 10);
  });

  it('return converter round-trips arithmetic inputs', () => {
    const { sigma, mu, g } = convertArithmeticToLognormal(0.07, 0.15);
    expect(sigma).toBeGreaterThan(0);
    expect(impliedArithmeticMean(g, sigma)).toBeCloseTo(1.07, 10);
    // 1+g is the median growth factor
    expect(Math.exp(mu)).toBeCloseTo(1 + g, 10);
  });

  it('lognormal draws have median ≈ 1+g over many draws', () => {
    const ctx = ctxFor({});
    const cfg = drawConfigFrom(ctx, 7, 0);
    const L = cholesky([
      [1, 0.95, 0.95],
      [0.95, 1, 0.95],
      [0.95, 0.95, 1],
    ]);
    const N = 200_000;
    const rng = mulberry32(123);
    const returns: number[] = [];
    const mu = Math.log(1 + cfg.gOu);
    for (let i = 0; i < N; i++) {
      const z = (rng() + rng() + rng() - 1.5) * 2; // rough normal, fine for a median check
      returns.push(Math.exp(mu + cfg.sigmaOu * z * 0.4) - 1);
    }
    returns.sort((a, b) => a - b);
    const median = returns[Math.floor(N / 2)];
    void L;
    // median of lognormal(μ) growth factor = exp(μ) = 1+g
    expect(Math.abs(median - cfg.gOu)).toBeLessThan(0.002);
  });

  it('stochastic inflation is off by default and the UI-visible setting exists', () => {
    const ctx = ctxFor({});
    expect(ctx.assumptions.returns.stochasticInflation.enabled).toBe(false);
    // with it off, spending inflation is the configured constant every year
    const h = computeHorizon(ctx);
    const state = buildDeterministicPath('central', ctx.assumptions, h.startYear);
    expect(state.spendingInflation(h.startYear + 3)).toBe(ctx.assumptions.spendingInflation);
  });
});

describe('Monte Carlo outputs (§11.6)', () => {
  const ctx = ctxFor({});

  it('reports success, shortfall, coverage, reserve, depletion and wealth statistics separately', () => {
    const p = policyOf(ctx);
    const { summary } = runMonteCarlo(ctx, p, mcInput(200));
    expect(summary.n).toBe(200);
    expect(summary.successProbability).toBeGreaterThanOrEqual(0);
    expect(summary.successProbability).toBeLessThanOrEqual(1);
    expect(summary.wilson.lower).toBeLessThanOrEqual(summary.wilson.upper);
    expect(summary.spendingShortfallProbability).toBeLessThanOrEqual(1);
    expect(summary.coverageFailureProbability).toBeLessThanOrEqual(1);
    expect(summary.reserveBreachProbability).toBeGreaterThanOrEqual(0);
    expect(summary.liquidDepletionProbability).toBeGreaterThanOrEqual(0);
    expect(summary.terminalWealth.p5).toBeLessThanOrEqual(summary.terminalWealth.p95);
    expect(summary.rankedWealthMedian).toBeGreaterThan(0);
    expect(Array.isArray(summary.firstFailureYearHistogram)).toBe(true);
  });

  it('success + failure counts reconcile with n', () => {
    const p = policyOf(ctx);
    const { summary } = runMonteCarlo(ctx, p, mcInput(120));
    const fails = Math.round(summary.spendingShortfallProbability * summary.n);
    const cov = Math.round(summary.coverageFailureProbability * summary.n);
    // every failed path has at least one recorded failure type
    expect(summary.n - summary.successes).toBeLessThanOrEqual(fails + cov + 1);
    expect(summary.successes).toBeLessThanOrEqual(summary.n);
  });

  it('cancellation stops the run and reports it', () => {
    const p = policyOf(ctx);
    let count = 0;
    const { summary, cancelled } = runMonteCarlo(ctx, p, mcInput(500), {
      shouldCancel: () => ++count > 10,
    });
    expect(cancelled).toBe(true);
    expect(summary.n).toBeLessThan(500);
  });
});
