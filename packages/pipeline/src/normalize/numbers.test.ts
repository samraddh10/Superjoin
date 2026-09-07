/**
 * Number and unit normalization.
 *
 * The cases here are taken from `evaluation/goldset.json` rather than invented, because
 * the point of this file is not that multiplication works: it is that the specific
 * comparisons the collection contains come out the way a reader who did the arithmetic by
 * hand says they should.
 */

import { describe, expect, it } from 'vitest';

import { compareValues, normalizeValue, parseNumeric, scaleRatio } from './numbers.ts';

describe('parseNumeric', () => {
  it('reads the Indian grouping and the western one as the same number', () => {
    expect(parseNumeric('8,14,15')?.value.toString()).toBe('81415');
    expect(parseNumeric('81,415')?.value.toString()).toBe('81415');
  });

  it('reads a loss printed in parentheses as negative', () => {
    // The accounting convention. Reading (1,229) as positive would turn the FY21 EBITDA
    // conflict into an agreement of the wrong sign.
    const parsed = parseNumeric('(1,229)');
    expect(parsed?.value.toString()).toBe('-1229');
    expect(parsed?.negative).toBe(true);
  });

  it('finds the currency and the scale word in the raw text', () => {
    const parsed = parseNumeric('₹8,142 Cr');
    expect(parsed?.currency).toBe('INR');
    expect(parsed?.scale).toBe('cr');
    expect(parsed?.value.toString()).toBe('8142');
  });

  it('keeps the source decimal places, which is what sets the rounding', () => {
    expect(parseNumeric('1,003.79')?.decimalPlaces).toBe(2);
    expect(parseNumeric('1,229')?.decimalPlaces).toBe(0);
  });

  it('tells a percentage from a percentage point', () => {
    expect(parseNumeric('1.6%')?.unit).toBe('percent');
    expect(parseNumeric('70 bps')?.unit).toBe('basis_point');
    expect(parseNumeric('1.6 percentage points')?.unit).toBe('percentage_point');
  });

  it('marks a range and keeps both ends', () => {
    const parsed = parseNumeric('10 to 12 million');
    expect(parsed?.kind).toBe('range');
    expect(parsed?.rangeLow?.toString()).toBe('10');
    expect(parsed?.rangeHigh?.toString()).toBe('12');
  });

  it('marks an approximation', () => {
    expect(parseNumeric('approximately 740 million')?.kind).toBe('approximate');
  });

  it('does not read a trailing year as the second end of a range', () => {
    // "8,142 Cr in FY24" holds two numbers and is not a span.
    expect(parseNumeric('8,142 Cr in FY24')?.kind).toBe('point');
  });

  it('returns null when there is no figure at all', () => {
    expect(parseNumeric('not applicable')).toBeNull();
  });
});

describe('normalizeValue', () => {
  it('multiplies a scale word into base units and records the step', () => {
    const normalized = normalizeValue({ numericValue: '8142', scale: 'crore', currency: 'INR' })!;
    expect(normalized.value).toBe('81420000000');
    expect(normalized.unit).toBe('INR');
    expect(normalized.steps[0]?.factor).toBe('10000000');
  });

  it('carries the source rounding through the same multiplication', () => {
    // 8,142 Cr is rounded to the crore, so it stands for a half-crore interval, not a
    // half-rupee one. Getting this wrong is what makes the FY24 revenue pair look like a
    // contradiction.
    const normalized = normalizeValue({ numericValue: '8142', scale: 'crore', currency: 'INR' })!;
    expect(normalized.roundingHalfWidth).toBe('5000000');
  });

  it('leaves a percentage in percent and a percentage point in percentage points', () => {
    expect(normalizeValue({ numericValue: '1.6', unit: 'percent' })?.unit).toBe('percent');
    expect(normalizeValue({ numericValue: '1.6', unit: 'pp' })?.unit).toBe('percentage_point');
  });

  it('converts basis points to percent', () => {
    const normalized = normalizeValue({ numericValue: '70', unit: 'bps' })!;
    expect(normalized.value).toBe('0.7');
    expect(normalized.unit).toBe('percent');
  });

  it('declines to convert an unrecognised scale word rather than dropping it', () => {
    // Silently ignoring "myriad" would report a figure orders of magnitude too small as
    // if it were comparable with one that had been converted properly.
    const normalized = normalizeValue({ numericValue: '5', scale: 'myriad', currency: 'INR' })!;
    expect(normalized.unit).toBe('INR/myriad');
    expect(normalized.steps[0]?.step).toBe('unrecognised_scale');
  });

  it('uses the source unit when there is no currency', () => {
    const normalized = normalizeValue({ numericValue: '740', scale: 'million', unit: 'shipments' })!;
    expect(normalized.value).toBe('740000000');
    expect(normalized.unit).toBe('shipments');
  });
});

describe('compareValues', () => {
  it('agrees on the FY24 revenue pair from the gold set', () => {
    // 8,142 Cr against 81,415 million: the crore figure is rounded, and the intervals
    // the two roundings imply meet exactly. This is gold-set P01, expected corroborates.
    const deck = normalizeValue({ numericValue: '8142', scale: 'crore', currency: 'INR' })!;
    const report = normalizeValue({ numericValue: '81415', scale: 'million', currency: 'INR' })!;

    expect(compareValues(deck, report).agreement).toBe('agree');
  });

  it('disagrees on the FY21 EBITDA pair from the gold set', () => {
    // (1,229) million against (1,003.79) million. Both are printed to at least the
    // million, so no rounding explains a gap of 225 million.
    const report = normalizeValue({ numericValue: '-1229', scale: 'million', currency: 'INR' })!;
    const prospectus = normalizeValue({
      numericValue: '-1003.79',
      scale: 'million',
      currency: 'INR',
    })!;

    const comparison = compareValues(report, prospectus);
    expect(comparison.agreement).toBe('disagree');
    expect(comparison.difference).toBe('225210000');
  });

  it('refuses to compare two currencies without a stated rate', () => {
    const inr = normalizeValue({ numericValue: '100', scale: 'crore', currency: 'INR' })!;
    const usd = normalizeValue({ numericValue: '12', scale: 'million', currency: 'USD' })!;

    const comparison = compareValues(inr, usd);
    expect(comparison.agreement).toBe('incomparable');
    expect(comparison.reason).toContain('exchange-rate');
  });

  it('refuses to compare a percentage with a percentage point', () => {
    const percent = normalizeValue({ numericValue: '1.6', unit: 'percent' })!;
    const points = normalizeValue({ numericValue: '1.6', unit: 'pp' })!;

    expect(compareValues(percent, points).agreement).toBe('incomparable');
  });

  it('reports the relative gap, not only the absolute one', () => {
    const a = normalizeValue({ numericValue: '100', currency: 'INR' })!;
    const b = normalizeValue({ numericValue: '50', currency: 'INR' })!;
    expect(compareValues(a, b).relativeDifference).toBe('0.5');
  });
});

describe('scaleRatio', () => {
  it('spots a clean power-of-ten gap, which is nearly always a misread scale word', () => {
    const crore = normalizeValue({ numericValue: '8142', scale: 'crore', currency: 'INR' })!;
    const asMillions = normalizeValue({ numericValue: '8142', scale: 'million', currency: 'INR' })!;
    expect(scaleRatio(crore, asMillions)).toBe('10');
  });

  it('reports nothing for an ordinary difference', () => {
    const a = normalizeValue({ numericValue: '8142', currency: 'INR' })!;
    const b = normalizeValue({ numericValue: '7000', currency: 'INR' })!;
    expect(scaleRatio(a, b)).toBeNull();
  });
});
