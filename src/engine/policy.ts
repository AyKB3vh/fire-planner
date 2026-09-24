/**
 * Policy engine (Layer 6) — policy representation, rule-derived kink
 * candidate generation and neighbour moves for local refinement (§10.3).
 *
 * Remuneration kinks are derived mathematically from the actual rule set
 * (never a hard-coded salary ladder) and recomputed whenever rule
 * assumptions change.
 */

import type { FundingRule, Policy } from '../types';
import type { ProjectionContext } from './projection';
import { computePolicyEvents, computeHorizon } from './projection';
import { taxYearParams, zeroPitKinkMonthly } from './tax';
import { remunerationCoverageThreshold } from './healthcare';
import { hashObject } from './hash';

export interface KinkLevels {
  /** Sorted, deduplicated monthly-gross candidate levels. */
  levels: number[];
  /** Explanation of each level for the audit view. */
  labels: { level: number; reason: string }[];
}

/**
 * Derive remuneration kink candidates from the rule set (§10.3):
 *  - zero (no remuneration);
 *  - gross at which PIT reaches zero after applicable deductions;
 *  - pension-age boundary (exemption change / UI cessation);
 *  - minimum gross for remuneration-based healthcare coverage;
 *  - the configured maximum defensible remuneration.
 */
export function deriveKinkLevels(ctx: ProjectionContext): KinkLevels {
  const startYear = computeHorizon(ctx).startYear;
  const p = taxYearParams(ctx.registry, startYear, {
    generalInflation: ctx.assumptions.generalInflation,
    healthcareInflation: ctx.assumptions.healthcareInflation,
    overrides: ctx.ruleOverrides,
  });
  const labels: { level: number; reason: string }[] = [];
  const push = (level: number, reason: string): void => {
    const r = Math.round(level * 100) / 100;
    if (!labels.some((l) => Math.abs(l.level - r) < 0.005)) labels.push({ level: r, reason });
  };
  push(0, 'No remuneration');
  push(
    zeroPitKinkMonthly(p, 'employment', false),
    'PIT reaches zero after deductions (derived: exemption ÷ (1 − employee UI rate))',
  );
  push(
    zeroPitKinkMonthly(p, 'employment', true),
    'Pension-age boundary: pension-age exemption, employee UI ceases',
  );
  push(
    remunerationCoverageThreshold(ctx.registry, startYear, {
      generalInflation: ctx.assumptions.generalInflation,
      healthcareInflation: ctx.assumptions.healthcareInflation,
      baseYear: ctx.baseYear,
    }),
    'Minimum gross for remuneration-based healthcare coverage (registry rule)',
  );
  push(ctx.assumptions.maxRemunerationPerAdult, 'Configured maximum defensible remuneration');
  labels.sort((a, b) => a.level - b.level);
  return { levels: labels.map((l) => l.level), labels };
}

export interface CandidateSpec {
  iiStartDelay: number;
  iiiStartDelay: number;
  bufferMonths: number;
  fundingRule: FundingRule;
  /** Monthly gross per adult per phase. */
  remuneration: Record<string, number[]>;
}

/** Build a structurally complete policy from a spec (phases derived from events). */
export function buildPolicy(ctx: ProjectionContext, spec: CandidateSpec, idSuffix = ''): Policy {
  const base: Policy = {
    id: 'tmp',
    phaseStartYears: [computeHorizon(ctx).startYear],
    remunerationByPhase: {},
    iiStartDelay: spec.iiStartDelay,
    iiiStartDelay: spec.iiiStartDelay,
    bufferMonths: spec.bufferMonths,
    fundingRule: spec.fundingRule,
    remunerationTypes: Object.fromEntries(ctx.household.adults.map((a) => [a.id, a.remunerationType])),
  };
  const events = computePolicyEvents(ctx, base);
  const phases = events.phaseStartYears;
  const remunerationByPhase: Record<string, number[]> = {};
  for (const a of ctx.household.adults) {
    const src = spec.remuneration[a.id] ?? [0];
    remunerationByPhase[a.id] = phases.map((_, i) => src[Math.min(i, src.length - 1)]);
  }
  const policy: Policy = {
    ...base,
    phaseStartYears: phases,
    remunerationByPhase,
  };
  policy.id = policyId(policy);
  if (idSuffix) policy.id = `${policy.id}-${idSuffix}`;
  return policy;
}

