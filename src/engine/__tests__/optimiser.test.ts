/** Optimiser regression tests (§15.10) on a deliberately small search space. */

import { beforeAll, describe, expect, it } from 'vitest';
import { runOptimisation, fullPathCount } from '../optimiser';
import { createDefaultRegistry } from '../../rules/registry';
import type { MonteCarloSettings, OptimisationSettings, OptimisationResult } from '../../types';
import type { ProjectionContext } from '../projection';
import { ctxFor } from './fixtures';

function smallOptim(): OptimisationSettings {
  return {
    tieWealthTolerance: 0.001,
    robustTieProbability: 0.001,
    lowestTaxWealthFloor: 0.95,
    simplestWealthFloor: 0.97,
    pillarDelayMin: 0,
    pillarDelayMax: 1,
    bufferCandidates: [0, 12],
    refinementIterations: 1,
    maxStage0Candidates: null,
  };
}

function smallMC(): MonteCarloSettings {
  return {
    screen1Paths: 10,
    screen2Paths: 40,
    quickPaths: 50,
    defaultPaths: 100,
    highPrecisionPaths: 200,
    seed: 42,
    screenFailureMargin1: 3,
    screenFailureMargin2: 3,
    stage2AWealthKeep: 10,
    stage2BWealthKeep: 10,
    stage2BFailureKeep: 5,
    targetSuccessProbability: 0.95,
    certifiedMode: false,
    precision: 'default',
    requireNoReserveBreach: false,
  };
}

function run(ctx: ProjectionContext) {
  return runOptimisation(ctx, { mc: smallMC(), optim: smallOptim() });
}

describe('optimiser staging', () => {
  const ctx = ctxFor({});
  let result: OptimisationResult;
  beforeAll(async () => {
    result = await run(ctx);
  });

  it('completes without cancellation and validates the start state', () => {
    expect(result.cancelled).toBe(false);
    expect(result.validated.ok).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.stageRecords.length).toBeGreaterThan(0);
  });

  it('searches DistributionFirst by default (D-27)', () => {
    const rules = new Set(result.candidates.map((c) => c.policy.fundingRule));
    expect(rules.has('LoanFirst')).toBe(true);
    expect(rules.has('DistributionFirst')).toBe(true);
  });

  it('never removes a candidate because of a deterministic return-dependent path (D-20)', () => {
    const stage1Removals = result.stageRecords.filter((r) => r.stage === 'stage1' && !r.survived);
    for (const r of stage1Removals) {
      expect(r.reason).not.toMatch(/central|crash|lost decade|inflation|return/i);
    }
    // every structurally valid candidate survived stage 1 even if its
    // deterministic paths looked bad
    const structurallyValid = result.candidates.filter((c) => c.diagnostics !== null);
    expect(structurallyValid.length).toBeGreaterThan(0);
    for (const c of structurallyValid) {
      const rec = result.stageRecords.find(
        (r) => r.candidateId === c.candidateId && r.stage === 'stage1',
      );
      expect(rec?.survived).toBe(true);
    }
  });

  it('logs a removal reason for every candidate removed at any stage (auditable)', () => {
    const removed = result.candidates.filter((c) => c.removedAtStage !== null);
    for (const c of removed) {
      expect(c.removalReason).toBeTruthy();
      const rec = result.stageRecords.find(
        (r) => r.candidateId === c.candidateId && r.stage === c.removedAtStage && !r.survived,
      );
      expect(rec).toBeDefined();
    }
  });

  it('runs the full simulation only on screen survivors (stage 3 records exist)', () => {
    const full = result.candidates.filter((c) => c.full !== undefined);
    expect(full.length).toBeGreaterThan(0);
    expect(full.length).toBeLessThanOrEqual(result.candidates.length);
    for (const c of full) {
      expect(c.full!.n).toBe(fullPathCount(smallMC()));
    }
  });

  it('if any policy passes, variant floors and criteria hold (§10.6)', () => {
    if (result.noPass) {
      expect(result.variants.recommended.candidateId).toBeNull();
      expect(result.variants.recommended.reason).toMatch(/No searched strategy/i);
      expect(result.bestObservedSuccess).toBeGreaterThan(0);
      return;
    }
    const rec = result.variants.recommended;
    expect(rec.candidateId).not.toBeNull();
    expect(rec.rankedWealth).not.toBeNull();
    const recWealth = rec.rankedWealth!;

    const low = result.variants.lowestTax;
    if (low.rankedWealth !== null) {
      expect(low.rankedWealth).toBeGreaterThanOrEqual(recWealth * 0.95 - 1e-6);
    }
    const simple = result.variants.simplest;
    if (simple.rankedWealth !== null) {
      expect(simple.rankedWealth).toBeGreaterThanOrEqual(recWealth * 0.97 - 1e-6);
    }
    const robust = result.variants.mostRobust;
    if (robust.successProbability !== null) {
      expect(robust.successProbability).toBeGreaterThanOrEqual(
        (rec.successProbability ?? 0) - 1e-9,
      );
    }
    // recommended must pass the target
    const recCand = result.candidates.find((c) => c.candidateId === rec.candidateId);
    expect(recCand?.passes).toBe(true);
  });

  it('deterministic: identical inputs give identical results (cacheable by hash)', async () => {
    const again = await run(ctxFor({}));
    expect(again.inputHash).toBe(result.inputHash);
    expect(result.inputHash.length).toBeGreaterThanOrEqual(12);
    expect(again.noPass).toBe(result.noPass);
    expect(again.bestObservedSuccess).toBe(result.bestObservedSuccess);
    expect(again.variants.recommended.candidateId).toBe(result.variants.recommended.candidateId);
    expect(again.candidates.map((c) => c.candidateId)).toEqual(
      result.candidates.map((c) => c.candidateId),
    );
  });

  it('is cancellable', async () => {
    let n = 0;
    const cancelled = await runOptimisation(ctxFor({}), {
      mc: smallMC(),
      optim: smallOptim(),
      shouldCancel: () => ++n > 3,
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.noPass).toBe(true);
  });

  it('stress tests are reported for the strongest policy and are diagnostics only', () => {
    const ids = result.stressTests.map((s) => s.id);
    expect(ids).toContain('firstYearCrash');
    expect(ids).toContain('returnsMinus1pp');
    expect(ids).toContain('inflationPlus1pp');
    expect(ids).toContain('distributionTax2476');
    expect(ids).toContain('statePensionOff');
    expect(ids).toContain('pillarAccessDelayed2y');
    for (const s of result.stressTests) {
      expect(typeof s.terminalWealth).toBe('number');
    }
  });
});

