/**
 * Grounding: checking that a claim's citations exist, say what the claim says they say,
 * and are independent of the model that produced the claim.
 *
 * Plan section 4.3 separates three questions that are easy to collapse into one, and this
 * file keeps them apart because the answers genuinely differ:
 *
 *   1. Does the cited block exist and belong to this document?  -> `block_not_found`
 *   2. Is the quoted passage really in it?                      -> `quote_not_found`
 *   3. Does the passage support the claim?                      -> `entailment`
 *
 * A real quote can still fail to support the claim, so (2) passing tells you nothing
 * about (3). The pair is stored on every evidence row rather than folded into one verdict.
 *
 * The fourth question is about independence. A claim extracted by the model and cited to
 * a block the same model transcribed from a page image is one system agreeing with
 * itself. Plan 4.3 forbids treating that as verification, so such evidence is recorded as
 * `visual_only` and the claim stays `needs_review` — unless the figure also turns up in
 * the page's own text layer, which is a genuinely independent witness and is looked for
 * here.
 */

import type { ExtractedClaim } from './contract.ts';

/** A stored block, as verification needs to see it. */
export interface EvidenceBlock {
  readonly id: string;
  readonly documentId: string;
  readonly physicalPage: number;
  readonly content: string;
  readonly extractionMethod: 'native_text' | 'model_transcription';
  readonly blockType?: string;
}

export type Verification =
  | 'verified_native_text'
  | 'visual_only'
  | 'quote_not_found'
  | 'block_not_found';

export type Entailment = 'supported' | 'unsupported' | 'unclear' | 'unchecked';

export interface VerifiedEvidence {
  /** Null when the citation named a handle or block this document does not have. */
  readonly sourceBlockId: string | null;
  /** The handle as the model wrote it, kept so a bad citation can be reported as given. */
  readonly citedRef: string;
  readonly quote: string;
  readonly quoteStart: number | null;
  readonly quoteEnd: number | null;
  readonly verification: Verification;
  readonly entailment: Entailment;
  readonly verificationNote: string | null;
  /** Whether this row carries the value itself or the context around it (plan 4.3). */
  readonly supportRole: 'value' | 'context';
}

export interface ClaimVerification {
  readonly evidence: readonly VerifiedEvidence[];
  readonly status: 'accepted' | 'needs_review' | 'rejected';
  readonly statusReason: string;
}

/**
 * The whitespace and typography normalization a quote match is allowed.
 *
 * Documented here because plan 4.3 permits "only documented whitespace normalization" and
 * an undocumented allowance is how a paraphrase quietly passes as a quote. Everything in
 * this list is a difference in how the same characters were encoded, never a difference
 * in what they say:
 *
 *   - runs of any whitespace, including the non-breaking and thin spaces PDF text
 *     extraction produces inside numbers, collapse to one ordinary space;
 *   - curly quotation marks and apostrophes become their straight equivalents;
 *   - en dash, em dash and the Unicode minus sign become a hyphen;
 *   - the soft hyphen, the zero-width space and the byte-order mark are dropped.
 *
 * Case is not normalized, and no character is added or removed beyond the above. A quote
 * that differs from the source in any other way is not a quote.
 */
const CHARACTER_MAP = new Map<string, string>([
  ['‘', "'"],
  ['’', "'"],
  ['“', '"'],
  ['”', '"'],
  ['–', '-'],
  ['—', '-'],
  ['−', '-'],
  ['­', ''],
  ['​', ''],
  ['﻿', ''],
]);

interface Normalized {
  readonly text: string;
  /** For each character of `text`, the index it came from in the original. */
  readonly offsets: readonly number[];
}

/**
 * Normalizes a string while keeping every character's origin.
 *
 * The offsets are the point of doing this by hand rather than with a regular expression:
 * a match found in normalized space has to be reported as a span of the *stored* text, so
 * a future highlight lands on the characters the document actually contains.
 */
export function normalizeForMatch(input: string): Normalized {
  const chars: string[] = [];
  const offsets: number[] = [];
  let pendingSpace = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (/\s/.test(char)) {
      // Collapsed, and only emitted once something follows it, so a trailing run of
      // whitespace never becomes a character the match has to account for.
      if (chars.length > 0) pendingSpace = true;
      continue;
    }

    const mapped = CHARACTER_MAP.get(char) ?? char;
    if (mapped === '') continue;

    if (pendingSpace) {
      chars.push(' ');
      offsets.push(index);
      pendingSpace = false;
    }

    chars.push(mapped);
    offsets.push(index);
  }

  return { text: chars.join(''), offsets };
}

export interface QuoteLocation {
  readonly start: number;
  readonly end: number;
}

/**
 * Finds a quote in a block's stored text.
 *
 * Returns the span in the original string, not the normalized one. Null means the passage
 * is not there under any allowed normalization, which is a finding rather than an error:
 * plan 4.3 wants the claim marked, not the run failed.
 */
