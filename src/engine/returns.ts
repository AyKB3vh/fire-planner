/**
 * Return model, deterministic stress paths and random-number plumbing (§11).
 *
 * - Annual investment returns are lognormal: R = exp(μ + σZ), μ = ln(1+g),
 *   so 1+g is the MEDIAN annual growth factor.
 * - The central-return path sets every stochastic annual return to its
 *   median (1+g). It is a deterministic diagnostic only (D-31) — never a
 *   probabilistic pruning criterion and never labelled "median simulation".
 * - Randomness is injected: this module creates it; financial rules never do.
 */

import type { Assumptions } from '../types';

export type DeterministicPathKind =
  | 'central'
  | 'firstYearCrash'
  | 'lostDecade'
  | 'highInflation';

/**
 * Per-path return/inflation source consumed by `runPolicy`.
 * Functions take ABSOLUTE calendar years; for years before the withdrawal
 * start they return the configured deterministic values.
 */
export interface StochasticState {
  /** Simple (gross) return for OÜ investments in the withdrawal year `year`. */
  ouReturn(year: number): number;
  iiReturn(year: number): number;
  iiiReturn(year: number): number;
  /** Effective spending inflation rate applied to grow the spending target. */
  spendingInflation(year: number): number;
  /** Effective healthcare inflation rate applied to the voluntary premium. */
  healthcareInflation(year: number): number;
}

export interface PathSpec {
  state: StochasticState;
}

/** Apply the optional explicit return floor (simple return). */
function withFloor(r: number, floor: number | null): number {
  if (floor === null) return r;
  return r < floor ? floor : r;
}

/**
 * Deterministic diagnostic paths (§10.4 Stage 1 and §11.7 stress tests).
 * All are reproducible and independent of any randomness.
 */
export function buildDeterministicPath(
  kind: DeterministicPathKind,
  assumptions: Assumptions,
  startYear: number,
): StochasticState {
  const rm = assumptions.returns;
  const gOu = rm.ou.geometricReturn;
  const gIi = rm.ii.geometricReturn;
  const gIii = rm.iii.geometricReturn;
  const spendBase = kind === 'highInflation' ? assumptions.spendingInflation + 0.01 : assumptions.spendingInflation;
  const healthBase = kind === 'highInflation' ? assumptions.healthcareInflation + 0.01 : assumptions.healthcareInflation;
  const crashYear = startYear;

  function assetReturn(g: number, year: number): number {
    let r: number;
    if (kind === 'firstYearCrash' && year === crashYear) {
      r = -0.35;
    } else if (kind === 'lostDecade' && year >= crashYear && year < crashYear + 10) {
      r = g - 0.04; // 4 percentage points lower for the first 10 withdrawal years
    } else {
      r = g;
    }
    return withFloor(r, rm.returnFloor);
  }

  return {
    ouReturn: (y) => assetReturn(gOu, y),
    iiReturn: (y) => assetReturn(gIi, y),
    iiiReturn: (y) => assetReturn(gIii, y),
    spendingInflation: () => spendBase,
    healthcareInflation: () => healthBase,
  };
}

/* ------------------------------------------------------------------ */
/* Return converter (§11.2): arithmetic mean & simple stdev -> model     */
/* ------------------------------------------------------------------ */

export interface ReturnConversion {
  sigma: number;
  mu: number;
  g: number;
}

export function convertArithmeticToLognormal(a: number, s: number): ReturnConversion {
  const sigma = Math.sqrt(Math.log(1 + (s / (1 + a)) ** 2));
  const mu = Math.log(1 + a) - sigma ** 2 / 2;
  const g = Math.exp(mu) - 1;
  return { sigma, mu, g };
}

/** Arithmetic mean annual growth factor implied by (g, σ). */
export function impliedArithmeticMean(g: number, sigma: number): number {
  return (1 + g) * Math.exp((sigma ** 2) / 2);
}

/* ------------------------------------------------------------------ */
/* Deterministic PRNG (seeded; injected into simulations)              */
/* ------------------------------------------------------------------ */

/** mulberry32 — small, fast, seeded, deterministic across engines. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit mix used to derive per-path seeds (common random numbers). */
export function mixSeed(seed: number, pathIndex: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (pathIndex + 0x85ebca6b), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

export function makeRng(seed: number, pathIndex: number): () => number {
  return mulberry32(mixSeed(seed, pathIndex));
}

/** Standard normal via Box–Muller (2 uniforms per normal). */
export function standardNormal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ */
/* Correlation                                                         */
/* ------------------------------------------------------------------ */

/** Cholesky decomposition of a symmetric positive-definite matrix. */
export function cholesky(m: number[][]): number[][] | null {
  const n = m.length;
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = m[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 1e-12) return null;
        L[i][i] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

/**
 * Default correlation structure: equicorrelation ρ among the three
 * equity-like assets (OÜ, II, III) and correlation c between inflation and
 * the common equity factor.
 */
export function defaultCorrelationMatrix(rho: number, inflationCorr: number): number[][] {
  return [
    [1, rho, rho, inflationCorr],
    [rho, 1, rho, inflationCorr],
    [rho, rho, 1, inflationCorr],
    [inflationCorr, inflationCorr, inflationCorr, 1],
  ];
}
