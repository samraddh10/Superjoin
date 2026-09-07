/**
 * Tests for the scorer's matching rule.
 *
 * Every figure in the evaluation report rests on this rule, so the cases that matter are
 * the ones where a lenient matcher would flatter the system: a quarter satisfying a claim
 * about the year, an unresolvable scale word passing as agreement, or two different
 * measures folded together because their names look alike.
 */

import { describe, expect, it } from 'vitest';

import type { GoldClaim } from './goldset.ts';
import {
  baseUnits,
  compareFigures,
  foldPeriodLabel,
  matchClaim,
  predicatesAgree,
  quoteLocates,
  type ProducedClaim,
} from './match.ts';

function gold(overrides: Partial<GoldClaim> = {}): GoldClaim {
  return {
    id: 'C01',
    document: 'doc-03-earnings-deck',
    physical_page: 5,
    printed_page_label: '5',
    subject: 'Delhivery Limited',
    predicate: 'revenue_from_services',
    numeric_value: '8142',
    currency: 'INR',
    scale: 'crore',
    period_label: 'FY2024',
    period_type: 'fiscal_year',
    scope: 'consolidated',
    assertion_status: 'reported',
    evidence_kind: 'narrative',
    quote: '₹8,142 Cr FY24 revenue from services',
    ...overrides,
  };
}

function produced(overrides: Partial<ProducedClaim> = {}): ProducedClaim {
  return {
    id: 'p1',
    documentId: 'd1',
    filename: '03-delhivery-q4-fy24-earnings-presentation.pdf',
    subject: 'Delhivery Limited',
    predicate: 'revenue_from_services',
    numericValue: '8142',
    scale: 'crore',
    currency: 'INR',
    unit: null,
    periodLabel: 'FY2024',
    periodType: 'fiscal_year',
    scope: 'consolidated',
    status: 'accepted',
    pages: [5],
    evidence: [],
    ...overrides,
  };
}

const resolve = () => 'doc-03-earnings-deck';

describe('scale handling', () => {
  it('converts known scale words to base units exactly', () => {
    expect(baseUnits('8142', 'crore')!.toFixed()).toBe('81420000000');
    expect(baseUnits('81420', 'million')!.toFixed()).toBe('81420000000');
  });

  it('refuses an unrecognised scale word rather than treating it as one', () => {
    // "8,142 somethings" must not silently become "8,142", which would then agree with
    // any unscaled figure of the same digits.
    expect(baseUnits('8142', 'gazillion')).toBeNull();
  });

  it('treats an absent scale as unscaled', () => {
    expect(baseUnits('42', null)!.toFixed()).toBe('42');
  });
});

describe('figure comparison', () => {
  it('matches the same figure written at different scales', () => {
    expect(compareFigures(gold(), produced({ numericValue: '81420', scale: 'million' }))).toBe(
      'equal',
    );
  });

  it('does not accept a near miss', () => {
    // 81,415 million against a crore-rounded 8,142 is the P01 corroboration case. That is
    // a judgement about whether two *sources* agree, and it is not extraction accuracy:
    // the scorer asks only whether the system read the figure the page prints.
    expect(compareFigures(gold(), produced({ numericValue: '81415', scale: 'million' }))).toBe(
      'different',
    );
  });

  it('separates "cannot compare" from "does not match"', () => {
    expect(compareFigures(gold(), produced({ scale: 'zillion' }))).toBe('incomparable');
  });

  it('counts two claims with no figure as agreeing', () => {
    expect(
      compareFigures(gold({ numeric_value: null, scale: null }), produced({ numericValue: null })),
    ).toBe('both_absent');
  });
});

describe('predicate agreement', () => {
  it('accepts the same predicate written differently', () => {
    expect(predicatesAgree('revenue_from_services', 'Revenue From Services')).toBe(true);
  });

  it('keeps distinct measures apart', () => {
    // The plan names this pair specifically: revenue from operations must never be
    // equated with total income.
    expect(predicatesAgree('revenue_from_operations', 'total_income')).toBe(false);
    expect(predicatesAgree('ebitda', 'adjusted_ebitda')).toBe(false);
  });
});

describe('period folding', () => {
  it('folds the two spellings of a fiscal year', () => {
    expect(foldPeriodLabel('FY24')).toBe(foldPeriodLabel('FY2024'));
  });

  it('never folds a quarter into the year that contains it', () => {
    expect(foldPeriodLabel('Q4 FY24')).not.toBe(foldPeriodLabel('FY2024'));
  });
});

describe('matching a gold claim', () => {
  it('matches on document, page, predicate and value', () => {
    const outcome = matchClaim(gold(), [produced()], resolve);
    expect(outcome.produced?.id).toBe('p1');
    expect(outcome.valueVerdict).toBe('equal');
    expect(outcome.periodAgrees).toBe(true);
    expect(outcome.scopeAgrees).toBe(true);
  });

  it('does not match a claim from another page', () => {
    expect(matchClaim(gold(), [produced({ pages: [9] })], resolve).produced).toBeNull();
  });

  it('does not match a claim from another document', () => {
    expect(matchClaim(gold(), [produced()], () => 'doc-01-prospectus').produced).toBeNull();
  });

  it('matches a right value with the wrong period, and says the period is wrong', () => {
    // The important case. Period is not a match condition, because a system that found
    // the figure but mislabelled its period has made an extraction error worth seeing —
    // not a miss, and certainly not a pass.
    const outcome = matchClaim(gold(), [produced({ periodLabel: 'Q4 FY24' })], resolve);
    expect(outcome.produced?.id).toBe('p1');
    expect(outcome.periodAgrees).toBe(false);
  });

  it('prefers the candidate whose context also agrees', () => {
    const wrongPeriod = produced({ id: 'wrong', periodLabel: 'Q4 FY24' });
    const right = produced({ id: 'right' });
    expect(matchClaim(gold(), [wrongPeriod, right], resolve).produced?.id).toBe('right');
  });
});

describe('locating a quote', () => {
  const block = 'Revenue  from   services was ₹8,142 Cr in FY24 — a record.';

  it('finds a quote across collapsed whitespace and a non-breaking space', () => {
    expect(quoteLocates('Revenue from services was ₹8,142 Cr', block)).toBe(true);
  });

  it('folds the dashes a PDF uses interchangeably', () => {
    expect(quoteLocates('in FY24 - a record.', block)).toBe(true);
  });

  it('does not fold digits or currency symbols', () => {
    // The whole point of the check: a figure that is not on the page cannot be matched
    // into existence by normalisation.
    expect(quoteLocates('₹8,143 Cr', block)).toBe(false);
    expect(quoteLocates('$8,142 Cr', block)).toBe(false);
  });

  it('refuses an empty quote', () => {
    expect(quoteLocates('   ', block)).toBe(false);
  });
});
