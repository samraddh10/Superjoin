/**
 * Grounding checks.
 *
 * The properties tested here are the ones the acceptance criteria turn on: a quote either
 * is in the document or it is not, a claim the model both wrote and cited to its own
 * transcription is not verified by it, and a citation to a block that does not exist is a
 * rejection rather than an error.
 */

import { describe, expect, it } from 'vitest';

import type { ExtractedClaim } from './contract.ts';
import {
  decideClaimStatus,
  locateQuote,
  normalizeForMatch,
  overlapsStatement,
  statesValue,
  verifyClaim,
  type EvidenceBlock,
} from './verify.ts';

const claim = (overrides: Partial<ExtractedClaim> = {}): ExtractedClaim => ({
  subject: 'Delhivery Limited',
  predicate: 'revenue_from_services',
  original_statement: 'Revenue from services was 8,142 Cr in FY24.',
  raw_value: '8,142 Cr',
  numeric_value: '8142',
  currency: 'INR',
  scale: 'crore',
  unit: null,
  period_label: 'FY2024',
  period_type: 'fiscal_year',
  scope: 'consolidated',
  assertion_status: 'reported',
  qualifiers: [],
  evidence_block_ids: ['B1'],
  quote: 'Revenue from services was 8,142 Cr in FY24.',
  ...overrides,
});

const block = (overrides: Partial<EvidenceBlock> = {}): EvidenceBlock => ({
  id: 'block-1',
  documentId: 'doc-1',
  physicalPage: 5,
  content: 'Revenue from services was 8,142 Cr in FY24.',
  extractionMethod: 'native_text',
  ...overrides,
});

const options = (blocks: readonly EvidenceBlock[], nativeByPage?: Map<number, EvidenceBlock[]>) => ({
  documentId: 'doc-1',
  refToBlockId: new Map(blocks.map((entry, index) => [`B${index + 1}`, entry.id])),
  blocksById: new Map(blocks.map((entry) => [entry.id, entry])),
  ...(nativeByPage !== undefined ? { nativeBlocksByPage: nativeByPage } : {}),
});

describe('normalizeForMatch', () => {
  it('collapses the whitespace PDF extraction leaves inside numbers', () => {
    // A figure typeset with a thin space between the groups is the same figure.
    expect(normalizeForMatch('8,142 Cr').text).toBe('8,142 Cr');
    expect(normalizeForMatch('  a   b  ').text).toBe('a b');
  });

  it('folds typographic variants onto their plain equivalents', () => {
    expect(normalizeForMatch('“year’s”').text).toBe('"year\'s"');
    expect(normalizeForMatch('FY23–FY24').text).toBe('FY23-FY24');
  });

  it('drops the invisible characters PDFs carry', () => {
    expect(normalizeForMatch('re­port​').text).toBe('report');
  });

  it('does not change case', () => {
    // Case is meaning, not encoding. Folding it would let a paraphrase pass as a quote.
    expect(normalizeForMatch('Revenue').text).toBe('Revenue');
  });

  it('maps every normalized character back to where it came from', () => {
    const source = 'a  b';
    const normalized = normalizeForMatch(source);
    expect(normalized.text).toBe('a b');
    expect(source[normalized.offsets[2]!]).toBe('b');
  });
});

describe('locateQuote', () => {
  it('finds a passage across differing whitespace', () => {
    const found = locateQuote('8,142 Cr', 'Revenue from services was\n8,142 Cr in FY24.');
    expect(found).not.toBeNull();
  });

  it('returns a span of the original text, not the normalized one', () => {
    const content = 'Revenue   from services was 8,142 Cr.';
    const found = locateQuote('8,142 Cr', content)!;
    expect(content.slice(found.start, found.end)).toBe('8,142 Cr');
  });

  it('refuses a paraphrase', () => {
    // The check exists to tell a quote from a summary. This is the case it is for.
    expect(locateQuote('Revenue was about eight thousand crore', block().content)).toBeNull();
  });

  it('refuses an empty quote', () => {
    expect(locateQuote('   ', block().content)).toBeNull();
  });
});

describe('statesValue', () => {
  it('matches a figure across grouping conventions', () => {
    // 81,415 in the western convention and 8,14,15 in the Indian one are one number.
    expect(statesValue(claim({ numeric_value: '81415' }), 'Revenue of 81,415 million')).toBe(true);
    expect(statesValue(claim({ numeric_value: '81415' }), 'Revenue of 8,14,15 million')).toBe(true);
  });

  it('matches a loss printed in parentheses', () => {
    expect(statesValue(claim({ numeric_value: '-1229', raw_value: '(1,229)' }), 'EBITDA (1,229)')).toBe(
      true,
    );
  });

  it('reports absence when the passage does not carry the figure', () => {
    expect(statesValue(claim(), 'Revenue from services grew year on year.')).toBe(false);
  });

  it('reports absence for a claim with no value at all', () => {
    expect(statesValue(claim({ numeric_value: null, raw_value: null }), 'anything')).toBe(false);
  });
});

