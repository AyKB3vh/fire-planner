/**
 * Monte Carlo engine & statistics (Layer 8, §11).
 *
 * - Uses exactly the same `runPolicy` engine as deterministic projections.
 * - Common random numbers: path i's draw stream depends only on (seed, i),
 *   so 100-path results are prefixes of 400-path results, which are prefixes
 *   of 5,000/20,000-path results for a given seed.
 * - Lognormal returns: R = exp(μ + σZ), μ = ln(1+g) — 1+g is the MEDIAN
 *   annual growth factor. Correlation via Cholesky of the configured matrix.
 * - Modelled success probability p̂ and the 95% Wilson interval are always
 *   reported separately; the target is a success target, never a confidence
 *   level (D-22).
 */

import type {
  MCDistribution,
  PathOutcome,
  Policy,
  WilsonInterval,
} from '../types';
import type { ProjectionContext } from './projection';
import { runPolicy, computeHorizon } from './projection';
import type { StochasticState } from './returns';
import {
  buildDeterministicPath,
  cholesky,
  defaultCorrelationMatrix,
  makeRng,
  standardNormal,
} from './returns';

/** Per-path draw matrices for the modelled horizon. */
export interface PathDraws {
  rOu: Float64Array;
  rIi: Float64Array;
  rIii: Float64Array;
  spendInf: Float64Array;
  healthInf: Float64Array;
}

export interface DrawConfig {
  seed: number;
  pathIndex: number;
  startYear: number;
  length: number;
  gOu: number;
  sigmaOu: number;
  gIi: number;
  sigmaIi: number;
  gIii: number;
  sigmaIii: number;
  correlation: number;
  returnFloor: number | null;
  stochasticInflation: {
    enabled: boolean;
    mean: number;
    volatility: number;
    persistence: number;
    correlation: number;
  };
  spendingInflation: number;
  healthcareInflation: number;
}

function correlationCholesky(cfg: DrawConfig): number[][] | null {
  if (!cfg.stochasticInflation.enabled) {
    const r = cfg.correlation;
    return cholesky([
      [1, r, r],
      [r, 1, r],
      [r, r, 1],
    ]);
  }
  return cholesky(
    defaultCorrelationMatrix(cfg.correlation, cfg.stochasticInflation.correlation),
  );
}

/**
 * Generate the full draw matrix for one path from (seed, pathIndex) alone —
 * this is what guarantees the common-random-number prefix property.
 */
