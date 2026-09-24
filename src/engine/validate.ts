/**
 * Starting-state validation (§5.2). The optimiser must not silently repair an
 * inconsistent start state — it must show the inconsistency and stop the run.
 */

import type { BucketKey, StartingStateValidation, ValidationIssue } from '../types';
import type { ProjectionContext } from './projection';

export function validateStartingState(ctx: ProjectionContext): StartingStateValidation {
  const issues: ValidationIssue[] = [];
  const b = ctx.startState.balances;
  const err = (field: string, message: string): void => {
    issues.push({ field, message, severity: 'error' });
  };
  const warn = (field: string, message: string): void => {
    issues.push({ field, message, severity: 'warning' });
  };

  const fields: [BucketKey, string][] = [
    ['personalCash', 'Personal cash'],
    ['ouCash', 'OÜ cash'],
    ['ouInvestments', 'OÜ investments'],
    ['shareholderLoan', 'Shareholder-loan principal'],
    ['iiPillar', 'II pillar balance'],
    ['iiiPillar', 'III pillar balance'],
  ];
  for (const [k, label] of fields) {
    const v = b[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) err(k, `${label} is missing or not a number.`);
    else if (v < 0) err(k, `${label} must be non-negative (got €${v}).`);
  }

  if (ctx.startState.minimumCashReserve < 0) {
    err('minimumCashReserve', 'Minimum personal cash reserve must be non-negative.');
  }

  // withdrawal start date: canonical 1 January (§3.2) — non-1-January rejected
  const ds = ctx.startState.withdrawalStartDate;
  if (!/^\d{4}-01-01$/.test(ds)) {
    err(
      'withdrawalStartDate',
      `Withdrawal start date must be 1 January of a calendar year (annual model). Got "${ds}". ` +
        'Silent partial-year conversion is forbidden; convert the date explicitly.',
    );
  }

  // OÜ balance sheet reconciles (identity always holds by construction, but
  // check for NaN contamination and loan vs assets sanity)
  const ouAssets = b.ouCash + b.ouInvestments;
  if ([ouAssets].some((x) => !Number.isFinite(x))) {
    err('ou', 'OÜ balance sheet does not reconcile (non-finite assets).');
  }
  if (b.shareholderLoan > 0 && ouAssets === 0) {
    warn(
      'shareholderLoan',
      'Shareholder-loan principal is outstanding but the OÜ holds no assets — the OÜ equity is negative.',
    );
  }
  const equity = ouAssets - b.shareholderLoan;
  if (equity < 0) {
    warn('ouEquity', `OÜ equity is negative (€${equity.toFixed(2)}) at the withdrawal start.`);
  }

  // reserve consistency
  if (ctx.startState.minimumCashReserve > 0 && b.personalCash === 0) {
    warn('minimumCashReserve', 'A positive reserve is configured but personal cash starts at zero.');
  }

  // provenance present for every bucket
  for (const [k] of fields) {
    const p = b.provenance?.[k];
    if (!p) warn('provenance', `Missing provenance for bucket "${k}".`);
  }

  // adults complete enough for state pension & healthcare
  if (ctx.household.adults.length < 1 || ctx.household.adults.length > 2) {
    err('household', 'Household must contain 1 or 2 adults.');
  }
  for (const a of ctx.household.adults) {
    if (!Number.isFinite(a.birthYear) || a.birthYear < 1900 || a.birthYear > 2200) {
      err(`adult.${a.id}.birthYear`, `Invalid birth year for ${a.name}.`);
    }
    if (a.birthMonth !== undefined && (a.birthMonth < 1 || a.birthMonth > 12)) {
      err(`adult.${a.id}.birthMonth`, 'Birth month must be 1..12 when provided.');
    }
  }

  // pillar access assumptions available
  if (ctx.pillarOverrides.iiAccessYear !== null && ctx.pillarOverrides.iiAccessYear < 0) {
    err('pillarOverrides.iiAccessYear', 'II access year override is invalid.');
  }
  if (ctx.pillarOverrides.iiiAccessYear !== null && ctx.pillarOverrides.iiiAccessYear < 0) {
    err('pillarOverrides.iiiAccessYear', 'III access year override is invalid.');
  }

  // required rule-registry entries available
  const requiredRules = ['pitRate', 'basicExemptionMonthly', 'socialTaxRate', 'distributionTaxNum', 'distributionTaxDen'];
  for (const id of requiredRules) {
    const found = Object.values(ctx.registry).some((e) => e.id === id);
    if (!found) err(`rule.${id}`, `Rule registry is missing required entry "${id}".`);
  }

  const ok = !issues.some((i) => i.severity === 'error');
  return { ok, issues };
}
