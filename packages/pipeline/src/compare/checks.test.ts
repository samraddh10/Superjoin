/**
 * The deterministic checks and the label they can justify on their own.
 *
 * The single most important property here is negative: no combination of arithmetic
 * produces `contradicts` or `likely_contradiction`. Plan 6.2 states that these checks are
 * not proof of either conclusion, and every apparent conflict in the collection turns on
 * a definition or a basis that arithmetic cannot read.
 */

import { describe, expect, it } from 'vitest';

import { deterministicLabel, runDeterministicChecks, type ComparableClaim } from './checks.ts';

const claim = (overrides: Partial<ComparableClaim> = {}): ComparableClaim => ({
  id: 'claim-a',
  documentId: 'doc-1',
  entityId: 'entity-1',
  subject: 'Delhivery Limited',
  predicate: 'revenue_from_services',
  originalStatement: 'Revenue from services was 8,142 Cr in FY24.',
  rawValue: '8,142 Cr',
  numericValue: '8142',
  currency: 'INR',
  scale: 'crore',
  unit: null,
  periodLabel: 'FY2024',
  periodType: 'fiscal_year',
  periodStart: null,
  periodEnd: null,
  scope: 'consolidated',
  assertionStatus: 'reported',
  qualifiers: [],
  status: 'accepted',
  sourceBlockIds: ['block-1'],
  ...overrides,
});

/** The other side of the gold set's FY24 revenue pair, from the annual report. */
const report = (overrides: Partial<ComparableClaim> = {}): ComparableClaim =>
  claim({
    id: 'claim-b',
    documentId: 'doc-2',
    rawValue: '81,415',
    numericValue: '81415',
    scale: 'million',
    sourceBlockIds: ['block-2'],
    ...overrides,
  });

describe('runDeterministicChecks', () => {
  it('finds the FY24 revenue pair comparable and agreeing', () => {
    const checks = runDeterministicChecks(claim(), report());

    expect(checks.entityMatch).toBe('same');
    expect(checks.predicate.relation).toBe('same');
    expect(checks.contextDifferences).toEqual([]);
    expect(checks.value?.agreement).toBe('agree');
    expect(checks.worthComparing).toBe(true);
  });

  it('reports a period difference without ruling the pair out', () => {
    // Plan 6.1: differing periods must survive retrieval, because they are the
    // reconciliation cases.
    const checks = runDeterministicChecks(claim(), report({ periodLabel: 'FY2023' }));

    expect(checks.contextDifferences[0]?.dimension).toBe('period');
    expect(checks.worthComparing).toBe(true);
  });

  it('rules out a pair whose measures must never be equated', () => {
    const checks = runDeterministicChecks(
      claim({ predicate: 'revenue_from_operations' }),
      report({ predicate: 'total_income' }),
    );

    expect(checks.predicate.relation).toBe('explicitly_distinct');
    expect(checks.worthComparing).toBe(false);
  });

  it('rules out a pair about two different entities', () => {
    const checks = runDeterministicChecks(claim(), report({ entityId: 'entity-2' }));
    expect(checks.entityMatch).toBe('different');
    expect(checks.worthComparing).toBe(false);
  });

  it('says identity is by name only when a subject was left unresolved', () => {
    const checks = runDeterministicChecks(claim(), report({ entityId: null }));
    expect(checks.entityMatch).toBe('unresolved');
    expect(checks.notes.some((note) => note.includes('by name only'))).toBe(true);
  });

  it('flags a pair whose claims rest on the same passage', () => {
    // Plan 6.4: repeated wording is not independent evidence.
    const checks = runDeterministicChecks(claim(), report({ sourceBlockIds: ['block-1'] }));

    expect(checks.sharedSourceBlocks).toEqual(['block-1']);
    expect(checks.notes.some((note) => note.includes('one passage read twice'))).toBe(true);
  });

  it('names a clean power-of-ten gap for what it usually is', () => {
    const checks = runDeterministicChecks(claim(), report({ numericValue: '8142', scale: 'million' }));

    expect(checks.scaleRatio).toBe('10');
    expect(checks.notes.some((note) => note.includes('scale word'))).toBe(true);
  });

  it('makes no numerical comparison when one claim has no figure', () => {
    const checks = runDeterministicChecks(claim(), report({ numericValue: null, rawValue: null }));

    expect(checks.value).toBeNull();
    expect(checks.notes.some((note) => note.includes('no figure'))).toBe(true);
  });

  it('marks a pair provisional when either claim is held for review', () => {
    const checks = runDeterministicChecks(claim(), report({ status: 'needs_review' }));
    expect(checks.bothAccepted).toBe(false);
  });
});