export function generatePathDraws(cfg: DrawConfig, L: number[][] | null): PathDraws {
  const rng = makeRng(cfg.seed, cfg.pathIndex);
  const n = cfg.length;
  const rOu = new Float64Array(n);
  const rIi = new Float64Array(n);
  const rIii = new Float64Array(n);
  const spendInf = new Float64Array(n);
  const healthInf = new Float64Array(n);

  const muOu = Math.log(1 + cfg.gOu);
  const muIi = Math.log(1 + cfg.gIi);
  const muIii = Math.log(1 + cfg.gIii);
  const inf = cfg.stochasticInflation;

  let spendPrev = inf.enabled ? inf.mean : cfg.spendingInflation;
  let healthPrev = inf.enabled ? inf.mean : cfg.healthcareInflation;

  for (let i = 0; i < n; i++) {
    const z1 = standardNormal(rng);
    const z2 = standardNormal(rng);
    const z3 = standardNormal(rng);
    let zInf = 0;
    if (inf.enabled) zInf = standardNormal(rng);

    if (L) {
      // correlated factor normals
      const c0 = L[0][0] * z1;
      const c1 = L[1][0] * z1 + L[1][1] * z2;
      const c2 = L[2][0] * z1 + L[2][1] * z2 + L[2][2] * z3;
      rOu[i] = Math.exp(muOu + cfg.sigmaOu * c0) - 1;
      rIi[i] = Math.exp(muIi + cfg.sigmaIi * c1) - 1;
      rIii[i] = Math.exp(muIii + cfg.sigmaIii * c2) - 1;
      if (inf.enabled && L.length === 4) {
        const c3 = L[3][0] * z1 + L[3][1] * z2 + L[3][2] * z3 + L[3][3] * zInf;
        zInf = c3;
      }
    } else {
      rOu[i] = Math.exp(muOu + cfg.sigmaOu * z1) - 1;
      rIi[i] = Math.exp(muIi + cfg.sigmaIi * z2) - 1;
      rIii[i] = Math.exp(muIii + cfg.sigmaIii * z3) - 1;
    }

    if (cfg.returnFloor !== null) {
      if (rOu[i] < cfg.returnFloor) rOu[i] = cfg.returnFloor;
      if (rIi[i] < cfg.returnFloor) rIi[i] = cfg.returnFloor;
      if (rIii[i] < cfg.returnFloor) rIii[i] = cfg.returnFloor;
    }

    if (inf.enabled) {
      const zS = standardNormal(rng);
      const zH = standardNormal(rng);
      // AR(1) around the mean; independent of returns except via configured corr on general inflation
      spendPrev = inf.mean + inf.persistence * (spendPrev - inf.mean) + inf.volatility * zS;
      healthPrev = inf.mean + inf.persistence * (healthPrev - inf.mean) + inf.volatility * zH;
      spendInf[i] = spendPrev;
      healthInf[i] = healthPrev;
      // consume zInf for general inflation persistence (documented: statutory
      // registry extrapolation still uses configured mean inflation)
      void zInf;
    } else {
      spendInf[i] = cfg.spendingInflation;
      healthInf[i] = cfg.healthcareInflation;
    }
  }
  return { rOu, rIi, rIii, spendInf, healthInf };
}

export function drawsToState(
  draws: PathDraws,
  cfg: DrawConfig,
  spendingInflation: number,
  healthcareInflation: number,
): StochasticState {
  return {
    ouReturn: (y) => idx(y, cfg, draws.rOu),
    iiReturn: (y) => idx(y, cfg, draws.rIi),
    iiiReturn: (y) => idx(y, cfg, draws.rIii),
    spendingInflation: (y) =>
      y < cfg.startYear ? spendingInflation : idx(y, cfg, draws.spendInf),
    healthcareInflation: (y) =>
      y < cfg.startYear ? healthcareInflation : idx(y, cfg, draws.healthInf),
  };
}

function idx(year: number, cfg: DrawConfig, arr: Float64Array): number {
  const i = year - cfg.startYear;
  if (i < 0) return arr.length > 0 ? arr[0] : 0; // pre-start never used for returns
  if (i >= arr.length) return arr[arr.length - 1];
  return arr[i];
}

export function drawConfigFrom(ctx: ProjectionContext, seed: number, pathIndex: number): DrawConfig {
  const h = computeHorizon(ctx);
  const r = ctx.assumptions.returns;
  return {
    seed,
    pathIndex,
    startYear: h.startYear,
    length: h.length,
    gOu: r.ou.geometricReturn,
    sigmaOu: r.ou.logVolatility,
    gIi: r.ii.geometricReturn,
    sigmaIi: r.ii.logVolatility,
    gIii: r.iii.geometricReturn,
    sigmaIii: r.iii.logVolatility,
    correlation: r.correlation,
    returnFloor: r.returnFloor,
    stochasticInflation: r.stochasticInflation,
    spendingInflation: ctx.assumptions.spendingInflation,
    healthcareInflation: ctx.assumptions.healthcareInflation,
  };
}

/* ------------------------------------------------------------------ */
/* Wilson score interval (§11.5)                                       */
/* ------------------------------------------------------------------ */

export function wilsonInterval(successes: number, n: number, z = 1.959963984540054): WilsonInterval {
  if (n === 0) return { p: 0, lower: 0, upper: 1, n: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    p,
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
    n,
  };
}

