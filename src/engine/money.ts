/**
 * Money helpers. All money math in the engine goes through round2 at flow
 * application points (documented rounding policy) to avoid uncontrolled
 * floating-point drift while keeping ordinary number arithmetic.
 */

/** Round to cents (half-away-from-zero on the cent grid). */
export function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** Round to an arbitrary number of decimals. */
export function roundN(x: number, n: number): number {
  const f = 10 ** n;
  return Math.round((x + Number.EPSILON) * f) / f;
}

/** Clamp to >= 0 with cent rounding; negative zero becomes 0. */
export function round2p(x: number): number {
  const r = round2(x);
  return r === 0 ? 0 : r;
}

/** Format EUR for display. */
export function fmtEUR(x: number, digits = 0): string {
  return (
    new Intl.NumberFormat('et-EE', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(x)
  );
}

/** Format percent (input 0.065 -> "6.5%"). */
export function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

/** Percentage points formatting for probabilities. */
export function fmtProb(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

/** Convert today's euros to nominal euros for calendar year t. */
export function toNominal(todayEUR: number, inflation: number, baseYear: number, year: number): number {
  return todayEUR * (1 + inflation) ** (year - baseYear);
}

/** Convert nominal euros in year t to today's (baseYear) euros. */
export function toToday(nominal: number, inflation: number, baseYear: number, year: number): number {
  return nominal / (1 + inflation) ** (year - baseYear);
}
