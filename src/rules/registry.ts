/**
 * Rule registry — versioned tax/healthcare parameters by calendar year (§9).
 *
 * Every parameter carries: value, source URL, retrieval date, verification
 * status and an extrapolation rule for future years. The UI exposes the whole
 * registry; results depending on unverified/userAssumed rules are flagged.
 *
 * Baseline year = 2026 (BASE_YEAR). Verified against official sources where
 * noted on 2026-09-24; items marked 'secondary' / 'unverified' correspond to
 * Appendix B verification gates and must appear as flagged assumptions.
 */

import type { RuleEntry, RuleRegistry, RuleStatus } from '../types';
import { BASE_YEAR } from '../types';

export const RETRIEVED = '2026-09-24';

const EMTA_TAX_RATES = 'https://www.emta.ee/en/private-client/taxes-and-payment/declaration-income/tax-rates';
const EMTA_EXEMPTION = 'https://www.emta.ee/en/private-client/taxes-and-payment/tax-incentives/calculation-basic-exemption';
const EMTA_TAX_INCENTIVES = 'https://www.emta.ee/en/private-client/taxes-and-payment/tax-incentives';
const ARVELLO_2026 = 'https://arvello.ee/en/guides/estonian-tax-rates-2026';

function entry(
  id: string,
  label: string,
  value: number,
  unit: string,
  status: RuleStatus,
  source: string,
  extrapolation: RuleEntry['extrapolation'],
  notes?: string,
  year = BASE_YEAR,
): RuleEntry {
  return { id, label, year, value, unit, source, retrieved: RETRIEVED, status, extrapolation, notes };
}

/** The 2026 working baseline (§9.2). */
export function defaultRuleEntries(): RuleEntry[] {
  return [
    entry('pitRate', 'Personal income tax rate', 0.22, 'rate', 'verified', EMTA_TAX_RATES, 'constant',
      '22% flat. Re-confirmed against EMTA tax-rates page 2026-09-24.'),
    entry('basicExemptionMonthly', 'Basic exemption (non-pension age)', 700, 'EUR/month', 'verified', EMTA_EXEMPTION, 'inflation',
      '€700/month, €8,400/year. From 2026 the income-based phase-out ("tax hump") is abolished; the exemption no longer decreases as income increases.'),
    entry('basicExemptionPensionMonthly', 'Basic exemption (pension age)', 776, 'EUR/month', 'verified', EMTA_EXEMPTION, 'inflation',
      '€776/month, €9,312/year for people of pensionable age or reaching pensionable age within the year.'),
    entry('distributionTaxNum', 'OÜ distribution tax (numerator)', 22, 'parts', 'verified', ARVELLO_2026, 'constant',
      'Distribution tax = net × 22/78 (~28.21% of net). Repeal of the planned 24% rate confirmed in prior verification.'),
    entry('distributionTaxDen', 'OÜ distribution tax (denominator)', 78, 'parts', 'verified', ARVELLO_2026, 'constant', ''),
    entry('socialTaxRate', 'Social tax rate', 0.33, 'rate', 'secondary', ARVELLO_2026, 'constant',
      '33% employer social tax. Status "secondary" — confirm against Social Tax Act before production use (Appendix B).'),
    entry('minSocialTaxBaseMonthly', 'Minimum social-tax base', 886, 'EUR/month', 'secondary', ARVELLO_2026, 'inflation',
      '€886/month in 2026 (raised from €820). Minimum monthly social tax = 33% × base = €292.38. Confirm exemptions from the minimum (Appendix B, item 8).'),
    entry('employeeUIRate', 'Unemployment insurance — employee', 0.016, 'rate', 'secondary', EMTA_TAX_RATES, 'constant',
      '1.6% employee. Deductible from income-tax base. Withholding ends on the last day of the month the employee reaches pensionable age (EMTA).'),
    entry('employerUIRate', 'Unemployment insurance — employer', 0.008, 'rate', 'secondary', EMTA_TAX_RATES, 'constant',
      '0.8% employer; continues after pension age.'),
    entry('boardMemberUIApplicable', 'Unemployment insurance applies to board fees', 0, '0/1', 'secondary', 'https://enty.io/blog/estonian-business-glossary-2026', 'constant',
      'Board member fees carry social tax but no unemployment insurance (employee or employer side). Secondary source — verify against Unemployment Insurance Act (Appendix B, item 9).'),
    entry('employeeUIStopsAtPensionAge', 'Employee UI withheld stops at pension age', 1, '0/1', 'secondary', EMTA_TAX_RATES, 'constant',
      'EMTA: employee 1.6% withholding ends last day of the month the employee reaches pensionable age; employer 0.8% continues.'),
    entry('iiContributionStopsAtPensionAge', 'II contribution stops at pension age', 1, '0/1', 'unverified', 'https://www.emta.ee/en/private-client/taxes-and-payment/tax-incentives', 'constant',
      'Working assumption pending verification (Appendix B, item 9). Default II contribution from FIRE remuneration is 0% anyway.'),
    entry('healthcareRemunerationThresholdMonthly', 'Monthly gross needed for remuneration-based healthcare', 886, 'EUR/month', 'unverified', ARVELLO_2026, 'inflation',
      'Working assumption: coverage via employment/board-member remuneration requires at least the minimum social-tax base per month (Appendix B, item 8).'),
    entry('voluntaryHealthcarePremiumMonthly', 'Voluntary Tervisekassa insurance premium', 272, 'EUR/month', 'unverified', '', 'healthcareInflation',
      'Unverified working figure from prior specification (Appendix B, item 6). Eligibility and waiting period must also be verified.'),
    entry('pensionAgeBase', 'State pension age (2026 cohort reference)', 65, 'years', 'verified', 'https://www.emta.ee/en/private-client/taxes-and-payment/tax-incentives', 'cohort',
      'Pension age 65 in 2026; life-expectancy linkage from 2027. Cohort projection below is a placeholder formula — override per adult.'),
    entry('statePensionQualificationYears', 'State-pension qualification (years)', 15, 'years', 'unverified', '', 'constant',
      '15-year qualification requirement — verify (Appendix B, item 13). Informational only: the model uses a user-entered pension amount.'),
    entry('exemptionPhaseOutActive', 'Basic-exemption income phase-out in force', 0, '0/1', 'verified', EMTA_TAX_INCENTIVES, 'constant',
      '0 from 2026: phase-out abolished. Entries for years before 2026 would set this to 1.'),
  ];
}