/**
 * Smallest success count whose Wilson lower bound is at least `target` —
 * computed from n and target (never hard-coded), for certified mode.
 */
export function minSuccessesForCertified(n: number, target: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (wilsonInterval(mid, n).lower >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/* ------------------------------------------------------------------ */
/* Simulation runner                                                   */
/* ------------------------------------------------------------------ */

export interface MCHooks {
  onProgress?: (fraction: number, pathsDone: number) => void;
  shouldCancel?: () => boolean;
}

export interface MCSummaryInput {
  seed: number;
  paths: number;
  target: number;
  certifiedMode: boolean;
  requireNoReserveBreach: boolean;
}

function percentile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarise(
  outcomes: PathOutcome[],
  input: MCSummaryInput,
): MCDistribution {
  const n = outcomes.length;
  let successes = 0;
  let shortfall = 0;
  let coverage = 0;
  let reserve = 0;
  let liquid = 0;
  let totalDep = 0;
  let insolvency = 0;
  const wealth = new Float64Array(n);
  const ranked = new Float64Array(n);
  const tax = new Float64Array(n);
  const extra = new Float64Array(n);
  const failHist = new Map<number, number>();
  const depHist = new Map<number, number>();

  for (let i = 0; i < n; i++) {
    const o = outcomes[i];
    if (o.success) successes++;
    if (o.firstShortfallYear !== null) shortfall++;
    if (o.firstCoverageFailureYear !== null) coverage++;
    if (o.firstReserveBreachYear !== null) reserve++;
    if (o.firstLiquidDepletionYear !== null) liquid++;
    if (o.firstTotalDepletionYear !== null) totalDep++;
    if (o.minOUEquity < 0) insolvency++;
    wealth[i] = o.terminalWealth;
    ranked[i] = o.rankedWealth;
    tax[i] = o.lifetimeTax;
    extra[i] = o.extraSpending;
    if (o.firstFailureYear !== null) {
      failHist.set(o.firstFailureYear, (failHist.get(o.firstFailureYear) ?? 0) + 1);
    }
    if (o.firstLiquidDepletionYear !== null) {
      depHist.set(
        o.firstLiquidDepletionYear,
        (depHist.get(o.firstLiquidDepletionYear) ?? 0) + 1,
      );
    }
  }

  const sortIn = (a: Float64Array): Float64Array => Float64Array.from(a).sort();
  const wS = sortIn(wealth);
  const tS = sortIn(tax);
  const eS = sortIn(extra);
  const rArr = Float64Array.from(ranked).sort();

  const histToArr = (m: Map<number, number>) =>
    [...m.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));

  return {
    n,
    successes,
    successProbability: n > 0 ? successes / n : 0,
    wilson: wilsonInterval(successes, n),
    spendingShortfallProbability: n > 0 ? shortfall / n : 0,
    coverageFailureProbability: n > 0 ? coverage / n : 0,
    reserveBreachProbability: n > 0 ? reserve / n : 0,
    liquidDepletionProbability: n > 0 ? liquid / n : 0,
    totalDepletionProbability: n > 0 ? totalDep / n : 0,
    ouInsolvencyProbability: n > 0 ? insolvency / n : 0,
    terminalWealth: { median: percentile(wS, 0.5), p5: percentile(wS, 0.05), p95: percentile(wS, 0.95) },
    rankedWealthMedian: percentile(rArr, 0.5),
    lifetimeTax: { median: percentile(tS, 0.5), p5: percentile(tS, 0.05), p95: percentile(tS, 0.95) },
    extraSpending: { median: percentile(eS, 0.5), p5: percentile(eS, 0.05), p95: percentile(eS, 0.95) },
    firstFailureYearHistogram: histToArr(failHist),
    firstDepletionYearHistogram: histToArr(depHist),
  };
}

/**
 * Run `paths` Monte Carlo simulations of one policy. Paths are generated from
 * (seed, pathIndex) so smaller runs are exact prefixes of larger runs.
 */
export function runMonteCarlo(
  ctx: ProjectionContext,
  policy: Policy,
  input: MCSummaryInput,
  hooks: MCHooks = {},
): { summary: MCDistribution; cancelled: boolean } {
  const outcomes: PathOutcome[] = [];
  const L = correlationCholesky(drawConfigFrom(ctx, input.seed, 0));
  let cancelled = false;

  for (let i = 0; i < input.paths; i++) {
    if (hooks.shouldCancel?.()) {
      cancelled = true;
      break;
    }
    const cfg = drawConfigFrom(ctx, input.seed, i);
    const draws = generatePathDraws(cfg, L);
    const state = drawsToState(draws, cfg, ctx.assumptions.spendingInflation, ctx.assumptions.healthcareInflation);
    const result = runPolicy(ctx, policy, state);
    const success =
      !result.firstShortfallYear &&
      !result.firstCoverageFailureYear &&
      (!input.requireNoReserveBreach || !result.firstReserveBreachYear);
    const firstFailure =
      result.firstShortfallYear !== null && result.firstCoverageFailureYear !== null
        ? Math.min(result.firstShortfallYear, result.firstCoverageFailureYear)
        : (result.firstShortfallYear ?? result.firstCoverageFailureYear);
    outcomes.push({
      success,
      reserveBreach: result.firstReserveBreachYear !== null,
      firstFailureYear: firstFailure,
      firstShortfallYear: result.firstShortfallYear,
      firstCoverageFailureYear: result.firstCoverageFailureYear,
      firstReserveBreachYear: result.firstReserveBreachYear,
      firstLiquidDepletionYear: result.firstLiquidDepletionYear,
      firstTotalDepletionYear: result.firstTotalDepletionYear,
      terminalWealth: result.terminalWealth,
      rankedWealth: result.rankedWealth,
      lifetimeTax: result.lifetimeTaxNominal,
      extraSpending: result.totalExtraSpending,
      minOUEquity: result.minOUEquity,
    });
    if (hooks.onProgress && (i % 25 === 0 || i === input.paths - 1)) {
      hooks.onProgress((i + 1) / input.paths, i + 1);
    }
  }

  const summary = summarise(outcomes, input);

  // certified mode: pass/fail thresholds are derived later from summary;
  // expose nothing extra here — the optimiser applies the rule.
  return { summary, cancelled };
}

/**
 * Run exactly one seeded path (full correlation structure) — used by the
 * audit view to reproduce a Monte Carlo path for inspection.
 */
export function runPathWithSeed(
  ctx: ProjectionContext,
  policy: Policy,
  seed: number,
  pathIndex: number,
): ReturnType<typeof runPolicy> {
  const cfg = drawConfigFrom(ctx, seed, pathIndex);
  const L = correlationCholesky(cfg);
  const draws = generatePathDraws(cfg, L);
  const state = drawsToState(
    draws,
    cfg,
    ctx.assumptions.spendingInflation,
    ctx.assumptions.healthcareInflation,
  );
  return runPolicy(ctx, policy, state);
}

/** Certified pass rule: lower Wilson bound >= target (§11.5). */export function passesTarget(dist: MCDistribution, target: number, certified: boolean): boolean {
  if (certified) {
    const minS = minSuccessesForCertified(dist.n, target);
    return dist.successes >= minS;
  }
  return dist.successProbability >= target - 1e-12;
}

/** Deterministic reference path as an MCDistribution-like single-point view (diagnostic only). */
export function centralPathDiagnostic(
  ctx: ProjectionContext,
  policy: Policy,
): { terminalWealth: number; feasible: boolean } {
  const h = computeHorizon(ctx);
  const state = buildDeterministicPath('central', ctx.assumptions, h.startYear);
  const r = runPolicy(ctx, policy, state);
  return { terminalWealth: r.terminalWealth, feasible: r.feasible };
}