export function locateQuote(quote: string, content: string): QuoteLocation | null {
  const needle = normalizeForMatch(quote);
  const haystack = normalizeForMatch(content);

  if (needle.text === '') return null;

  const at = haystack.text.indexOf(needle.text);
  if (at === -1) return null;

  const start = haystack.offsets[at]!;
  const lastNormalized = at + needle.text.length - 1;
  // +1 so the span is half-open and `content.slice(start, end)` returns the passage.
  const end = haystack.offsets[lastNormalized]! + 1;

  return { start, end };
}

/**
 * Reduces a string to the digits it contains, ignoring grouping.
 *
 * Used for value presence only. Thousand separators differ between the Indian and
 * western conventions and between a table cell and the sentence that repeats it, so
 * comparing digit sequences is the check that survives both.
 */
function digitsOf(value: string): string {
  return value.replace(/[^0-9.]/g, '').replace(/\.+$/, '');
}

/**
 * Whether a passage states the claim's value.
 *
 * This is presence, not entailment in the logical sense, and the name of the enum member
 * it feeds should be read that way: `supported` means the cited text contains the figure
 * the claim reports. A passage can contain the figure and still be about something else,
 * which is why the model's own judgement is not the only thing standing behind an
 * accepted claim and why relationship classification re-reads the evidence itself.
 */
export function statesValue(claim: ExtractedClaim, quote: string): boolean {
  const value = claim.numeric_value ?? claim.raw_value;
  if (value === null) return false;

  const wanted = digitsOf(value);
  if (wanted === '') return false;

  return digitsOf(quote).includes(wanted);
}

/**
 * Whether a passage plausibly carries a non-numeric claim.
 *
 * Word overlap rather than a model call. A claim about a directorship or an address is
 * supported when the words of the assertion are in the passage; when they are not, the
 * claim is `unclear` rather than `unsupported`, because the shortfall may be nothing more
 * than the extractor having rewritten the sentence it read.
 */
export function overlapsStatement(claim: ExtractedClaim, quote: string): boolean {
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2),
    );

  const wanted = words(claim.original_statement);
  if (wanted.size === 0) return false;

  const found = words(quote);
  let shared = 0;
  for (const word of wanted) if (found.has(word)) shared += 1;

  return shared >= Math.ceil(wanted.size * 0.6);
}

export interface VerifyOptions {
  /** The document being processed. A citation outside it is `block_not_found`. */
  readonly documentId: string;
  /** Handle-to-block-id mapping for the chunk this claim came from. */
  readonly refToBlockId: ReadonlyMap<string, string>;
  /** Every block available for lookup, by id. */
  readonly blocksById: ReadonlyMap<string, EvidenceBlock>;
  /**
   * Native-text blocks by physical page, used to cross-check a claim whose only citation
   * is a model transcription. Optional: without it such claims stay `needs_review`.
   */
  readonly nativeBlocksByPage?: ReadonlyMap<number, readonly EvidenceBlock[]>;
}

/**
 * Verifies every citation on one claim and decides what the claim's status should be.
 *
 * Nothing here is thrown. Every outcome, including a wholly fabricated citation, is a
 * recorded verdict, because plan 4.3 wants unsupported claims marked and excluded rather
 * than made to fail the document that contains them.
 */
export function verifyClaim(claim: ExtractedClaim, options: VerifyOptions): ClaimVerification {
  const evidence: VerifiedEvidence[] = [];
  const seen = new Set<string>();

  for (const citedRef of claim.evidence_block_ids) {
    // A model that echoes a raw block id instead of the handle is still citing something
    // resolvable, so both forms are accepted before the citation is called invented.
    const blockId = options.refToBlockId.get(citedRef) ?? citedRef;
    const block = options.blocksById.get(blockId);

    if (block === undefined || block.documentId !== options.documentId) {
      evidence.push({
        sourceBlockId: null,
        citedRef,
        quote: claim.quote,
        quoteStart: null,
        quoteEnd: null,
        verification: 'block_not_found',
        entailment: 'unchecked',
        verificationNote:
          block === undefined
            ? 'the cited block is not part of the material this claim was extracted from'
            : 'the cited block belongs to a different document',
        supportRole: 'value',
      });
      continue;
    }

    // A claim citing the same block twice adds nothing; the unique index on
    // (claim, block, quote) would reject the second row anyway.
    if (seen.has(block.id)) continue;
    seen.add(block.id);

    const location = locateQuote(claim.quote, block.content);
    const carriesValue = statesValue(claim, claim.quote);

    if (location === null) {
      evidence.push({
        sourceBlockId: block.id,
        citedRef,
        quote: claim.quote,
        quoteStart: null,
        quoteEnd: null,
        verification: 'quote_not_found',
        entailment: 'unchecked',
        verificationNote: 'the quoted passage is not present in this block',
        supportRole: carriesValue ? 'value' : 'context',
      });
      continue;
    }

    const entailment: Entailment =
      claim.numeric_value !== null || claim.raw_value !== null
        ? carriesValue
          ? 'supported'
          : 'unsupported'
        : overlapsStatement(claim, claim.quote)
          ? 'supported'
          : 'unclear';

    evidence.push({
      sourceBlockId: block.id,
      citedRef,
      quote: claim.quote,
      quoteStart: location.start,
      quoteEnd: location.end,
      verification:
        block.extractionMethod === 'native_text' ? 'verified_native_text' : 'visual_only',
      entailment,
      verificationNote:
        block.extractionMethod === 'native_text'
          ? null
          : 'read from a model transcription of the page image, which cannot verify a claim the same model extracted',
      supportRole: carriesValue ? 'value' : 'context',
    });

    // Independence, per plan 4.3. The transcription and the claim share an author; the
    // PDF's own text layer does not, so finding the figure there is a real corroboration
    // and is recorded as its own evidence row rather than as a note on this one.
    if (block.extractionMethod === 'model_transcription' && entailment === 'supported') {
      const crossCheck = crossCheckInNativeText(claim, block.physicalPage, options);
      if (crossCheck !== null) evidence.push(crossCheck);
    }
  }

  return {
    evidence,
    ...decideClaimStatus(evidence, claim.raw_value ?? claim.numeric_value ?? 'the reported value'),
  };
}