describe('no-pass outcome (§10.7)', () => {
  it('returns a no-pass diagnosis when nothing can succeed, without a recommendation', async () => {
    const ctx = ctxFor({
      adults: [
        {
          id: 'a',
          name: 'a',
          birthYear: 1940,
          statePensionEnabled: false,
          healthcareRequired: false,
          remunerationType: 'employment',
          workRoleRecorded: true,
          voluntaryHealthcare: false,
          allowNoInsurance: true,
        },
      ],
      startYear: 2030,
      personalCash: 0,
      ouCash: 0,
      ouInvestments: 0,
      shareholderLoan: 0,
      iiPillar: 0,
      iiiPillar: 0,
      minimumCashReserve: 0,
      spending: 60_000,
      mutateAssumptions: (a) => {
        a.returns.ou.geometricReturn = -0.5; // ruinous returns
        a.returns.ii.geometricReturn = -0.5;
        a.returns.iii.geometricReturn = -0.5;
      },
    });
    ctx.registry = createDefaultRegistry();
    const result = await run(ctx);
    expect(result.noPass).toBe(true);
    expect(result.variants.recommended.candidateId).toBeNull();
    expect(result.variants.recommended.reason).toMatch(/No searched strategy/i);
    expect(result.bestObservedSuccess).toBeLessThan(0.95);
    // closest candidates still shown neutrally
    expect(result.variants.mostRobust.candidateId).not.toBeNull();
    expect(result.variants.mostRobust.reason).toMatch(/closest observed|Maximises/i);
  });

  it('stops the run on an inconsistent starting state instead of repairing it', async () => {
    const ctx = ctxFor({ personalCash: -500 });
    const result = await run(ctx);
    expect(result.validated.ok).toBe(false);
    expect(result.candidates).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('inconsistent'))).toBe(true);
  });
});

describe('monotonicity: strictly larger starting assets cannot make a fixed policy infeasible', () => {
  it('holds on the central path for a fixed policy', async () => {
    const { runPolicy, computeHorizon } = await import('../projection');
    const { buildDeterministicPath } = await import('../returns');
    const { buildPolicy } = await import('../policy');

    const mk = (ouInv: number) => {
      const ctx = ctxFor({
        adults: [
          {
            id: 'a',
            name: 'a',
            birthYear: 1940,
            statePensionEnabled: false,
            healthcareRequired: false,
            remunerationType: 'employment',
            workRoleRecorded: true,
            voluntaryHealthcare: false,
            allowNoInsurance: true,
          },
        ],
        startYear: 2030,
        personalCash: 0,
        ouCash: 0,
        ouInvestments: ouInv,
        shareholderLoan: 0,
        minimumCashReserve: 0,
        spending: 30_000,
        mutateAssumptions: (a) => {
          a.spendingInflation = 0.0;
          a.returns.ou.geometricReturn = 0.03;
        },
      });
      const p = buildPolicy(ctx, {
        iiStartDelay: 0,
        iiiStartDelay: 0,
        bufferMonths: 0,
        fundingRule: 'LoanFirst',
        remuneration: { a: [0] },
      });
      const state = buildDeterministicPath('central', ctx.assumptions, computeHorizon(ctx).startYear);
      return { ctx, p, state };
    };

    const small = mk(50_000);
    const large = mk(2_000_000);
    const rSmall = runPolicy(small.ctx, small.p, small.state);
    const rLarge = runPolicy(large.ctx, large.p, large.state);
    // small may fail; large must never fail if small succeeds
    if (rSmall.feasible) expect(rLarge.feasible).toBe(true);
    expect(rLarge.feasible).toBe(true);
    expect(rLarge.terminalWealth).toBeGreaterThan(rSmall.terminalWealth);
  });
});