export function createDefaultRegistry(): RuleRegistry {
  const reg: RuleRegistry = {};
  for (const e of defaultRuleEntries()) reg[`${e.id}@${e.year}`] = e;
  return reg;
}

export function ruleKey(id: string, year: number): string {
  return `${id}@${year}`;
}

/** Latest entry for `id` with entry.year <= year, else the earliest entry. */
export function getRuleEntry(registry: RuleRegistry, id: string, year: number): RuleEntry | null {
  const candidates = Object.values(registry).filter((e) => e.id === id);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.year - b.year);
  let best: RuleEntry | null = null;
  for (const e of candidates) {
    if (e.year <= year) best = e;
  }
  return best ?? candidates[0];
}

export interface RuleValueOptions {
  generalInflation: number;
  healthcareInflation: number;
  /** Optional per-run value overrides, e.g. stress "distribution tax 24/76". */
  overrides?: Record<string, number>;
}

/**
 * Resolve a rule value for a calendar year, applying the entry's
 * extrapolation rule from the entry's own year to the target year.
 */
export function getRuleValue(
  registry: RuleRegistry,
  id: string,
  year: number,
  opts: RuleValueOptions,
): { value: number; entry: RuleEntry | null; status: RuleStatus } {
  if (opts.overrides && id in opts.overrides) {
    const entry = getRuleEntry(registry, id, year);
    return { value: opts.overrides[id], entry, status: 'userAssumed' };
  }
  const e = getRuleEntry(registry, id, year);
  if (!e) return { value: 0, entry: null, status: 'unverified' };
  const delta = Math.max(0, year - e.year);
  let value = e.value;
  switch (e.extrapolation) {
    case 'constant':
    case 'cohort':
    case 'heldTable':
      value = e.value;
      break;
    case 'inflation':
      value = e.value * (1 + opts.generalInflation) ** delta;
      break;
    case 'healthcareInflation':
      value = e.value * (1 + opts.healthcareInflation) ** delta;
      break;
  }
  return { value, entry: e, status: e.status };
}

/** All distinct rule ids in the registry. */
export function ruleIds(registry: RuleRegistry): string[] {
  return [...new Set(Object.values(registry).map((e) => e.id))];
}

/** Registry entries whose status is not 'verified' — surfaced as warnings. */
export function unverifiedRuleIds(registry: RuleRegistry): { id: string; status: RuleStatus; label: string }[] {
  const seen = new Map<string, { id: string; status: RuleStatus; label: string }>();
  for (const e of Object.values(registry)) {
    if (e.status !== 'verified') {
      const prev = seen.get(e.id);
      if (!prev || e.year > (prev as any).year) seen.set(e.id, { id: e.id, status: e.status, label: e.label });
    }
  }
  return [...seen.values()];
}

/**
 * Placeholder cohort pension-age projection (§8.1 / Appendix B item 13).
 * Pension age 65 for cohorts reaching 65 by 2026; from 2027 the
 * life-expectancy linkage applies — this formula is an explicit
 * `unverified` placeholder: +3 months per birth year after 1961, capped 70.
 * Override per adult for real planning.
 */
export function projectPensionAge(birthYear: number): number {
  const base = 65;
  const extraYears = Math.max(0, birthYear - 1961);
  const age = base + Math.min(5, Math.floor((extraYears * 3) / 12));
  return Math.min(70, age);
}

/**
 * Annual event-availability rule (§3.1): an event requiring age A is
 * available from the start of calendar year birthYear+A when the birth month
 * is January–June or unknown, otherwise from the start of the following year.
 */
export function eventYear(birthYear: number, age: number, birthMonth?: number): number {
  const raw = birthYear + age;
  if (birthMonth !== undefined && birthMonth >= 7 && birthMonth <= 12) return raw + 1;
  return raw;
}

/** Whether the adult has reached pension age during/at calendar year `year`. */
export function reachedPensionAgeInOrBefore(birthYear: number, pensionAge: number, year: number): boolean {
  return year >= birthYear + pensionAge;
}

/** Helper to clone a registry with a stress-test override applied from a year. */
export function withRuleOverride(registry: RuleRegistry, id: string, fromYear: number, value: number): RuleRegistry {
  const next: RuleRegistry = { ...registry };
  next[ruleKey(id, fromYear)] = {
    ...(getRuleEntry(registry, id, fromYear) ?? entry(id, id, value, '', 'userAssumed', '', 'constant')),
    year: fromYear,
    value,
    status: 'userAssumed',
    notes: 'Stress-test override',
  };
  return next;
}
