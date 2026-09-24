/**
 * Monte Carlo & diagnostics runner abstractions: the optimiser delegates
 * heavy per-candidate work to pluggable runners so the same staged search
 * executes serially (tests, fallback) or across a Web Worker pool (§16.3).
 *
 * Runners are async so the coordinator (main thread) stays responsive while
 * workers perform the simulations. Results are identical either way because
 * common random numbers depend only on (seed, pathIndex).
 */

import type { CandidateResult, MCDistribution, Policy } from '../types';
import type { ProjectionContext } from './projection';
import { computeHorizon, runPolicy } from './projection';
import { buildDeterministicPath } from './returns';
import { runMonteCarlo, type MCSummaryInput } from './montecarlo';

export interface BatchResult {
  /** Summaries aligned with the input policy order; null when cancelled. */
  summaries: (MCDistribution | null)[];
  cancelled: boolean;
}

export interface BatchHooks {
  onProgress?: (done: number, total: number) => void;
  shouldCancel?: () => boolean;
}

export type BatchRunner = (
  policies: Policy[],
  input: MCSummaryInput,
  hooks?: BatchHooks,
) => Promise<BatchResult>;

export interface DiagResult {
  diagnostics: (CandidateResult['diagnostics'] | null)[];
  /** Structural error message per policy (null when the run succeeded). */
  errors: (string | null)[];
  cancelled: boolean;
}

export type DiagRunner = (
  policies: Policy[],
  hooks?: BatchHooks,
) => Promise<DiagResult>;

/**
 * Stage-1 deterministic diagnostics (central-return, first-year crash, lost
 * decade, high inflation). Return-dependent results are DIAGNOSTICS ONLY and
 * never a pruning criterion (D-20).
 */
export function deterministicDiagnostics(
  ctx: ProjectionContext,
  policy: Policy,
): CandidateResult['diagnostics'] {
  const h = computeHorizon(ctx);
  const out: NonNullable<CandidateResult['diagnostics']> = {
    central: { terminalWealth: 0, feasible: false },
    firstYearCrash: { terminalWealth: 0, feasible: false },
    lostDecade: { terminalWealth: 0, feasible: false },
    highInflation: null,
  };
  for (const kind of ['central', 'firstYearCrash', 'lostDecade', 'highInflation'] as const) {
    const state = buildDeterministicPath(kind, ctx.assumptions, h.startYear);
    const r = runPolicy(ctx, policy, state);
    const entry = {
      terminalWealth: Math.round(r.terminalWealth * 100) / 100,
      feasible: r.feasible,
    };
    if (kind === 'central') out.central = entry;
    else if (kind === 'firstYearCrash') out.firstYearCrash = entry;
    else if (kind === 'lostDecade') out.lostDecade = entry;
    else out.highInflation = entry;
  }
  return out;
}

/** Default serial runner — identical results to any pool (CRN by construction). */
export function serialRunner(ctx: ProjectionContext): BatchRunner {
  return async (policies, input, hooks) => {
    const summaries: (MCDistribution | null)[] = [];
    let cancelled = false;
    for (let i = 0; i < policies.length; i++) {
      if (hooks?.shouldCancel?.()) {
        cancelled = true;
        break;
      }
      const { summary, cancelled: cc } = runMonteCarlo(ctx, policies[i], input, {
        shouldCancel: hooks?.shouldCancel,
      });
      if (cc) {
        cancelled = true;
        summaries.push(null);
        break;
      }
      summaries.push(summary);
      hooks?.onProgress?.(i + 1, policies.length);
    }
    while (summaries.length < policies.length) summaries.push(null);
    return { summaries, cancelled };
  };
}

/** Default serial diagnostics runner. */
export function serialDiagRunner(ctx: ProjectionContext): DiagRunner {
  return async (policies, hooks) => {
    const diagnostics: (CandidateResult['diagnostics'] | null)[] = [];
    const errors: (string | null)[] = [];
    let cancelled = false;
    for (let i = 0; i < policies.length; i++) {
      if (hooks?.shouldCancel?.()) {
        cancelled = true;
        diagnostics.push(null);
        errors.push(null);
        continue;
      }
      try {
        diagnostics.push(deterministicDiagnostics(ctx, policies[i]));
        errors.push(null);
      } catch (e) {
        diagnostics.push(null);
        errors.push(e instanceof Error ? e.message : String(e));
      }
      hooks?.onProgress?.(i + 1, policies.length);
    }
    return { diagnostics, errors, cancelled };
  };
}