/**
 * Looks for the claim's figure in the page's native text.
 *
 * Deliberately weaker than a quote match: the text layer of a table page is exactly the
 * garbled column soup that sent the page to the visual route in the first place, so the
 * check is that the digits are present on the page, and the note says so rather than
 * claiming the passage was located.
 */
function crossCheckInNativeText(
  claim: ExtractedClaim,
  physicalPage: number,
  options: VerifyOptions,
): VerifiedEvidence | null {
  const candidates = options.nativeBlocksByPage?.get(physicalPage);
  if (candidates === undefined) return null;

  for (const candidate of candidates) {
    if (!statesValue(claim, candidate.content)) continue;

    return {
      sourceBlockId: candidate.id,
      citedRef: 'cross-check',
      quote: claim.quote,
      quoteStart: null,
      quoteEnd: null,
      verification: 'verified_native_text',
      entailment: 'supported',
      verificationNote:
        'the figure appears in this page text layer, which is independent of the transcription the claim cited',
      supportRole: 'value',
    };
  }

  return null;
}

/** The two verdicts a status decision reads. Anything carrying them can be classified. */
export interface EvidenceVerdict {
  readonly verification: Verification | 'unchecked';
  readonly entailment: Entailment;
}

/**
 * Decides a claim's status from its evidence.
 *
 * A pure function of the evidence rows, which is what lets a re-extraction converge: the
 * status is recomputed from everything stored against the claim rather than from whatever
 * the latest attempt happened to produce, so an added cross-check can lift a claim out of
 * review and a replay cannot silently lower one.
 *
 * The ordering encodes plan 4.3's requirements. A claim is accepted only on evidence the
 * model did not also write; a claim supported solely by a transcription is held for
 * review rather than rejected, because it is probably true and definitely unverified; and
 * a claim whose citations are missing or whose quoted passage does not contain the figure
 * it reports is rejected, since neither is a matter of degree.
 */
export function decideClaimStatus(
  evidence: readonly EvidenceVerdict[],
  valueLabel: string,
): { status: 'accepted' | 'needs_review' | 'rejected'; statusReason: string } {
  if (evidence.length === 0) {
    return { status: 'rejected', statusReason: 'the claim cited no evidence' };
  }

  const located = evidence.filter(
    (row) => row.verification === 'verified_native_text' || row.verification === 'visual_only',
  );

  if (located.length === 0) {
    const invented = evidence.some((row) => row.verification === 'block_not_found');
    return {
      status: 'rejected',
      statusReason: invented
        ? 'every cited block is outside the material this claim was extracted from'
        : 'the quoted passage was not found in any cited block',
    };
  }

  if (located.some((row) => row.entailment === 'unsupported')) {
    return {
      status: 'rejected',
      statusReason: `the cited passage does not state ${valueLabel}`,
    };
  }

  const nativeSupport = located.some(
    (row) => row.verification === 'verified_native_text' && row.entailment === 'supported',
  );

  if (nativeSupport) {
    return { status: 'accepted', statusReason: 'quoted passage located in the document text' };
  }

  if (located.some((row) => row.verification === 'visual_only')) {
    return {
      status: 'needs_review',
      statusReason:
        'supported only by a model transcription of the page image, which is not independent of the extraction',
    };
  }

  return {
    status: 'needs_review',
    statusReason: 'the quoted passage was located but does not clearly support the claim',
  };
}
