/**
 * Period and scope normalization.
 *
 * The property that matters most is the refusal: a fiscal year gets dates only when the
 * document said where its year begins. Everything else here exists so that a difference
 * of period or scope is visible to the classifier, because those differences are what
 * turn an apparent conflict into a reconciliation.
 */

import { describe, expect, it } from 'vitest';

import {
  compareContext,
  detectFiscalConvention,
  normalizeScope,
  parsePeriodLabel,
  resolvePeriod,
  type ClaimContext,
} from './context.ts';

const context = (overrides: Partial<ClaimContext> = {}): ClaimContext => ({
  periodLabel: 'FY2024',
  periodType: 'fiscal_year',
  periodStart: null,
  periodEnd: null,
  scope: 'consolidated',
  assertionStatus: 'reported',
  qualifiers: [],
  unit: null,
  currency: 'INR',
  ...overrides,
});

const iso = (date: Date | null): string | null => date?.toISOString().slice(0, 10) ?? null;

describe('detectFiscalConvention', () => {
  it('reads the convention out of a year-ended sentence', () => {
    expect(detectFiscalConvention('for the year ended March 31, 2024')).toBe('april-march');
    expect(detectFiscalConvention('for the year ending December 31, 2023')).toBe(
      'january-december',
    );
  });

  it('reads the statutory span form', () => {
    expect(detectFiscalConvention('the period from April 1, 2023 to March 31, 2024')).toBe(
      'april-march',
    );
  });

  it('finds nothing in a bare FY reference', () => {
    // "FY24" names a year without saying which twelve months it covers.
    expect(detectFiscalConvention('FY24 revenue grew.')).toBeNull();
  });
});

describe('parsePeriodLabel', () => {
  it('reads the four ways one fiscal year gets written', () => {
    for (const label of ['FY24', 'FY2024', 'fiscal 2024', '2023-24']) {
      const parsed = parsePeriodLabel(label);
      expect(parsed?.kind).toBe('fiscal_year');
      expect(parsed?.year).toBe(2024);
    }
  });

  it('does not promote a bare year to a fiscal one', () => {
    expect(parsePeriodLabel('2024')?.kind).toBe('calendar_year');
  });

  it('reads a quarter and the year it belongs to', () => {
    const parsed = parsePeriodLabel('Q4 FY24');
    expect(parsed?.kind).toBe('quarter');
    expect(parsed?.quarter).toBe(4);
    expect(parsed?.year).toBe(2024);
  });

  it('reads an as-of date', () => {
    const parsed = parsePeriodLabel('March 31, 2024');
    expect(parsed?.kind).toBe('as_of_date');
    expect(parsed?.month).toBe(3);
    expect(parsed?.year).toBe(2024);
  });
});

describe('resolvePeriod', () => {
  it('refuses to date a fiscal year when the document never stated its convention', () => {
    // Plan 5.2: resolve fiscal dates only when the convention is supported by the
    // document. Assuming April-March is right for this collection and wrong for the
    // next unfamiliar PDF, which is the case the whole exercise is about.
    const resolved = resolvePeriod('FY2024', 'fiscal_year', null);

    expect(resolved.start).toBeNull();
    expect(resolved.end).toBeNull();
    expect(resolved.label).toBe('FY2024');
    expect(resolved.note).toContain('does not state');
  });

  it('dates a fiscal year once the convention is known', () => {
    const resolved = resolvePeriod('FY2024', 'fiscal_year', 'april-march');
    expect(iso(resolved.start)).toBe('2023-04-01');
    expect(iso(resolved.end)).toBe('2024-03-31');
  });

  it('dates a calendar fiscal year differently', () => {
    const resolved = resolvePeriod('FY2024', 'fiscal_year', 'january-december');
    expect(iso(resolved.start)).toBe('2024-01-01');
    expect(iso(resolved.end)).toBe('2024-12-31');
  });

  it('dates a fiscal quarter within its own year', () => {
    const resolved = resolvePeriod('Q4 FY24', 'quarter', 'april-march');
    expect(iso(resolved.start)).toBe('2024-01-01');
    expect(iso(resolved.end)).toBe('2024-03-31');
  });

  it('dates a calendar year without needing a convention at all', () => {
    const resolved = resolvePeriod('2023', 'calendar_year', null);
    expect(iso(resolved.start)).toBe('2023-01-01');
    expect(iso(resolved.end)).toBe('2023-12-31');
  });

  it('records that the source stated no period', () => {
    const resolved = resolvePeriod(null, null, 'april-march');
    expect(resolved.periodType).toBe('unknown');
    expect(resolved.note).toContain('no period');
  });
});

describe('normalizeScope', () => {
  it('maps the two terms of art onto one form each', () => {
    expect(normalizeScope('Consolidated')).toBe('consolidated');
    expect(normalizeScope('standalone basis')).toBe('standalone');
    expect(normalizeScope('separate financial statements')).toBe('standalone');
  });

  it('leaves a segment in its own words', () => {
    // "Express parcel" is not a term of art with one meaning, so it compares equal only
    // to itself rather than being folded into a category it does not have.
    expect(normalizeScope('Express parcel')).toBe('express parcel');
  });
});

describe('compareContext', () => {
  it('finds nothing between two identical contexts', () => {
    expect(compareContext(context(), context())).toEqual([]);
  });

  it('does not report FY24 and FY2024 as different periods', () => {
    const differences = compareContext(context({ periodLabel: 'FY24' }), context());
    expect(differences).toEqual([]);
  });

  it('reports a period difference that could explain a gap', () => {
    const differences = compareContext(context(), context({ periodLabel: 'FY2023' }));
    expect(differences).toHaveLength(1);
    expect(differences[0]?.dimension).toBe('period');
    expect(differences[0]?.couldExplainGap).toBe(true);
  });

  it('reports a quarter against a year as a difference of kind', () => {
    const differences = compareContext(
      context(),
      context({ periodLabel: 'Q4 FY24', periodType: 'quarter' }),
    );
    expect(differences.some((entry) => entry.dimension === 'period_type')).toBe(true);
  });

  it('reports consolidated against standalone', () => {
    const differences = compareContext(context(), context({ scope: 'Standalone' }));
    expect(differences[0]?.dimension).toBe('scope');
  });

  it('marks a currency difference as unable to explain a gap', () => {
    // Plan 5.1 forbids converting currencies without a stated rate, so this makes the
    // pair incomparable rather than reconcilable.
    const differences = compareContext(context(), context({ currency: 'USD' }));
    const currency = differences.find((entry) => entry.dimension === 'currency');
    expect(currency?.couldExplainGap).toBe(false);
  });

  it('reports a qualifier one side has and the other does not', () => {
    const differences = compareContext(
      context({ qualifiers: [{ name: 'basis', value: 'including partner agents' }] }),
      context(),
    );
    const qualifier = differences.find((entry) => entry.dimension === 'qualifier');
    expect(qualifier?.a).toContain('including partner agents');
    expect(qualifier?.b).toBeNull();
  });

  it('compares resolved spans when both sides have them', () => {
    const resolved = resolvePeriod('FY2024', 'fiscal_year', 'april-march');
    const other = resolvePeriod('2023-24', 'fiscal_year', 'april-march');

    const differences = compareContext(
      context({ periodLabel: 'FY2024', periodStart: resolved.start, periodEnd: resolved.end }),
      context({ periodLabel: '2023-24', periodStart: other.start, periodEnd: other.end }),
    );

    expect(differences).toEqual([]);
  });
});
