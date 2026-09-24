/**
 * Healthcare engine (Layer 4) — per adult, per month (§8.2).
 * The route is derived from legal status and remuneration; healthcare is not
 * a free optimiser parameter.
 *
 * Routes:
 *  1. statePensioner — from state-pension start where enabled; no premium.
 *  2. remuneration   — employment/board-member coverage via social tax,
 *                      requires monthly gross >= healthcare threshold.
 *  3. voluntary      — Tervisekassa insurance at the configured premium.
 *  4. none           — only when explicitly allowed (or not required).
 */

import type { Adult, RuleRegistry } from '../types';
import { getRuleValue } from '../rules/registry';
import { round2 } from './money';
import { statePensionStartYear } from './pension';
import type { TaxYearParams } from './tax';

export type HealthcareRoute = 'statePensioner' | 'remuneration' | 'voluntary' | 'none';

export interface HCOpts {
  generalInflation: number;
  healthcareInflation: number;
  baseYear: number;
}

export interface HealthcareYearPlan {
  adultId: string;
  route: HealthcareRoute;
  coveredMonths: number; // months with active coverage
  premium: number; // voluntary premium actually due this year (nominal)
  required: boolean;
  failure: boolean; // required coverage missing for any month
}

/** Monthly gross threshold for remuneration-based coverage (registry rule). */
export function remunerationCoverageThreshold(
  registry: RuleRegistry,
  year: number,
  opts: HCOpts,
): number {
  return getRuleValue(registry, 'healthcareRemunerationThresholdMonthly', year, {
    generalInflation: opts.generalInflation,
    healthcareInflation: opts.healthcareInflation,
  }).value;
}

/** Annual voluntary premium, nominal EUR for `year`. */
export function voluntaryPremiumAnnual(
  monthlyTodayEUR: number,
  year: number,
  baseYear: number,
  healthcareInflation: number,
): number {
  const monthly = monthlyTodayEUR * (1 + healthcareInflation) ** (year - baseYear);
  return round2(monthly * 12);
}

export interface HealthcareInput {
  adult: Adult;
  year: number;
  /** Monthly gross remuneration the policy provides this year. */
  monthlyGross: number;
  /** Whether the adult is at/after pension age in this year. */
  atPensionAge: boolean;
  /** User-configured voluntary premium (monthly, today's euros). */
  voluntaryPremiumTodayEUR: number;
}

/**
 * Derive the healthcare route for one adult in one year.
 * Once state-pensioner healthcare is active, remuneration receives no
 * additional healthcare credit (§8.2).
 */
export function deriveRoute(
  input: HealthcareInput,
  registry: RuleRegistry,
  opts: HCOpts,
): HealthcareRoute {
  const { adult, year, monthlyGross } = input;
  if (adult.statePensionEnabled && year >= statePensionStartYear(adult)) {
    return 'statePensioner';
  }
  const threshold = remunerationCoverageThreshold(registry, year, opts);
  if (monthlyGross > 0 && monthlyGross >= threshold - 1e-9) {
    return 'remuneration';
  }
  if (adult.voluntaryHealthcare) return 'voluntary';
  return 'none';
}

/** Build the per-adult healthcare plan for a year (monthly evaluation). */
export function healthcareYear(
  input: HealthcareInput,
  registry: RuleRegistry,
  opts: HCOpts,
): HealthcareYearPlan {
  const route = deriveRoute(input, registry, opts);
  const required = input.adult.healthcareRequired;
  let premium = 0;
  if (route === 'voluntary') {
    premium = voluntaryPremiumAnnual(
      input.voluntaryPremiumTodayEUR,
      input.year,
      opts.baseYear,
      opts.healthcareInflation,
    );
  }
  const coveredMonths = route === 'none' ? 0 : 12;
  const failure = required && (route === 'none' || coveredMonths < 12);
  return {
    adultId: input.adult.id,
    route,
    coveredMonths,
    premium,
    required,
    failure,
  };
}

/**
 * Total company cost of one year of remuneration (gross + social tax +
 * employer UI) — used by the explanation layer when comparing
 * remuneration-based healthcare with voluntary insurance (§8.2).
 */
export function marginalCostOfCoverageViaRemuneration(
  monthlyGross: number,
  taxP: TaxYearParams,
  remunerationType: 'employment' | 'boardMemberFee',
): number {
  const gross = round2(monthlyGross * 12);
  if (gross <= 0) return 0;
  const minBase = round2(taxP.minSocialTaxBaseMonthly * 12);
  const social = round2(taxP.socialTaxRate * Math.max(gross, minBase));
  const ui = remunerationType === 'employment' ? round2(gross * taxP.employerUIRate) : 0;
  return round2(gross + social + ui);
}
