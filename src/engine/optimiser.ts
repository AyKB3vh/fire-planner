/**
 * Optimiser (Layer 7, §10) — robustness-aware staged search over ONE fixed
 * withdrawal start date. There is no date optimisation (D-01/D-33).
 *
 * Decision hierarchy:
 *  1. Hard feasibility / structural validity.
 *  2. Pass: modelled success probability p̂ ≥ target (or certified Wilson rule).
 *  3. Among passing: maximise median ranked terminal wealth.
 *  4. Near-tie (within 0.1%): prefer lower PV lifetime tax.
 *
 * Central-return deterministic results are diagnostics only and never prune
 * a candidate probabilistically (D-20/D-31).
 */

import type {
  CandidateResult,
  MonteCarloSettings,
  MCDistribution,
  OptimisationResult,
  OptimisationSettings,
  Policy,
  StageCandidateRecord,
  StageId,
  StressTestResult,
  StrategyVariant,
} from '../types';
import type { ProjectionContext } from './projection';
import { computeHorizon, runPolicy, validatePolicyStructure } from './projection';
import { buildDeterministicPath } from './returns';
import { passesTarget, runPathWithSeed, type MCSummaryInput } from './montecarlo';
import {
  serialDiagRunner,
  serialRunner,
  type BatchRunner,
  type DiagRunner,
} from './mcrunner';
import {
  buildPolicy,
  generateStage0Policies,
  neighbourPolicies,
  policyComplexity,
  policySubstanceWarnings,
  yearlyRemuneration,
} from './policy';
import { validateStartingState } from './validate';
import { hashObject } from './hash';
import { unverifiedRuleIds } from '../rules/registry';
import { round2 } from './money';

export interface OptimiserProgress {
  stage: StageId;
  fraction: number;
  label: string;
}

export interface OptimiserRunOptions {
  mc: MonteCarloSettings;
  optim: OptimisationSettings;
  onProgress?: (p: OptimiserProgress) => void;
  shouldCancel?: () => boolean;
  /** Batch MC runner; defaults to serial. Worker pools plug in here (§16.3). */
  runner?: BatchRunner;
  /** Batch diagnostics runner (stage 1); defaults to serial. */
  diagRunner?: DiagRunner;
}


function emptyResult(
  hash: string,
  target: number,
  certified: boolean,
  seed: number,
  ctx: ProjectionContext,
  durationMs: number,
): OptimisationResult {
  const h = computeHorizon(ctx);
  return {
    inputHash: hash,
    createdAt: new Date().toISOString(), // reporting metadata only; not used in calculations
    target,
    certified,
    seed,
    pathsUsed: 0,
    horizon: { startYear: h.startYear, endYear: h.endYear },
    validated: { ok: false, issues: [] },
    stageRecords: [],
    candidates: [],
    variants: {
      recommended: variantNull('recommended', 'Run stopped before candidates were evaluated.'),
      lowestTax: variantNull('lowestTax', 'Run stopped before candidates were evaluated.'),
      mostRobust: variantNull('mostRobust', 'Run stopped before candidates were evaluated.'),
      simplest: variantNull('simplest', 'Run stopped before candidates were evaluated.'),
    },
    noPass: true,
    bestObservedSuccess: 0,
    dominantFailure: null,
    stressTests: [],
    warnings: [],
    durationMs,
    cancelled: true,
  };
}

function variantNull(variant: StrategyVariant['variant'], reason: string): StrategyVariant {
  return {
    variant,
    candidateId: null,
    policy: null,
    reason,
    rankedWealth: null,
    successProbability: null,
    pvLifetimeTax: null,
  };
}

/** Number of full paths for the configured precision mode. */
export function fullPathCount(mc: MonteCarloSettings): number {
  if (mc.precision === 'quick') return mc.quickPaths;
  if (mc.precision === 'high') return mc.highPrecisionPaths;
  return mc.defaultPaths;
}

function mcInput(mc: MonteCarloSettings, paths: number): MCSummaryInput {
  return {
    seed: mc.seed,
    paths,
    target: mc.targetSuccessProbability,
    certifiedMode: mc.certifiedMode,
    requireNoReserveBreach: mc.requireNoReserveBreach,
  };
}

