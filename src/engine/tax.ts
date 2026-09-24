/**
 * Tax engine (Layer 2) — a pure, dedicated module. No tax logic lives in UI
 * components or projection code; the projection engine calls these functions.
 *
 * All functions are pure and deterministic: (rules, year, inputs) -> results.
 * Annual arithmetic with cent rounding at each computed line (documented
 * rounding policy). Monthly gross remuneration is annualised (×12) and all
 * figures reported per year; monthly figures are annual/12 for display.
 */

import type { RuleRegistry, RemunerationType } from '../types';
import { getRuleValue, reachedPensionAgeInOrBefore } from '../rules/registry';
import { round2 } from './money';

export interface TaxYearParams {
  pitRate: number;
  basicExemptionMonthly: number;
  basicExemptionPensionMonthly: number;
  socialTaxRate: number;
  minSocialTaxBaseMonthly: number;
  employeeUIRate: number;
  employerUIRate: number;
  boardMemberUIApplicable: boolean;
  employeeUIStopsAtPensionAge: boolean;
  iiContributionStopsAtPensionAge: boolean;
  distributionTaxNum: number;
  distributionTaxDen: number;
  exemptionPhaseOutActive: boolean;
}

export interface RuleOpts {
  generalInflation: number;
  healthcareInflation: number;
  overrides?: Record<string, number>;
}

/** Resolve all tax parameters for a calendar year. */
export function taxYearParams(
  registry: RuleRegistry,
  year: number,
  opts: RuleOpts,
): TaxYearParams {
  const g = (id: string): number => getRuleValue(registry, id, year, opts).value;
  return {
    pitRate: g('pitRate'),
    basicExemptionMonthly: g('basicExemptionMonthly'),
    basicExemptionPensionMonthly: g('basicExemptionPensionMonthly'),
    socialTaxRate: g('socialTaxRate'),
    minSocialTaxBaseMonthly: g('minSocialTaxBaseMonthly'),
    employeeUIRate: g('employeeUIRate'),
    employerUIRate: g('employerUIRate'),
    boardMemberUIApplicable: g('boardMemberUIApplicable') > 0.5,
    employeeUIStopsAtPensionAge: g('employeeUIStopsAtPensionAge') > 0.5,
    iiContributionStopsAtPensionAge: g('iiContributionStopsAtPensionAge') > 0.5,
    distributionTaxNum: g('distributionTaxNum'),
    distributionTaxDen: g('distributionTaxDen'),
    exemptionPhaseOutActive: g('exemptionPhaseOutActive') > 0.5,
  };
}

/**
 * Annual basic exemption for an adult in `year`. From 2026 the exemption is
 * flat (no income phase-out). Pension-age rate applies when the adult is of
 * pensionable age or reaches it within the year (EMTA).
 */
export function annualExemption(
  p: TaxYearParams,
  birthYear: number,
  pensionAge: number,
  year: number,
): number {
  const atPensionAge = reachedPensionAgeInOrBefore(birthYear, pensionAge, year);
  const monthly = atPensionAge ? p.basicExemptionPensionMonthly : p.basicExemptionMonthly;
  return round2(monthly * 12);
}

/**
 * Number of months in `year` for which employee unemployment-insurance is
 * withheld. Withholding ends on the last day of the month the employee
 * reaches pensionable age (EMTA). With unknown birth month we follow the
 * §3.1 convention (January–June / unknown => treated as start-of-year), so
 * no employee UI is withheld in the year pension age is reached.
 */
export function employeeUIMonths(
  p: TaxYearParams,
  birthYear: number,
  birthMonth: number | undefined,
  pensionAge: number,
  year: number,
): number {
  if (!p.employeeUIStopsAtPensionAge) return 12;
  const attainYear = birthYear + pensionAge;
  if (year > attainYear) return 0;
  if (year < attainYear) return 12;
  // year === attainYear: adult reaches pension age during this calendar year
  if (birthMonth === undefined || birthMonth <= 6) return 0; // §3.1 convention
  return birthMonth; // charged through the month of attainment
}

export interface RemunerationAnnual {
  monthlyGross: number;
  annualGross: number;
  employeeUI: number;
  employeeII: number;
  pit: number;
  net: number;
  employerSocialTax: number;
  employerUI: number;
  employerCost: number;
  uiMonths: number;
}

/**
 * Payroll for one adult's remuneration for a full year.
 * `employment` applies employee UI (1.6%) subject to pension-age cessation;
 * `boardMemberFee` carries social tax but no unemployment insurance (both
 * sides) — registry `boardMemberUIApplicable` (secondary status, G2 item 9).
 * Social tax = rate × max(gross, 12 × minBase) when gross > 0 (minimum-base
 * rule; exemptions from the minimum are an Appendix-B item).
 */
export function remunerationPayroll(
  p: TaxYearParams,
  monthlyGross: number,
  type: RemunerationType,
  iiContributionRate: number,
  birthYear: number,
  birthMonth: number | undefined,
  pensionAge: number,
  year: number,
): RemunerationAnnual {
  const annualGross = round2(monthlyGross * 12);
  const uiMonths = employeeUIMonths(p, birthYear, birthMonth, pensionAge, year);
  const uiApplicable = type === 'employment';
  const employeeUI = uiApplicable
    ? round2(annualGross * p.employeeUIRate * (uiMonths / 12))
    : 0;
  // II contribution stops at pension age (unverified rule, default rate 0).
  const atPension = reachedPensionAgeInOrBefore(birthYear, pensionAge, year);
  const iiActive = iiContributionRate > 0 && !(p.iiContributionStopsAtPensionAge && atPension);
  const employeeII = iiActive ? round2(annualGross * iiContributionRate) : 0;

  let employerSocialTax = 0;
  let employerUI = 0;
  let employerCost = 0;
  if (annualGross > 0) {
    const minBaseAnnual = round2(p.minSocialTaxBaseMonthly * 12);
    employerSocialTax = round2(p.socialTaxRate * Math.max(annualGross, minBaseAnnual));
    employerUI = uiApplicable ? round2(annualGross * p.employerUIRate) : 0;
    employerCost = round2(annualGross + employerSocialTax + employerUI);
  }
  return {
    monthlyGross,
    annualGross,
    employeeUI,
    employeeII,
    pit: 0,
    net: 0,
    employerSocialTax,
    employerUI,
    employerCost,
    uiMonths,
  };
}