describe('overlapsStatement', () => {
  it('accepts a non-numeric claim whose words are in the passage', () => {
    const subject = claim({
      numeric_value: null,
      raw_value: null,
      predicate: 'chief_financial_officer',
      original_statement: 'Amit Agarwal is the Chief Financial Officer.',
    });
    expect(overlapsStatement(subject, 'Amit Agarwal, Chief Financial Officer')).toBe(true);
  });

  it('rejects a passage about something else', () => {
    const subject = claim({
      numeric_value: null,
      raw_value: null,
      original_statement: 'Amit Agarwal is the Chief Financial Officer.',
    });
    expect(overlapsStatement(subject, 'The registered office is in New Delhi.')).toBe(false);
  });
});

describe('verifyClaim', () => {
  it('accepts a claim quoted from the document text', () => {
    const result = verifyClaim(claim(), options([block()]));

    expect(result.status).toBe('accepted');
    expect(result.evidence[0]?.verification).toBe('verified_native_text');
    expect(result.evidence[0]?.entailment).toBe('supported');
    expect(result.evidence[0]?.supportRole).toBe('value');
  });

  it('rejects a citation to a block that is not there', () => {
    const result = verifyClaim(claim({ evidence_block_ids: ['B7'] }), options([block()]));

    expect(result.status).toBe('rejected');
    expect(result.evidence[0]?.verification).toBe('block_not_found');
    expect(result.evidence[0]?.sourceBlockId).toBeNull();
  });

  it('rejects a citation to another document block', () => {
    const foreign = block({ id: 'block-x', documentId: 'doc-2' });
    const result = verifyClaim(claim(), options([foreign]));

    expect(result.status).toBe('rejected');
    expect(result.evidence[0]?.verificationNote).toContain('different document');
  });

  it('rejects a quote that is not in the cited block', () => {
    const result = verifyClaim(
      claim({ quote: 'Revenue from services was 9,999 Cr in FY24.' }),
      options([block()]),
    );

    expect(result.status).toBe('rejected');
    expect(result.evidence[0]?.verification).toBe('quote_not_found');
  });

  it('rejects a real quote that does not state the reported figure', () => {
    // Citation existence and entailment are different questions, and this is the case
    // that separates them: the passage is genuinely in the document and still fails.
    const content = 'Revenue from services grew during the year under review.';
    const result = verifyClaim(
      claim({ quote: content }),
      options([block({ content })]),
    );

    expect(result.evidence[0]?.verification).toBe('verified_native_text');
    expect(result.evidence[0]?.entailment).toBe('unsupported');
    expect(result.status).toBe('rejected');
  });

  it('holds a claim supported only by a transcription for review', () => {
    // The model wrote the transcription and the claim. One system agreeing with itself
    // is not verification, which plan 4.3 states outright.
    const transcription = block({ id: 'block-t', extractionMethod: 'model_transcription' });
    const result = verifyClaim(claim(), options([transcription]));

    expect(result.status).toBe('needs_review');
    expect(result.evidence[0]?.verification).toBe('visual_only');
  });

  it('accepts a transcription-cited claim when the page text layer carries the figure', () => {
    const transcription = block({ id: 'block-t', extractionMethod: 'model_transcription' });
    const native = block({
      id: 'block-n',
      content: 'Revenue from services 8142 81415 Express parcel',
    });

    const result = verifyClaim(
      claim(),
      options([transcription], new Map([[5, [native]]])),
    );

    expect(result.status).toBe('accepted');
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[1]?.sourceBlockId).toBe('block-n');
    expect(result.evidence[1]?.verificationNote).toContain('independent');
  });

  it('does not add a cross-check when the page text layer lacks the figure', () => {
    const transcription = block({ id: 'block-t', extractionMethod: 'model_transcription' });
    const native = block({ id: 'block-n', content: 'Financial highlights' });

    const result = verifyClaim(claim(), options([transcription], new Map([[5, [native]]])));

    expect(result.evidence).toHaveLength(1);
    expect(result.status).toBe('needs_review');
  });

  it('records one row when the same block is cited twice', () => {
    const result = verifyClaim(claim({ evidence_block_ids: ['B1', 'B1'] }), options([block()]));
    expect(result.evidence).toHaveLength(1);
  });
});

describe('decideClaimStatus', () => {
  it('rejects a claim with no evidence at all', () => {
    expect(decideClaimStatus([], 'x').status).toBe('rejected');
  });

  it('accepts on one native-text row even when another citation failed', () => {
    const status = decideClaimStatus(
      [
        { verification: 'block_not_found', entailment: 'unchecked' },
        { verification: 'verified_native_text', entailment: 'supported' },
      ],
      'x',
    );
    expect(status.status).toBe('accepted');
  });

  it('rejects when any located passage contradicts the reported value', () => {
    // An unsupported row is not outvoted by a supported one. The claim cited a passage
    // that does not say what it reports, and that is a finding, not noise.
    const status = decideClaimStatus(
      [
        { verification: 'verified_native_text', entailment: 'supported' },
        { verification: 'verified_native_text', entailment: 'unsupported' },
      ],
      '8,142 Cr',
    );
    expect(status.status).toBe('rejected');
    expect(status.statusReason).toContain('8,142 Cr');
  });

  it('holds an unclear non-numeric claim for review rather than rejecting it', () => {
    const status = decideClaimStatus(
      [{ verification: 'verified_native_text', entailment: 'unclear' }],
      'x',
    );
    expect(status.status).toBe('needs_review');
  });
});
