import { describe, expect, it } from 'vitest';
import { validateStartingState } from '../validate';
import { adult, ctxFor } from './fixtures';

describe('blank numeric input validation', () => {
  it('blocks a run when a required starting balance is left empty', () => {
    const ctx = ctxFor({ adults: [adult({ id: 'a', birthYear: 1980 })], startYear: 2030 });
    ctx.startState.balances.personalCash = Number.NaN;

    const result = validateStartingState(ctx);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.field.includes('personalCash'))).toBe(true);
  });

  it('blocks non-finite assumption values without coercing them to zero', () => {
    const ctx = ctxFor({ adults: [adult({ id: 'a', birthYear: 1980 })], startYear: 2030 });
    ctx.assumptions.spending.targetAnnualTodayEUR = Number.NaN;

    const result = validateStartingState(ctx);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('not a valid number'))).toBe(true);
  });
});
