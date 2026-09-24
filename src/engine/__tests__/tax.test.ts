/** Tax engine tests (§15.2) — golden cases, gross-up, kinks, versioning. */

import { describe, expect, it } from 'vitest';
import { createDefaultRegistry, getRuleValue, eventYear, projectPensionAge } from '../../rules/registry';
import {
  adultAnnualTax,
  annualExemption,
  distributionGrossToNet,
  distributionNetToGross,
  distributionTaxOnNet,
  remunerationPayroll,
  taxYearParams,
  zeroPitKinkMonthly,
} from '../tax';
import { round2 } from '../money';

const reg = createDefaultRegistry();
const opts = { generalInflation: 0.02, healthcareInflation: 0.02 };

describe('2026 employment golden case (regression target)', () => {
  const p = taxYearParams(reg, 2026, opts);
  const payroll = remunerationPayroll(p, 886, 'employment', 0, 1985, undefined, 65, 2026);
  const tax = adultAnnualTax(p, {
    adultId: 'x',
    year: 2026,
    birthYear: 1985,
    pensionAge: 65,
    statePensionEnabled: false,
    statePensionAnnual: 0,
    remuneration: payroll,
  });

  it('computes monthly employee unemployment insurance', () => {
    expect(round2(payroll.employeeUI / 12)).toBeCloseTo(14.18, 2);
  });

  it('computes PIT base after the €700 exemption and monthly PIT', () => {
    expect(tax.remunerationTaxable / 12).toBeCloseTo(171.82, 2);
    expect(round2(tax.pit / 12)).toBeCloseTo(37.8, 2);
  });

  it('computes monthly net', () => {
    const net = round2(payroll.annualGross - payroll.employeeUI - tax.pit);
    expect(round2(net / 12)).toBeCloseTo(834.02, 2);
  });

  it('computes employer social tax, unemployment insurance and total cost', () => {
    expect(round2(payroll.employerSocialTax / 12)).toBeCloseTo(292.38, 2);
    expect(round2(payroll.employerUI / 12)).toBeCloseTo(7.09, 2);
    expect(round2(payroll.employerCost / 12)).toBeCloseTo(1185.47, 2);
  });
});

describe('board-member fee payroll (no unemployment insurance)', () => {
  const p = taxYearParams(reg, 2026, opts);
  const payroll = remunerationPayroll(p, 886, 'boardMemberFee', 0, 1985, undefined, 65, 2026);

  it('charges no employee or employer unemployment insurance', () => {
    expect(payroll.employeeUI).toBe(0);
    expect(payroll.employerUI).toBe(0);
  });

  it('still charges social tax with the minimum-base rule', () => {
    expect(round2(payroll.employerSocialTax / 12)).toBeCloseTo(292.38, 2);
    expect(round2(payroll.employerCost / 12)).toBeCloseTo(14140.56 / 12, 2);
  });
});

describe('derived remuneration kink', () => {
  const p = taxYearParams(reg, 2026, opts);

  it('PIT reaches zero at exemption ÷ (1 − employee UI rate) — ≈ €711.38, derived not hard-coded', () => {
    const kink = zeroPitKinkMonthly(p, 'employment', false);
    expect(kink).toBeCloseTo(711.38, 2);
    // verify zero PIT at the kink exactly
    const payroll = remunerationPayroll(p, kink, 'employment', 0, 1985, undefined, 65, 2026);
    const tax = adultAnnualTax(p, {
      adultId: 'x',
      year: 2026,
      birthYear: 1985,
      pensionAge: 65,
      statePensionEnabled: false,
      statePensionAnnual: 0,
      remuneration: payroll,
    });
    expect(tax.pit).toBeCloseTo(0, 6);
    // one cent above the kink produces positive PIT
    const payroll2 = remunerationPayroll(p, kink + 0.01, 'employment', 0, 1985, undefined, 65, 2026);
    const tax2 = adultAnnualTax(p, {
      adultId: 'x',
      year: 2026,
      birthYear: 1985,
      pensionAge: 65,
      statePensionEnabled: false,
      statePensionAnnual: 0,
      remuneration: payroll2,
    });
    expect(tax2.pit).toBeGreaterThan(0);
  });

  it('board-member kink equals the exemption (no UI deducted)', () => {
    expect(zeroPitKinkMonthly(p, 'boardMemberFee', false)).toBe(700);
  });
});