/** Stable id from the economic content of a policy. */
export function policyId(policy: Policy): string {
  return hashObject({
    p: policy.phaseStartYears,
    r: policy.remunerationByPhase,
    ii: policy.iiStartDelay,
    iii: policy.iiiStartDelay,
    b: policy.bufferMonths,
    f: policy.fundingRule,
  }).slice(0, 12);
}

/**
 * Stage 0 — the discrete grid over pillar start delays, buffer sizes and
 * funding rule, crossed with rule-derived uniform remuneration levels.
 * Uniform-across-phases seeding plus Stage-4 coordinate moves avoids a
 * Cartesian explosion of per-phase remuneration values (§10.4).
 */
export function generateStage0Policies(
  ctx: ProjectionContext,
  optim: { pillarDelayMin: number; pillarDelayMax: number; bufferCandidates: number[]; maxStage0Candidates: number | null },
  includeDistributionFirst: boolean,
): { policies: Policy[]; kinks: KinkLevels } {
  const kinks = deriveKinkLevels(ctx);
  const fundingRules: FundingRule[] = includeDistributionFirst
    ? ['LoanFirst', 'DistributionFirst']
    : ['LoanFirst'];
  const policies: Policy[] = [];
  for (let ii = optim.pillarDelayMin; ii <= optim.pillarDelayMax; ii++) {
    for (let iii = optim.pillarDelayMin; iii <= optim.pillarDelayMax; iii++) {
      for (const buffer of optim.bufferCandidates) {
        for (const rule of fundingRules) {
          for (const level of kinks.levels) {
            const remuneration: Record<string, number[]> = {};
            for (const a of ctx.household.adults) remuneration[a.id] = [level];
            policies.push(
              buildPolicy(ctx, {
                iiStartDelay: ii,
                iiiStartDelay: iii,
                bufferMonths: buffer,
                fundingRule: rule,
                remuneration,
              }),
            );
            if (optim.maxStage0Candidates !== null && policies.length >= optim.maxStage0Candidates) {
              return { policies, kinks };
            }
          }
        }
      }
    }
  }
  return { policies, kinks };
}

/* ------------------------------------------------------------------ */
/* Policy helpers                                                      */
/* ------------------------------------------------------------------ */

/** Remuneration level per adult per calendar year (resolved through phases). */
export function yearlyRemuneration(policy: Policy, year: number): Record<string, number> {
  let phaseIdx = 0;
  for (let i = 0; i < policy.phaseStartYears.length; i++) {
    if (policy.phaseStartYears[i] <= year) phaseIdx = i;
  }
  const out: Record<string, number> = {};
  for (const [adultId, arr] of Object.entries(policy.remunerationByPhase)) {
    out[adultId] = arr[Math.min(phaseIdx, arr.length - 1)] ?? 0;
  }
  return out;
}

/**
 * Number of policy changes over time (Simplest variant criterion §10.6):
 * adjacent-phase remuneration differences per adult, plus a late pillar
 * start (delay > 0) for each pillar as a scheduled policy action.
 */
export function policyComplexity(policy: Policy): number {
  let changes = 0;
  for (const arr of Object.values(policy.remunerationByPhase)) {
    for (let i = 1; i < arr.length; i++) {
      if (Math.abs(arr[i] - arr[i - 1]) > 0.005) changes++;
    }
  }
  if (policy.iiStartDelay > 0) changes++;
  if (policy.iiiStartDelay > 0) changes++;
  return changes;
}

/**
 * Stage 4 neighbour moves: adjacent remuneration levels per phase/adult,
 * adjacent pillar delays, adjacent buffer sizes and the alternative funding
 * rule. Phase structure follows delay changes; per-year remuneration is
 * remapped onto the new phase boundaries.
 */
