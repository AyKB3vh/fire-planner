/**
 * State-pension engine (Layer 3). Future income stream, not an asset (§8.1).
 * Pension age is a versioned rule/projection with per-adult override.
 * Amount is a user-entered monthly estimate in today's euros; the model does
 * not independently reconstruct accrual (D-11).
 */

import type { Adult } from '../types';
import { eventYear, projectPensionAge } from '../rules/registry';
import { round2 } from './money';

export function resolvePensionAge(adult: Adult): number {
  return adult.pensionAgeOverride ?? projectPensionAge(adult.birthYear);
}

/** Calendar year in which the adult's state pension starts (§3.1 event rule). */
export function statePensionStartYear(adult: Adult): number {
  const age = resolvePensionAge(adult);
  return eventYear(adult.birthYear, age, adult.birthMonth);
}

/** Annual state pension, gross nominal EUR. */
export function statePensionAnnual(
  adult: Adult,
  monthlyTodayEUR: number,
  indexation: number,
  baseYear: number,
  year: number,
): number {
  if (!adult.statePensionEnabled) return 0;
  const monthly = monthlyTodayEUR * (1 + indexation) ** (year - baseYear);
  return round2(monthly * 12);
}

export function statePensionActive(adult: Adult, year: number): boolean {
  return adult.statePensionEnabled && year >= statePensionStartYear(adult);
}

/** Informational provenance for the pension-age rule shown in the UI. */
export function pensionAgeProvenance(adult: Adult): { provenance: 'user override' | 'projected'; note: string } {
  if (adult.pensionAgeOverride !== undefined) {
    return { provenance: 'user override', note: `Pension age ${adult.pensionAgeOverride} set by user.` };
  }
  return {
    provenance: 'projected',
    note:
      'Placeholder cohort projection (unverified): 65 with +3 months per birth year after 1961, capped 70. ' +
      'Life-expectancy linkage from 2027 must be verified (Appendix B, item 13).',
  };
}
