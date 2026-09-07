/**
 * Predicate comparison.
 *
 * Every test here is about a merge that must not happen. The system's failure mode is not
 * missing a comparison, which shows up as a lower recall figure; it is confidently
 * comparing two quantities that were never the same, which shows up as a false
 * contradiction with evidence attached.
 */

import { describe, expect, it } from 'vitest';

import { normalizePredicate, predicateHead, predicateRelation } from './predicates.ts';

describe('normalizePredicate', () => {
  it('folds the ways one name gets written', () => {
    for (const written of ['Revenue From Services', 'revenue-from-services', 'revenue from service']) {
      expect(normalizePredicate(written)).toBe('revenue_from_service');
    }
  });

  it('drops grammatical filler but keeps words that narrow the measure', () => {
    expect(normalizePredicate('revenue of the segment')).toBe('revenue_segment');
    expect(normalizePredicate('total income')).toBe('total_income');
  });
});

describe('predicateRelation', () => {
  it('matches a predicate with itself', () => {
    const relation = predicateRelation('revenue_from_services', 'Revenue From Services');
    expect(relation.relation).toBe('same');
    expect(relation.comparable).toBe(true);
  });

  it('refuses to equate revenue from operations with total income', () => {
    // Named in plan 5.3. The figures are close, the names are close, and the merge is
    // wrong.
    const relation = predicateRelation('revenue_from_operations', 'total_income');
    expect(relation.relation).toBe('explicitly_distinct');
    expect(relation.comparable).toBe(false);
  });

  it('refuses in both directions', () => {
    expect(predicateRelation('total_income', 'revenue_from_operations').comparable).toBe(false);
  });

  it('separates EBITDA from adjusted EBITDA', () => {
    const relation = predicateRelation('ebitda', 'adjusted_ebitda');
    expect(relation.relation).toBe('modifier_variant');
    expect(relation.comparable).toBe(false);
    expect(relation.reason).toContain('adjusted');
  });

  it('separates a measure from its total', () => {
    expect(predicateRelation('revenue', 'total_revenue').relation).toBe('modifier_variant');
  });

  it('reports a shared subject without treating it as a match', () => {
    const relation = predicateRelation('ebitda_margin', 'ebitda');
    expect(relation.relation).toBe('related_form');
    expect(relation.comparable).toBe(false);
  });

  it('reports nothing in common when there is nothing in common', () => {
    expect(predicateRelation('chief_financial_officer', 'ebitda').relation).toBe('unrelated');
  });

  it('never calls two different names the same measure', () => {
    // The invariant behind all of the above: only an identical normalized name is `same`.
    const pairs: readonly (readonly [string, string])[] = [
      ['revenue', 'income'],
      ['ebitda', 'operating_profit'],
      ['headcount', 'team_size'],
    ];

    for (const [a, b] of pairs) {
      expect(predicateRelation(a, b).relation).not.toBe('same');
    }
  });
});

describe('predicateHead', () => {
  it('reduces a qualified measure to the quantity it is about', () => {
    expect(predicateHead('adjusted_ebitda')).toBe('ebitda');
    expect(predicateHead('total_revenue')).toBe('revenue');
  });
});