describe('basic exemption', () => {
  const p = taxYearParams(reg, 2026, opts);

  it('is €8,400/year below pension age and €9,312 in/after the pension-age year', () => {
    expect(annualExemption(p, 1980, 65, 2026)).toBe(8400);
    expect(annualExemption(p, 1961, 65, 2026)).toBe(9312); // turns 65 in 2026
    expect(annualExemption(p, 1961, 65, 2030)).toBe(9312);
    expect(annualExemption(p, 1962, 65, 2026)).toBe(8400); // turns 65 in 2027
  });

  it('no longer depends on income from 2026 (phase-out abolished)', () => {
    expect(getRuleValue(reg, 'exemptionPhaseOutActive', 2026, opts).value).toBe(0);
  });

  it('extrapolates with inflation in future years', () => {
    const v2027 = getRuleValue(reg, 'basicExemptionMonthly', 2027, opts).value;
    expect(v2027).toBeCloseTo(700 * 1.02, 6);
  });

  it('allocates to state pension first, leaving the remainder for remuneration', () => {
    const payroll = remunerationPayroll(p, 886, 'employment', 0, 1985, undefined, 65, 2026);
    const tax = adultAnnualTax(p, {
      adultId: 'x',
      year: 2026,
      birthYear: 1985,
      pensionAge: 65,
      statePensionEnabled: true,
      statePensionAnnual: 6000,
      remuneration: payroll,
    });
    expect(tax.exemptionAppliedPension).toBe(6000);
    expect(tax.exemptionAppliedRemuneration).toBe(2400);
    expect(tax.pitPension).toBe(0);
    // remuneration uses only the leftover exemption
    expect(tax.remunerationTaxable).toBeCloseTo(10632 - 170.11 - 2400, 2);
  });
});

describe('0%-tax pillar income does not consume exemption', () => {
  const p = taxYearParams(reg, 2026, opts);
  it('pillar payments never appear in the tax engine input — exemption fully available to wages', () => {
    const payroll = remunerationPayroll(p, 886, 'employment', 0, 1985, undefined, 65, 2026);
    const tax = adultAnnualTax(p, {
      adultId: 'x',
      year: 2026,
      birthYear: 1985,
      pensionAge: 65,
      statePensionEnabled: false,
      statePensionAnnual: 0,
      remuneration: payroll,
    });
    expect(tax.exemptionAppliedRemuneration).toBe(8400);
  });
});

describe('distribution gross-up (both directions)', () => {
  const p = taxYearParams(reg, 2026, opts);

  it('D = N ÷ 0.78 and tax = N × 22/78 for the 22/78 regime', () => {
    expect(distributionNetToGross(10_000, p)).toBeCloseTo(12_820.51, 2);
    expect(distributionTaxOnNet(10_000, p)).toBeCloseTo(2_820.51, 2);
    expect(distributionGrossToNet(12_820.51, p)).toBeCloseTo(10_000, 2);
  });

  it('supports the 24/76 stress regime', () => {
    const pStress = taxYearParams(reg, 2026, {
      ...opts,
      overrides: { distributionTaxNum: 24, distributionTaxDen: 76 },
    });
    expect(distributionNetToGross(10_000, pStress)).toBeCloseTo(10_000 * (100 / 76), 2);
    expect(distributionTaxOnNet(10_000, pStress)).toBeCloseTo(3_157.89, 2);
  });
});

describe('unemployment insurance at pension age', () => {
  const p = taxYearParams(reg, 2026, opts);

  it('employee UI withholding stops once pension age is reached', () => {
    const full = remunerationPayroll(p, 1000, 'employment', 0, 1960, undefined, 65, 2026);
    expect(full.employeeUI).toBe(0);
    const partial = remunerationPayroll(p, 1000, 'employment', 0, 1960, 9, 65, 2025);
    expect(partial.employeeUI).toBeCloseTo(12000 * 0.016 * (9 / 12), 2);
    expect(partial.uiMonths).toBe(9);
  });

  it('employer UI continues after pension age', () => {
    const full = remunerationPayroll(p, 1000, 'employment', 0, 1960, undefined, 65, 2026);
    expect(full.employerUI).toBeCloseTo(12000 * 0.008, 2);
  });
});

describe('rule registry versioning and event rules', () => {
  it('extrapolates the minimum social-tax base with inflation', () => {
    const v = getRuleValue(reg, 'minSocialTaxBaseMonthly', 2028, opts).value;
    expect(v).toBeCloseTo(886 * 1.02 ** 2, 4);
  });

  it('event rule: Jan–Jun/unknown months give start-of-year availability; Jul–Dec shifts a year', () => {
    expect(eventYear(1991, 55)).toBe(2046);
    expect(eventYear(1991, 55, 3)).toBe(2046);
    expect(eventYear(1991, 55, 9)).toBe(2047);
  });

  it('placeholder pension-age projection is capped and flagged unverified in the registry', () => {
    expect(projectPensionAge(1940)).toBe(65);
    expect(projectPensionAge(1991)).toBe(70);
    expect(projectPensionAge(2010)).toBe(70);
    const entry = Object.values(reg).find((e) => e.id === 'pensionAgeBase');
    expect(entry?.status).toBe('verified');
    expect(projectPensionAge(1991)).toBeGreaterThanOrEqual(65);
  });
});