describe('deterministicLabel', () => {
  it('never reaches a contradiction, whatever the arithmetic says', () => {
    // The invariant. A gap of 225 million with no explanation is still not a conflict
    // that arithmetic may declare.
    const checks = runDeterministicChecks(
      claim({ predicate: 'ebitda', numericValue: '-1229', scale: 'million', periodLabel: 'FY2021' }),
      report({ predicate: 'ebitda', numericValue: '-1003.79', scale: 'million', periodLabel: 'FY2021' }),
    );

    const decided = deterministicLabel(checks);
    expect(checks.value?.agreement).toBe('disagree');
    expect(decided.label).toBe('insufficient_context');
  });

  it('corroborates two independent accepted claims that agree in the same context', () => {
    const decided = deterministicLabel(runDeterministicChecks(claim(), report()));

    expect(decided.label).toBe('corroborates');
    expect(decided.rationale).toContain('rounding');
  });

  it('refuses to corroborate two claims resting on one passage', () => {
    const decided = deterministicLabel(
      runDeterministicChecks(claim(), report({ sourceBlockIds: ['block-1'] })),
    );
    expect(decided.label).toBe('insufficient_context');
  });

  it('refuses to corroborate within one document', () => {
    const decided = deterministicLabel(runDeterministicChecks(claim(), report({ documentId: 'doc-1' })));
    expect(decided.label).toBe('insufficient_context');
  });

  it('refuses to corroborate when a claim is held for review', () => {
    const decided = deterministicLabel(
      runDeterministicChecks(claim(), report({ status: 'needs_review' })),
    );
    expect(decided.label).toBe('insufficient_context');
  });

  it('abstains when the contexts differ, rather than reconciling them itself', () => {
    // A reconciliation has to be supported by text on a cited page, which is a reading
    // task and not an arithmetic one.
    const decided = deterministicLabel(
      runDeterministicChecks(claim(), report({ periodLabel: 'FY2023', numericValue: '72236' })),
    );

    expect(decided.label).toBe('insufficient_context');
    expect(decided.uncertaintyReasons.some((reason) => reason.includes('period'))).toBe(true);
  });

  it('calls a pair unrelated when the names have nothing in common', () => {
    const decided = deterministicLabel(
      runDeterministicChecks(claim({ predicate: 'chief_financial_officer' }), report()),
    );
    expect(decided.label).toBe('unrelated');
  });

  it('calls a pair unrelated when a rule exists to keep the measures apart', () => {
    const decided = deterministicLabel(
      runDeterministicChecks(
        claim({ predicate: 'revenue_from_operations' }),
        report({ predicate: 'total_income' }),
      ),
    );

    expect(decided.label).toBe('unrelated');
    expect(decided.rationale).toContain('not expected to agree');
  });
});

/**
 * The regression for this system's only false contradiction.
 *
 * Extraction returned `subject: "document"` for both a prospectus filing date and an
 * earnings deck's date. Both sides then had the same subject text and the same predicate
 * with different values, and the classifier called it a contradiction — "a document cannot
 * have two distinct dates of issuance", which is true and irrelevant, because these are
 * two different documents.
 *
 * Scoping the entity was not enough on its own: the classifier reads the subject text, not
 * only the resolved entity. The pair has to be refused by the gate that decides what the
 * classifier is shown at all.
 */
describe('placeholder subjects across documents', () => {
  const dated = (documentId: string, value: string): ComparableClaim => ({
    ...claim(),
    id: `c-${documentId}`,
    documentId,
    entityId: null,
    subject: 'document',
    predicate: 'date',
    rawValue: value,
    numericValue: null,
  });

  it('refuses to compare two documents that both call their subject "document"', () => {
    const checks = runDeterministicChecks(dated('doc-1', 'May 14, 2022'), dated('doc-2', 'May 17, 2024'));

    expect(checks.worthComparing).toBe(false);
    expect(checks.notes.join(' ')).toContain('name the document itself');
    // Whatever the fallback calls it, it must not be a conflict: asserting that two
    // documents disagree because both called their subject "document" is the error.
    expect(['unrelated', 'insufficient_context']).toContain(deterministicLabel(checks).label);
  });

  it('still compares two placeholder claims inside one document', () => {
    // Within a file, "this presentation" does name one thing, so the pair is not refused
    // on these grounds — same-document handling takes over from here.
    const checks = runDeterministicChecks(dated('doc-1', 'May 14, 2022'), dated('doc-1', 'May 17, 2024'));
    expect(checks.notes.join(' ')).not.toContain('name the document itself');
  });

  it('leaves real subjects comparable across documents', () => {
    const a = { ...dated('doc-1', '8,142 Cr'), subject: 'Delhivery Limited', predicate: 'revenue' };
    const b = { ...dated('doc-2', '8,142 Cr'), subject: 'Delhivery Limited', predicate: 'revenue' };
    // This is the pair corroboration depends on; the guard must not touch it.
    expect(runDeterministicChecks(a, b).worthComparing).toBe(true);
  });
});
