/**
 * Pillar engine (Layers 3) — II/III fixed-term pensions (§7).
 *
 * > VERIFICATION GATE G1 applies to this whole module. Payment mechanics,
 * > access dates and duration tables are working assumptions until verified
 * > against Pensionikeskus / official sources.
 *
 * Modelling abstraction (D-05/D-21): one household-aggregated II balance and
 * one household-aggregated III balance, access based on the older adult.
 */

import type { Adult, Household, PillarOverrides, StartingBalanceSheet } from '../types';
import { eventYear } from '../rules/registry';
import { resolvePensionAge } from './pension';

export interface PillarAccess {
  year: number;
  provenance: 'projected' | 'user override' | 'assumption';
  note: string;
}

export interface HouseholdPillarAccess {
  olderAdult: Adult;
  ii: PillarAccess;
  iii: PillarAccess;
}

/** Older adult = lower birthYear (tie -> birthMonth, tie -> first listed). */
export function olderAdult(household: Household): Adult {
  const [a, b] = household.adults;
  if (!b) return a;
  if (a.birthYear !== b.birthYear) return a.birthYear < b.birthYear ? a : b;
  const am = a.birthMonth ?? 7;
  const bm = b.birthMonth ?? 7;
  if (am !== bm) return am < bm ? a : b;
  return a;
}

/**
 * Household pillar access dates (§7.3):
 *  - III: older adult's 55th-birthday year (legacy pre-2021 rule — D-06, pending verification).
 *  - II: five years before the older adult's state-pension age, provided the
 *    0%-tax long-term route is assumed available inside the early window
 *    (Gate G1 item 1); otherwise at pension age.
 */
export function pillarAccess(household: Household, overrides: PillarOverrides): HouseholdPillarAccess {
  const older = olderAdult(household);
  const pensionAge = resolvePensionAge(older);

  const iiiYear =
    overrides.iiiAccessYear ?? eventYear(older.birthYear, 55, older.birthMonth);
  const iii: PillarAccess =
    overrides.iiiAccessYear !== null
      ? {
          year: overrides.iiiAccessYear,
          provenance: 'user override',
          note: 'User-supplied III access year.',
        }
      : {
          year: iiiYear,
          provenance: 'assumption',
          note:
            'Age-55 legacy rule based on the household\'s stated pre-2021 contribution history — ' +
            'per-account/per-unit mechanism pending Gate G1 verification (D-06).',
        };

  let ii: PillarAccess;
  if (overrides.iiAccessYear !== null) {
    ii = { year: overrides.iiAccessYear, provenance: 'user override', note: 'User-supplied II access year.' };
  } else if (overrides.iiEarlyWindowAssumedAvailable) {
    ii = {
      year: eventYear(older.birthYear, pensionAge - 5, older.birthMonth),
      provenance: 'assumption',
      note:
        'Five years before state-pension age. Availability of the 0%-tax long-term route inside the ' +
        'five-year early window is unverified (Gate G1 item 1).',
    };
  } else {
    ii = {
      year: eventYear(older.birthYear, pensionAge, older.birthMonth),
      provenance: 'assumption',
      note: 'Early window assumed unavailable (Gate G1 item 1) — access at state-pension age.',
    };
  }
  return { olderAdult: older, ii, iii };
}

/**
 * Recommended duration (years) for a fixed-term pension starting at `age`.
 * Working default: 28 years at age 55 (user-supplied working value, D-06 —
 * 83 − 55 = 28), linear `83 − age` elsewhere. Per-pillar term overrides are
 * applied by the caller. Entirely unverified until Gate G1 passes.
 */
export function recommendedDuration(age: number, overrides: PillarOverrides): number {
  const tableVal = overrides.iiTermTable[age];
  if (tableVal !== undefined) return tableVal;
  return Math.max(5, 83 - age);
}

/** Synthetic pension-unit normalisation used by the projection model. */
export const NORMALISED_PILLAR_UNITS = 1_000_000;

/** Units redeemed for one payment from a fixed-term pension contract. */
export function unitsToRedeem(unitsHeld: number, paymentsRemaining: number): number {
  if (paymentsRemaining <= 0 || unitsHeld <= 0) return 0;
  return unitsHeld / paymentsRemaining;
}

/** EUR payment from redeemed pension units at the current NAV. */
export function paymentFromUnits(unitsRedeemed: number, nav: number): number {
  if (unitsRedeemed <= 0 || nav <= 0) return 0;
  return unitsRedeemed * nav;
}

export interface PillarContract {
  pillar: 'ii' | 'iii';
  startYear: number;
  termYears: number;
  /** Remaining payments incl. the upcoming one, at contract start. */
  remaining: number;
}

/** Age at contract start for duration lookup (year the contract begins). */
export function contractStartAge(older: Adult, startYear: number): number {
  return startYear - older.birthYear;
}

/** True while the pillar balance is still legally locked (no contract yet). */
export function pillarLocked(pillar: 'ii' | 'iii', access: PillarAccess, startYear: number): boolean {
  return startYear < access.year;
}

/** Household liquid vs locked split for the dashboard (§14.1). */
export function liquidLocked(
  b: StartingBalanceSheet,
  iiAccessYear: number,
  iiiAccessYear: number,
  year: number,
): { liquid: number; locked: number } {
  const iiLocked = year < iiAccessYear ? b.iiPillar : 0;
  const iiiLocked = year < iiiAccessYear ? b.iiiPillar : 0;
  return {
    liquid: b.personalCash + b.ouCash + b.ouInvestments,
    locked: iiLocked + iiiLocked,
  };
}
