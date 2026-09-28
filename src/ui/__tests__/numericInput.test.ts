import { describe, expect, it } from 'vitest';
import { parseNumericDraft } from '../components';

describe('numeric input drafts', () => {
  it('allows zero to be deleted and replaced without coercing the empty draft to zero', () => {
    expect(parseNumericDraft('0')).toBe(0);
    expect(parseNumericDraft('')).toBeUndefined();
    expect(parseNumericDraft('11')).toBe(11);
  });

  it('keeps explicitly typed leading zeroes numerically valid', () => {
    expect(parseNumericDraft('011')).toBe(11);
  });

  it('maps displayed percentages back to the existing decimal model values', () => {
    expect(parseNumericDraft('10.0', true)).toBe(0.1);
    expect(parseNumericDraft('2.5', true)).toBe(0.025);
  });

  it('rejects incomplete or non-finite numeric text', () => {
    expect(parseNumericDraft('')).toBeUndefined();
    expect(parseNumericDraft('1e')).toBeUndefined();
    expect(parseNumericDraft('Infinity')).toBeUndefined();
  });
});