/**
 * Input hash for caching (§16): identical (inputs, rules, MC & optimisation
 * settings) ⇒ identical result.
 */
export function optimisationInputHash(
  ctx: ProjectionContext,
  mc: MonteCarloSettings,
  optim: OptimisationSettings,
): string {
  return hashObject({
    startState: ctx.startState,
    household: ctx.household,
    assumptions: ctx.assumptions,
    engineSettings: ctx.engineSettings,
    pillarOverrides: ctx.pillarOverrides,
    registry: ctx.registry,
    actuals: ctx.actuals,
    ruleOverrides: ctx.ruleOverrides ?? null,
    baseYear: ctx.baseYear,
    mc,
    optim,
  });
}

/**
 * Full optimisation run. Deterministic, cacheable by input hash,
 * cancellable, progress-reporting.
 */
export async function runOptimisation(
  ctx: ProjectionContext,
  opts: OptimiserRunOptions,
): Promise<OptimisationResult> {
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  const elapsed = (): number =>
    typeof performance !== 'undefined' ? performance.now() - started : 0;
  const { mc, optim } = opts;
  const target = mc.targetSuccessProbability;
  const certified = mc.certifiedMode;
  const cancelled = (): boolean => opts.shouldCancel?.() ?? false;
  const progress = (stage: StageId, fraction: number, label: string): void => {
    opts.onProgress?.({ stage, fraction, label });
  };
  const runner: BatchRunner = opts.runner ?? serialRunner(ctx);
  const diagRunner: DiagRunner = opts.diagRunner ?? serialDiagRunner(ctx);
  const runBatch = async (
    policies: Policy[],
    paths: number,
    stage: StageId,
    label: string,
  ): Promise<{ summaries: (MCDistribution | null)[]; cancelled: boolean }> => {
    if (policies.length === 0) return { summaries: [], cancelled: false };
    return runner(policies, mcInput(mc, paths), {
      onProgress: (done, total) => progress(stage, done / total, label),
      shouldCancel: cancelled,
    });
  };

  const inputHash = optimisationInputHash(ctx, mc, optim);

  const warnings: string[] = [];
  for (const u of unverifiedRuleIds(ctx.registry)) {
    warnings.push(`Rule "${u.label}" (${u.id}) is flagged ${u.status} — results depending on it are provisional.`);
  }
  warnings.push(...policySubstanceWarnings(ctx));

  /* ---------------------------------------------------------------- */
  /* Starting-state validation: stop the run on inconsistency (§5.2)   */
  /* ---------------------------------------------------------------- */
  const validated = validateStartingState(ctx);
  if (!validated.ok) {
    const r = emptyResult(inputHash, target, certified, mc.seed, ctx, elapsed());
    r.validated = validated;
    r.warnings = [
      ...warnings,
      'Starting state is internally inconsistent — the optimiser will not repair it. Fix the inputs and re-run.',
    ];
    r.cancelled = false;
    r.noPass = true;
    return r;
  }

  const stageRecords: StageCandidateRecord[] = [];
  const candidates = new Map<string, CandidateResult>();
  const fullCache = new Map<string, MCDistribution>();

  /* ---------------------------------------------------------------- */
  /* Stage 0 — candidate generation                                    */
  /* ---------------------------------------------------------------- */
  progress('stage0', 0, 'Generating candidates from rule-derived kinks');
  const { policies: stage0, kinks } = generateStage0Policies(
    ctx,
    optim,
    ctx.engineSettings.includeDistributionFirst,
  );
  for (const p of stage0) {
    candidates.set(p.id, {
      candidateId: p.id,
      policy: p,
      diagnostics: null,
      passes: false,
      removedAtStage: null,
      removalReason: null,
    });
  }
  progress('stage0', 1, `${stage0.length} candidates`);

  /* ---------------------------------------------------------------- */
  /* Stage 1 — structural validation + deterministic diagnostics       */
  /* ---------------------------------------------------------------- */
  const structValid: CandidateResult[] = [];
  for (const c of candidates.values()) {
    if (cancelled()) return cancelledResult();
    const structReason = validatePolicyStructure(ctx, c.policy);
    if (structReason) {
      c.removedAtStage = 'stage1';
      c.removalReason = structReason;
      stageRecords.push({
        candidateId: c.candidateId,
        stage: 'stage1',
        survived: false,
        reason: structReason,
      });
    } else {
      structValid.push(c);
    }
  }
  // Deterministic diagnostics for reporting only — never a pruning criterion (D-20).
  const diagRes = await diagRunner(
    structValid.map((c) => c.policy),
    {
      onProgress: (done, total) => progress('stage1', done / total, 'Deterministic diagnostics'),
      shouldCancel: cancelled,
    },
  );
  if (diagRes.cancelled) return cancelledResult();
  const survivors1: CandidateResult[] = [];
  structValid.forEach((c, idx) => {
    const err = diagRes.errors[idx];
    if (err !== null && err !== undefined) {
      c.removedAtStage = 'stage1';
      c.removalReason = err;
      stageRecords.push({
        candidateId: c.candidateId,
        stage: 'stage1',
        survived: false,
        reason: err,
      });
      return;
    }
    c.diagnostics = diagRes.diagnostics[idx];
    c.removedAtStage = null;
    stageRecords.push({
      candidateId: c.candidateId,
      stage: 'stage1',
      survived: true,
      reason: 'structurally valid (deterministic paths are diagnostics only)',
      rankedWealth: c.diagnostics?.central.terminalWealth,
    });
    survivors1.push(c);
  });
  progress('stage1', 1, `${survivors1.length} structurally valid`);

  function cancelledResult(): OptimisationResult {
    const r = emptyResult(inputHash, target, certified, mc.seed, ctx, elapsed());
    r.validated = validated;
    r.stageRecords = stageRecords;
    r.candidates = [...candidates.values()];
    r.warnings = warnings;
    r.noPass = true;
    r.cancelled = true;
    return r;
  }

  /* ---------------------------------------------------------------- */
  /* Stage 2A — 100-path Monte Carlo screen (common random numbers)    */
  /* ---------------------------------------------------------------- */
  const screen1Paths = mc.screen1Paths;
  if (cancelled()) return cancelledResult();
  const s1res = await runBatch(
    survivors1.map((c) => c.policy),
    screen1Paths,
    'stage2a',
    `Screen 1 (${screen1Paths} paths)`,
  );
  if (s1res.cancelled) return cancelledResult();
  const alive: CandidateResult[] = [];
  survivors1.forEach((c, idx) => {
    const summary = s1res.summaries[idx];
    if (!summary) return;
    c.screen1 = summary;
    alive.push(c);
  });
  // keep union: within margin of min failures + top by ranked wealth
  const fails1 = alive.map((c) => screen1Paths - (c.screen1?.successes ?? 0));
  const minFail1 = fails1.length ? Math.min(...fails1) : 0;
  const keep1 = new Set<string>();
  alive.forEach((c, idx) => {
    if (fails1[idx] <= minFail1 + mc.screenFailureMargin1) keep1.add(c.candidateId);
  });
  [...alive]
    .sort((a, b) => (b.screen1?.rankedWealthMedian ?? 0) - (a.screen1?.rankedWealthMedian ?? 0))
    .slice(0, mc.stage2AWealthKeep)
    .forEach((c) => keep1.add(c.candidateId));
  for (const c of alive) {
    const survived = keep1.has(c.candidateId);
    if (!survived) {
      c.removedAtStage = 'stage2a';
      c.removalReason = `screen 1: ${screen1Paths - (c.screen1?.successes ?? 0)} failures > min ${minFail1} + margin ${mc.screenFailureMargin1}, and outside top-${mc.stage2AWealthKeep} by ranked wealth`;
    }
    stageRecords.push({
      candidateId: c.candidateId,
      stage: 'stage2a',
      survived,
      reason: survived ? 'within failure margin or top-wealth keep' : c.removalReason ?? 'removed',
      failures: screen1Paths - (c.screen1?.successes ?? 0),
      rankedWealth: c.screen1?.rankedWealthMedian,
    });
  }
  const survivors2a = alive.filter((c) => keep1.has(c.candidateId));
  progress('stage2a', 1, `${survivors2a.length} survived screen 1`);

  /* ---------------------------------------------------------------- */
  /* Stage 2B — 400-path screen                                        */
  /* ---------------------------------------------------------------- */
  const screen2Paths = mc.screen2Paths;
  if (cancelled()) return cancelledResult();
  const s2res = await runBatch(
    survivors2a.map((c) => c.policy),
    screen2Paths,
    'stage2b',
    `Screen 2 (${screen2Paths} paths)`,
  );
  if (s2res.cancelled) return cancelledResult();
  const alive2: CandidateResult[] = [];
  survivors2a.forEach((c, idx) => {
    const summary = s2res.summaries[idx];
    if (!summary) return;
    c.screen2 = summary;
    alive2.push(c);
  });
  const fails2 = alive2.map((c) => screen2Paths - (c.screen2?.successes ?? 0));
  const minFail2 = fails2.length ? Math.min(...fails2) : 0;
  const keep2 = new Set<string>();
  alive2.forEach((c, idx) => {
    if (fails2[idx] <= minFail2 + mc.screenFailureMargin2) keep2.add(c.candidateId);
  });
  [...alive2]
    .sort((a, b) => (b.screen2?.rankedWealthMedian ?? 0) - (a.screen2?.rankedWealthMedian ?? 0))
    .slice(0, mc.stage2BWealthKeep)
    .forEach((c) => keep2.add(c.candidateId));
  [...alive2]
    .sort((a, b) => (screen2Paths - (a.screen2?.successes ?? 0)) - (screen2Paths - (b.screen2?.successes ?? 0)))
    .slice(0, mc.stage2BFailureKeep)
    .forEach((c) => keep2.add(c.candidateId));
  for (const c of alive2) {
    const survived = keep2.has(c.candidateId);
    if (!survived) {
      c.removedAtStage = 'stage2b';
      c.removalReason = `screen 2: ${screen2Paths - (c.screen2?.successes ?? 0)} failures > min ${minFail2} + margin ${mc.screenFailureMargin2}, outside top-${mc.stage2BWealthKeep} by wealth and top-${mc.stage2BFailureKeep} by failures`;
      stageRecords.push({
        candidateId: c.candidateId,
        stage: 'stage2b',
        survived: false,
        reason: c.removalReason,
        failures: screen2Paths - (c.screen2?.successes ?? 0),
        rankedWealth: c.screen2?.rankedWealthMedian,
      });
    } else {
      stageRecords.push({
        candidateId: c.candidateId,
        stage: 'stage2b',
        survived: true,
        reason: 'within failure margin, top-wealth keep, or fewest-failures keep',
        failures: screen2Paths - (c.screen2?.successes ?? 0),
        rankedWealth: c.screen2?.rankedWealthMedian,
      });
    }
  }
  const survivors2b = alive2.filter((c) => keep2.has(c.candidateId));
  progress('stage2b', 1, `${survivors2b.length} survived screen 2`);

  /* ---------------------------------------------------------------- */
  /* Stage 3 — full Monte Carlo                                        */
  /* ---------------------------------------------------------------- */
  const fullPaths = fullPathCount(mc);
  let runFullCancelled = false;
  const recordFull = (c: CandidateResult): void => {
    c.passes = passesTarget(c.full!, target, certified);
    stageRecords.push({
      candidateId: c.candidateId,
      stage: 'stage3',
      survived: c.passes,
      reason: c.passes
        ? `p̂ = ${(c.full!.successProbability * 100).toFixed(2)}% ≥ target ${(target * 100).toFixed(0)}%`
        : `p̂ = ${(c.full!.successProbability * 100).toFixed(2)}% < target ${(target * 100).toFixed(0)}%`,
      failures: fullPaths - c.full!.successes,
      successProbability: c.full!.successProbability,
      rankedWealth: c.full!.rankedWealthMedian,
    });
  };
  const runFull = async (list: CandidateResult[]): Promise<void> => {
    const need: CandidateResult[] = [];
    for (const c of list) {
      const cached = fullCache.get(c.candidateId);
      if (cached) {
        c.full = cached;
        recordFull(c);
      } else {
        need.push(c);
      }
    }
    if (need.length === 0) return;
    const res = await runBatch(
      need.map((c) => c.policy),
      fullPaths,
      'stage3',
      `Full simulation (${fullPaths} paths)`,
    );
    if (res.cancelled) {
      runFullCancelled = true;
      return;
    }
    need.forEach((c, idx) => {
      const summary = res.summaries[idx];
      if (!summary) return;
      c.full = summary;
      fullCache.set(c.candidateId, summary);
      recordFull(c);
    });
  };
  await runFull(survivors2b);
  if (runFullCancelled || cancelled()) return cancelledResult();
  progress('stage3', 1, 'Full simulation complete');

  /* ---------------------------------------------------------------- */
  /* Stage 4 — local refinement (coordinate moves)                     */
  /* ---------------------------------------------------------------- */
  const fullResults = (): CandidateResult[] =>
    [...candidates.values()].filter((c) => c.full !== undefined);
  const bestRanked = (list: CandidateResult[]): number =>
    list.length ? Math.max(...list.map((c) => c.full?.rankedWealthMedian ?? 0)) : 0;

  let iteration = 0;
  let convergenceCounter = 0;
  while (iteration < optim.refinementIterations && convergenceCounter < 2) {
    iteration++;
    const withFull = fullResults();
    const passing = withFull.filter((c) => c.passes);
    const nearPass = withFull
      .filter((c) => !c.passes)
      .sort((a, b) => (b.full?.successProbability ?? 0) - (a.full?.successProbability ?? 0))
      .slice(0, 3);
    const elite = [
      ...passing
        .sort((a, b) => (b.full?.rankedWealthMedian ?? 0) - (a.full?.rankedWealthMedian ?? 0))
        .slice(0, 4),
      ...nearPass,
    ];
    if (elite.length === 0) break;

    const beforeBest = bestRanked(fullResults());
    const neighbours: CandidateResult[] = [];
    const seenIds = new Set(candidates.keys());
    for (const e of elite) {
      for (const nb of neighbourPolicies(ctx, e.policy, kinks, optim)) {
        if (seenIds.has(nb.id)) continue;
        seenIds.add(nb.id);
        const cand: CandidateResult = {
          candidateId: nb.id,
          policy: nb,
          diagnostics: null,
          passes: false,
          removedAtStage: null,
          removalReason: null,
        };
        candidates.set(nb.id, cand);
        neighbours.push(cand);
      }
    }
    if (neighbours.length === 0) break;

    // structural check + screens on neighbours
    const structOk = neighbours.filter((c) => {
      const reason = validatePolicyStructure(ctx, c.policy);
      if (reason) {
        c.removedAtStage = 'stage4';
        c.removalReason = reason;
        stageRecords.push({ candidateId: c.candidateId, stage: 'stage4', survived: false, reason });
      }
      return !reason;
    });
    const s1n = await runBatch(
      structOk.map((c) => c.policy),
      screen1Paths,
      'stage4',
      `Refinement screen 1 (${screen1Paths} paths)`,
    );
    if (s1n.cancelled) return cancelledResult();
    const screened: CandidateResult[] = [];
    structOk.forEach((c, idx) => {
      const summary = s1n.summaries[idx];
      if (!summary) return;
      c.screen1 = summary;
      screened.push(c);
    });
    // broad screen 1 margin again, then screen 2 for the strongest neighbours
    const s1fails = screened.map((c) => screen1Paths - (c.screen1?.successes ?? 0));
    const s1min = s1fails.length ? Math.min(...s1fails) : 0;
    const bestS1Wealth = screened.reduce(
      (m, c) => Math.max(m, c.screen1?.rankedWealthMedian ?? 0),
      0,
    );
    const afterS1 = screened.filter(
      (c, idx) =>
        s1fails[idx] <= s1min + mc.screenFailureMargin1 ||
        (c.screen1?.rankedWealthMedian ?? 0) >= bestS1Wealth * 0.999,
    );
    const s2list = afterS1
      .sort((a, b) => (b.screen1?.rankedWealthMedian ?? 0) - (a.screen1?.rankedWealthMedian ?? 0))
      .slice(0, mc.stage2BWealthKeep);
    const s2n = await runBatch(
      s2list.map((c) => c.policy),
      screen2Paths,
      'stage4',
      `Refinement screen 2 (${screen2Paths} paths)`,
    );
    if (s2n.cancelled) return cancelledResult();
    s2list.forEach((c, idx) => {
      const summary = s2n.summaries[idx];
      if (!summary) return;
      c.screen2 = summary;
      stageRecords.push({
        candidateId: c.candidateId,
        stage: 'stage4',
        survived: true,
        reason: `refinement candidate survived screens (screen2 failures: ${screen2Paths - summary.successes})`,
        failures: screen2Paths - summary.successes,
        rankedWealth: summary.rankedWealthMedian,
      });
    });
    const s2keep = s2list
      .filter((c) => {
        const f = screen2Paths - (c.screen2?.successes ?? 0);
        const minF = Math.min(...s2list.map((x) => screen2Paths - (x.screen2?.successes ?? 0)));
        return f <= minF + mc.screenFailureMargin2;
      })
      .sort((a, b) => (b.screen2?.rankedWealthMedian ?? 0) - (a.screen2?.rankedWealthMedian ?? 0))
      .slice(0, 10);
    await runFull(s2keep);
    if (runFullCancelled || cancelled()) return cancelledResult();

    const afterBest = bestRanked(fullResults());
    if (afterBest <= beforeBest + 1e-9) convergenceCounter++;
    else convergenceCounter = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Objective: variants (§10.6)                                       */
  /* ---------------------------------------------------------------- */
  const evaluated = fullResults();
  const passing = evaluated.filter((c) => c.passes);
  const noPass = passing.length === 0;

  const byRank = (a: CandidateResult, b: CandidateResult): number =>
    (b.full?.rankedWealthMedian ?? 0) - (a.full?.rankedWealthMedian ?? 0);

  let recommended: StrategyVariant;
  let lowestTax: StrategyVariant;
  let simplest: StrategyVariant;
  let mostRobust: StrategyVariant;

  const mkVariant = (
    variant: StrategyVariant['variant'],
    c: CandidateResult | undefined,
    reason: string,
  ): StrategyVariant =>
    c
      ? {
          variant,
          candidateId: c.candidateId,
          policy: c.policy,
          reason,
          rankedWealth: c.full?.rankedWealthMedian ?? null,
          successProbability: c.full?.successProbability ?? null,
          pvLifetimeTax: centralPV(ctx, c.policy),
        }
      : variantNull(variant, reason);

  if (!noPass) {
    // Recommended: highest median ranked wealth; within 0.1% tolerance prefer lower PV tax
    const best = [...passing].sort(byRank)[0];
    const bestWealth = best.full?.rankedWealthMedian ?? 0;
    const tied = passing.filter(
      (c) => (c.full?.rankedWealthMedian ?? 0) >= bestWealth * (1 - optim.tieWealthTolerance),
    );
    const pvTax = (c: CandidateResult): number => centralPV(ctx, c.policy);
    const recommendedCand = tied.length > 1 ? [...tied].sort((a, b) => pvTax(a) - pvTax(b))[0] : best;
    recommended = mkVariant(
      'recommended',
      recommendedCand,
      `Passing policy with the highest median ranked terminal wealth${
        tied.length > 1 ? '; lower PV lifetime tax used as tie-break within 0.1%' : ''
      }.`,
    );
    const recWealth = recommendedCand.full?.rankedWealthMedian ?? 0;

    const eligibleLow = passing.filter(
      (c) => (c.full?.rankedWealthMedian ?? 0) >= recWealth * optim.lowestTaxWealthFloor,
    );
    const lowCand = [...eligibleLow].sort((a, b) => pvTax(a) - pvTax(b))[0];
    lowestTax = mkVariant(
      'lowestTax',
      lowCand,
      `Lowest PV lifetime tax among passing policies with ranked wealth ≥ ${Math.round(optim.lowestTaxWealthFloor * 100)}% of the Recommended policy.`,
    );

    const eligibleSimple = passing.filter(
      (c) => (c.full?.rankedWealthMedian ?? 0) >= recWealth * optim.simplestWealthFloor,
    );
    const simpleCand = [...eligibleSimple].sort(
      (a, b) => policyComplexity(a.policy) - policyComplexity(b.policy) || byRank(a, b),
    )[0];
    simplest = mkVariant(
      'simplest',
      simpleCand,
      `Fewest policy changes over time among passing policies with ranked wealth ≥ ${Math.round(optim.simplestWealthFloor * 100)}% of the Recommended policy.`,
    );
  } else {
    recommended = variantNull('recommended', 'No searched strategy achieves the target success probability under the supplied starting state and assumptions.');
    lowestTax = variantNull('lowestTax', 'Not available — no passing policy.');
    simplest = variantNull('simplest', 'Not available — no passing policy.');
  }

  // Most robust: maximise modelled success probability; within 0.1 pp prefer wealth.
  const sortedRobust = [...evaluated].sort((a, b) => {
    const pa = a.full?.successProbability ?? 0;
    const pb = b.full?.successProbability ?? 0;
    if (pb !== pa) return pb - pa;
    return byRank(a, b);
  });
  if (sortedRobust.length > 0) {
    const top = sortedRobust[0];
    const topP = top.full?.successProbability ?? 0;
    const within = sortedRobust.filter((c) => (c.full?.successProbability ?? 0) >= topP - optim.robustTieProbability);
    const robustCand = [...within].sort(byRank)[0];
    mostRobust = mkVariant(
      'mostRobust',
      robustCand,
      noPass
        ? `Highest modelled success probability observed (${(topP * 100).toFixed(2)}%) — closest observed candidate, not a recommendation.`
        : 'Maximises modelled success probability; within 0.1 pp prefers higher ranked wealth.',
    );
  } else {
    mostRobust = variantNull('mostRobust', 'No evaluated candidates.');
  }

  /* ---------------------------------------------------------------- */
  /* No-pass diagnosis (§10.7)                                         */
  /* ---------------------------------------------------------------- */
  const bestObservedSuccess = evaluated.reduce(
    (m, c) => Math.max(m, c.full?.successProbability ?? 0),
    0,
  );
  let dominantFailure: OptimisationResult['dominantFailure'] = null;
  if (noPass && evaluated.length > 0) {
    const strongest = [...evaluated].sort(
      (a, b) => (b.full?.successProbability ?? 0) - (a.full?.successProbability ?? 0),
    )[0];
    const d = strongest.full;
    if (d) {
      const shortCount = Math.round(d.spendingShortfallProbability * d.n);
      const covCount = Math.round(d.coverageFailureProbability * d.n);
      const kind = covCount > shortCount ? 'healthcare coverage failure' : 'spending shortfall';
      const hist = d.firstFailureYearHistogram;
      let median: number | null = null;
      if (hist.length > 0) {
        const total = hist.reduce((s, b) => s + b.count, 0);
        let acc = 0;
        for (const b of hist) {
          acc += b.count;
          if (acc >= total / 2) {
            median = b.year;
            break;
          }
        }
      }
      dominantFailure = {
        kind,
        count: Math.max(shortCount, covCount),
        medianFirstYear: median,
      };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Stress tests (§11.7) — reported, not gating                       */
  /* ---------------------------------------------------------------- */
  const stressPolicies = passing.length
    ? passing
    : sortedRobust.slice(0, 1);
  const stressTests: StressTestResult[] = [];
  if (stressPolicies.length > 0) {
    const pol = stressPolicies[0].policy;
    const h = computeHorizon(ctx);
    const runStress = (
      id: string,
      label: string,
      mutate: (c: ProjectionContext, p: Policy) => { ctx: ProjectionContext; policy: Policy },
      kind: 'central' | 'firstYearCrash' | 'highInflation' | 'lostDecade',
      detail?: string,
    ): void => {
      const { ctx: c2, policy: p2 } = mutate(ctx, pol);
      const state = buildDeterministicPath(kind, c2.assumptions, h.startYear);
      const r = runPolicy(c2, p2, state);
      stressTests.push({
        id,
        label,
        terminalWealth: round2(r.terminalWealth),
        feasible: r.feasible,
        detail: detail ?? (r.feasible ? 'still fully funded on this path' : 'funding failures on this path'),
      });
    };
    runStress('firstYearCrash', 'First withdrawal year crash (−35%)', (c, p) => ({ ctx: c, policy: p }), 'firstYearCrash');
    runStress(
      'returnsMinus1pp',
      'Investment returns 1 pp lower throughout',
      (c, p) => ({
        ctx: {
          ...c,
          assumptions: {
            ...c.assumptions,
            returns: {
              ...c.assumptions.returns,
              ou: { ...c.assumptions.returns.ou, geometricReturn: c.assumptions.returns.ou.geometricReturn - 0.01 },
              ii: { ...c.assumptions.returns.ii, geometricReturn: c.assumptions.returns.ii.geometricReturn - 0.01 },
              iii: { ...c.assumptions.returns.iii, geometricReturn: c.assumptions.returns.iii.geometricReturn - 0.01 },
            },
          },
        },
        policy: p,
      }),
      'central',
    );
    runStress(
      'inflationPlus1pp',
      'Inflation 1 pp higher throughout',
      (c, p) => ({
        ctx: {
          ...c,
          assumptions: {
            ...c.assumptions,
            spendingInflation: c.assumptions.spendingInflation + 0.01,
            healthcareInflation: c.assumptions.healthcareInflation + 0.01,
            statePensionIndexation: c.assumptions.statePensionIndexation + 0.01,
          },
        },
        policy: p,
      }),
      'highInflation',
    );
    runStress(
      'distributionTax2476',
      'Distribution tax 24/76 throughout',
      (c, p) => ({ ctx: { ...c, ruleOverrides: { ...(c.ruleOverrides ?? {}), distributionTaxNum: 24, distributionTaxDen: 76 } }, policy: p }),
      'central',
      'stress variant of the 22/78 regime; "from a chosen year" applies from the withdrawal start in this run',
    );
    runStress(
      'statePensionOff',
      'State pension disabled',
      (c, p) => ({
        ctx: {
          ...c,
          household: {
            ...c.household,
            adults: c.household.adults.map((a) => ({ ...a, statePensionEnabled: false })),
          },
        },
        policy: p,
      }),
      'central',
    );
    runStress(
      'pillarAccessDelayed2y',
      'Pillar access delayed by 2 years',
      (c, p) => ({
        ctx: c,
        policy: buildPolicy(
          c,
          {
            iiStartDelay: p.iiStartDelay + 2,
            iiiStartDelay: p.iiiStartDelay + 2,
            bufferMonths: p.bufferMonths,
            fundingRule: p.fundingRule,
            remuneration: Object.fromEntries(
              c.household.adults.map((a) => [
                a.id,
                p.phaseStartYears.map((sy) => yearlyRemuneration(p, sy)[a.id] ?? 0),
              ]),
            ),
          },
          'stress',
        ),
      }),
      'central',
      'delay applied on top of the policy’s own start delays; phases rebuilt for the shifted events',
    );
  }

  const result: OptimisationResult = {
    inputHash,
    createdAt: new Date().toISOString(),
    target,
    certified,
    seed: mc.seed,
    pathsUsed: fullPaths,
    horizon: (() => {
      const h = computeHorizon(ctx);
      return { startYear: h.startYear, endYear: h.endYear };
    })(),
    validated,
    stageRecords,
    candidates: [...candidates.values()],
    variants: { recommended, lowestTax, mostRobust, simplest },
    noPass,
    bestObservedSuccess,
    dominantFailure,
    stressTests,
    warnings,
    durationMs: elapsed(),
    cancelled: false,
  };
  progress('stage4', 1, noPass ? 'No passing strategy found' : 'Optimisation complete');
  return result;
}

/** PV lifetime tax of a policy via the central-return path (tie-break metric). */
function centralPV(ctx: ProjectionContext, policy: Policy): number {
  const h = computeHorizon(ctx);
  const state = buildDeterministicPath('central', ctx.assumptions, h.startYear);
  return runPolicy(ctx, policy, state).lifetimeTaxPV;
}

/** Exported for the audit view: re-run one seeded Monte Carlo path. */
export function runSinglePath(
  ctx: ProjectionContext,
  policy: Policy,
  seed: number,
  pathIndex: number,
): ReturnType<typeof runPolicy> {
  return runPathWithSeed(ctx, policy, seed, pathIndex);
}