export interface AdultTaxInput {
  adultId: string;
  year: number;
  birthYear: number;
  birthMonth?: number;
  pensionAge: number;
  statePensionEnabled: boolean;
  /** Annual state pension, gross nominal EUR for the year. */
  statePensionAnnual: number;
  remuneration: RemunerationAnnual;
}

export interface AdultTaxResult {
  adultId: string;
  exemptionAppliedPension: number;
  exemptionAppliedRemuneration: number;
  pensionTaxable: number;
  remunerationTaxable: number;
  pitPension: number;
  pitRemuneration: number;
  pit: number;
  employeeUI: number;
  employeeII: number;
  netIncome: number; // pension net + remuneration net (after PIT + UI + II credit)
}

/**
 * Per-adult annual tax with basic-exemption allocation.
 * Default allocation: state pension first, then remuneration (§9.3).
 * 0%-tax pillar income never appears here — it does not consume exemption.
 */
export function adultAnnualTax(p: TaxYearParams, input: AdultTaxInput): AdultTaxResult {
  const exemption = annualExemption(p, input.birthYear, input.pensionAge, input.year);
  return adultAnnualTaxWithExemption(p, input, exemption);
}

export function adultAnnualTaxWithExemption(
  p: TaxYearParams,
  input: AdultTaxInput,
  exemption: number,
): AdultTaxResult {
  const pension = input.statePensionEnabled ? input.statePensionAnnual : 0;
  const exemptionOnPension = Math.min(exemption, pension);
  const exemptionOnRem = round2(exemption - exemptionOnPension);
  const pensionTaxable = round2(Math.max(0, pension - exemptionOnPension));
  const remGrossUIII = round2(
    input.remuneration.annualGross - input.remuneration.employeeUI - input.remuneration.employeeII,
  );
  const remunerationTaxable = round2(Math.max(0, remGrossUIII - exemptionOnRem));
  const pitPension = round2(p.pitRate * pensionTaxable);
  const pitRemuneration = round2(p.pitRate * remunerationTaxable);
  const pit = round2(pitPension + pitRemuneration);
  const remunerationNet = round2(
    input.remuneration.annualGross -
      input.remuneration.employeeUI -
      input.remuneration.employeeII -
      pitRemuneration,
  );
  const pensionNet = round2(pension - pitPension);
  return {
    adultId: input.adultId,
    exemptionAppliedPension: exemptionOnPension,
    exemptionAppliedRemuneration: exemptionOnRem,
    pensionTaxable,
    remunerationTaxable,
    pitPension,
    pitRemuneration,
    pit,
    employeeUI: input.remuneration.employeeUI,
    employeeII: input.remuneration.employeeII,
    netIncome: round2(pensionNet + remunerationNet),
  };
}

/* ------------------------------------------------------------------ */
/* Distribution gross-up (both directions)                             */
/* ------------------------------------------------------------------ */

/**
 * Company outlay D needed to deliver net N to the household.
 * Convention (§6.3): distribution tax = N × num/den (22/78 of net),
 * therefore D = N × (num + den) / den = N ÷ 0.78 for 22/78.
 * For the 24/76 stress: D = N × 100/76 = N ÷ 0.76.
 */
export function distributionNetToGross(net: number, p: TaxYearParams): number {
  return round2((net * (p.distributionTaxNum + p.distributionTaxDen)) / p.distributionTaxDen);
}

/** Company distribution tax due when delivering net N. */
export function distributionTaxOnNet(net: number, p: TaxYearParams): number {
  return round2(distributionNetToGross(net, p) - net);
}

/** Net delivered when the company's total outlay is D. */
export function distributionGrossToNet(gross: number, p: TaxYearParams): number {
  return round2((gross * p.distributionTaxDen) / (p.distributionTaxNum + p.distributionTaxDen));
}

/* ------------------------------------------------------------------ */
/* Kink derivation (§10.3) — derived mathematically from the rules     */
/* ------------------------------------------------------------------ */

/**
 * Monthly gross at which PIT reaches zero after applicable deductions for a
 * full-time month with no II contribution:
 *   gross − gross×employeeUIRate − exemptionMonthly = 0
 *   => gross = exemptionMonthly / (1 − employeeUIRate)
 * With 2026 rules: 700 / (1 − 0.016) = 711.38 — derived, never hard-coded.
 * Board-member fees (no UI): gross = exemptionMonthly.
 */
export function zeroPitKinkMonthly(
  p: TaxYearParams,
  type: RemunerationType,
  pensionAgeReached: boolean,
): number {
  const exemption = pensionAgeReached ? p.basicExemptionPensionMonthly : p.basicExemptionMonthly;
  const uiRate = type === 'employment' && !pensionAgeReached ? p.employeeUIRate : 0;
  return round2(exemption / (1 - uiRate));
}

/** Monthly gross at which the exemption is fully used with no UI/II (info kink). */
export function exemptionExhaustedKinkMonthly(p: TaxYearParams, pensionAgeReached: boolean): number {
  const exemption = pensionAgeReached ? p.basicExemptionPensionMonthly : p.basicExemptionMonthly;
  return round2(exemption);
}