export function neighbourPolicies(
  ctx: ProjectionContext,
  policy: Policy,
  kinks: KinkLevels,
  optim: { pillarDelayMin: number; pillarDelayMax: number; bufferCandidates: number[] },
): Policy[] {
  const out: Policy[] = [];
  const seen = new Set<string>();
  const add = (spec: Partial<CandidateSpec> & { remuneration?: Record<string, number[]> }): void => {
    const full: CandidateSpec = {
      iiStartDelay: spec.iiStartDelay ?? policy.iiStartDelay,
      iiiStartDelay: spec.iiiStartDelay ?? policy.iiiStartDelay,
      bufferMonths: spec.bufferMonths ?? policy.bufferMonths,
      fundingRule: spec.fundingRule ?? policy.fundingRule,
      remuneration:
        spec.remuneration ??
        Object.fromEntries(
          Object.entries(policy.remunerationByPhase).map(([id, arr]) => [
            id,
            policy.phaseStartYears.map((sy) => yearlyRemuneration(policy, sy)[id] ?? 0),
          ]),
        ),
    };
    const p = buildPolicy(ctx, full);
    if (!seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  };

  // coordinate moves on per-phase remuneration (rebuild via per-year values)
  const baseYearly = Object.fromEntries(
    Object.keys(policy.remunerationByPhase).map((id) => [
      id,
      policy.phaseStartYears.map((sy) => yearlyRemuneration(policy, sy)[id] ?? 0),
    ]),
  );
  const levelIdx = (v: number): number => {
    let best = 0;
    let bestDist = Infinity;
    kinks.levels.forEach((l, i) => {
      const d = Math.abs(l - v);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  };
  for (const adultId of Object.keys(baseYearly)) {
    const arr = baseYearly[adultId];
    for (let phase = 0; phase < arr.length; phase++) {
      const idx = levelIdx(arr[phase]);
      for (const delta of [-1, 1]) {
        const ni = idx + delta;
        if (ni < 0 || ni >= kinks.levels.length) continue;
        const next = Object.fromEntries(
          Object.entries(baseYearly).map(([id, a]) => [id, [...a]]),
        );
        next[adultId][phase] = kinks.levels[ni];
        add({ remuneration: next });
      }
    }
  }

  for (const d of [-1, 1]) {
    const ii = policy.iiStartDelay + d;
    if (ii >= optim.pillarDelayMin && ii <= optim.pillarDelayMax) add({ iiStartDelay: ii });
    const iii = policy.iiiStartDelay + d;
    if (iii >= optim.pillarDelayMin && iii <= optim.pillarDelayMax) add({ iiiStartDelay: iii });
  }

  const bIdx = optim.bufferCandidates.indexOf(policy.bufferMonths);
  if (bIdx > 0) add({ bufferMonths: optim.bufferCandidates[bIdx - 1] });
  if (bIdx >= 0 && bIdx < optim.bufferCandidates.length - 1) {
    add({ bufferMonths: optim.bufferCandidates[bIdx + 1] });
  }
  add({ fundingRule: policy.fundingRule === 'LoanFirst' ? 'DistributionFirst' : 'LoanFirst' });

  return out;
}

/** Static rule-driven warning strings attached to optimisation results. */
export function policySubstanceWarnings(ctx: ProjectionContext): string[] {
  const w: string[] = [];
  for (const a of ctx.household.adults) {
    if (!a.workRoleRecorded) {
      w.push(
        `No role or work arrangement is recorded for ${a.name}; remuneration must represent genuine work. ` +
          'The app warns but does not block this policy.',
      );
    }
  }
  w.push(
    'Distributable equity is assumed to include unrealised fair-value gains — confirm with the accountant (Appendix B, item 11).',
  );
  w.push(
    'II and III are modelled as household-aggregated shared balances with older-adult access dates (D-05/D-21).',
  );
  if (!ctx.assumptions.returns.stochasticInflation.enabled) {
    w.push('Inflation risk is excluded from the Monte Carlo distribution (stochastic inflation is off).');
  }
  return w;
}
