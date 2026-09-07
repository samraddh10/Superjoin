/**
 * Deciding when a produced claim is the gold claim.
 *
 * Every number in the report rests on this, so the rule is written out rather than left
 * implicit in a similarity score. A produced claim matches a gold claim when all four of
 * these hold:
 *
 *   1. same document;
 *   2. the gold physical page is among the pages the claim's evidence lands on;
 *   3. the predicates are the same measure, by the pipeline's own strict relation;
 *   4. the figures are equal in base units, exactly — or both sides state no figure.
 *
 * Period and scope are deliberately *not* match conditions. They are what the pairs turn
 * on, and folding them into identity would let a claim about FY2024 satisfy a gold claim
 * about Q4 FY24 and then be scored as a correct extraction. They are reported instead as
 * context agreement on claims that already matched, so a value found with the wrong
 * period is visible as exactly that rather than as a miss or as a pass.
 *
 * Exact equality, not a tolerance. The pipeline's own rounding-interval logic decides
 * whether two *sources* agree; using it here would let the system's notion of closeness
 * grade its own extraction, and a scorer must not share a judgement with the thing it
 * scores. Gold values are recorded at source precision, so the produced value should
 * reach the same figure.
 */

import { predicateRelation } from '@superjoin/pipeline';
import { Decimal } from 'decimal.js';

import type { GoldClaim } from './goldset.ts';

/** The produced side, read out of the database and reduced to what matching needs. */
export interface ProducedClaim {
  readonly id: string;
  readonly documentId: string;
  readonly filename: string;
  readonly subject: string;
  readonly predicate: string;
  readonly numericValue: string | null;
  readonly scale: string | null;
  readonly currency: string | null;
  readonly unit: string | null;
  readonly periodLabel: string | null;
  readonly periodType: string | null;
  readonly scope: string | null;
  readonly status: 'accepted' | 'needs_review' | 'rejected';
  /** Physical pages this claim's evidence points at. */
  readonly pages: readonly number[];
  readonly evidence: readonly ProducedEvidence[];
}

export interface ProducedEvidence {
  readonly id: string;
  readonly quote: string;
  readonly blockDocumentId: string;
  readonly blockContent: string;
  readonly physicalPage: number;
  readonly verification:
    | 'verified_native_text'
    | 'visual_only'
    | 'quote_not_found'
    | 'block_not_found'
    | 'unchecked';
  readonly entailment: 'supported' | 'unsupported' | 'unclear' | 'unchecked';
}

/**
 * Scale words to their multiplier.
 *
 * Only the words the collection actually uses. An unknown scale is not silently treated
 * as one: that would turn "8,142 somethings" into agreement with "8,142 crore".
 */
const SCALE_MULTIPLIER: Record<string, string> = {
  crore: '1e7',
  lakh: '1e5',
  million: '1e6',
  billion: '1e9',
  thousand: '1e3',
};

/** The figure in base units, or null when it cannot be taken without guessing. */
export function baseUnits(
  numericValue: string | null,
  scale: string | null,
): Decimal | null {
  if (numericValue === null) return null;

  let value: Decimal;
  try {
    value = new Decimal(numericValue);
  } catch {
    return null;
  }

  if (scale === null || scale === '') return value;

  const key = scale.trim().toLowerCase();
  const multiplier = SCALE_MULTIPLIER[key];
  // An unrecognised scale word means the figure's magnitude is unknown, which is not the
  // same as the figure being unscaled.
  if (multiplier === undefined) return null;

  return value.times(new Decimal(multiplier));
}

/**
 * Whether two predicates name the same measure.
 *
 * Uses the pipeline's own relation, which returns `same` only for identical names after
 * folding. That strictness is what a scorer wants: `adjusted_ebitda` is a
 * `modifier_variant` of `ebitda` and the earnings deck reports both, so accepting the
 * looser relation would let the system satisfy a gold claim about one with the other.
 *
 * `predicateHead` is deliberately not used here. It exists to widen candidate retrieval
 * and its own documentation says it decides nothing; a head term collapses exactly the
 * distinctions this scorer is meant to catch.
 */
export function predicatesAgree(a: string, b: string): boolean {
  return predicateRelation(a, b).relation === 'same';
}

export type ValueVerdict = 'equal' | 'different' | 'incomparable' | 'both_absent';

export function compareFigures(gold: GoldClaim, produced: ProducedClaim): ValueVerdict {
  const goldValue = baseUnits(gold.numeric_value, gold.scale);
  const producedValue = baseUnits(produced.numericValue, produced.scale);

  if (gold.numeric_value === null && produced.numericValue === null) return 'both_absent';
  if (gold.numeric_value === null || produced.numericValue === null) return 'different';
  // One side carried a scale word neither side could resolve; calling that a mismatch
  // would blame extraction for a normalization gap, and calling it a match would hide one.
  if (goldValue === null || producedValue === null) return 'incomparable';

  return goldValue.equals(producedValue) ? 'equal' : 'different';
}

/** Fiscal-year labels are written both ways in these documents; neither is canonical. */
export function foldPeriodLabel(label: string | null): string | null {
  if (label === null) return null;
  const trimmed = label.trim().toUpperCase().replace(/\s+/g, '');
  // FY24 and FY2024 are the same year written two ways. Q4FY24 keeps its quarter, so a
  // quarter never folds into the year that contains it.
  return trimmed.replace(/FY(\d{2})\b/g, (_, digits: string) => `FY20${digits}`);
}

export interface MatchOutcome {
  readonly gold: GoldClaim;
  readonly produced: ProducedClaim | null;
  readonly valueVerdict: ValueVerdict | null;
  /** Whether the matched claim also carries the gold period, scope and assertion status. */
  readonly periodAgrees: boolean | null;
  readonly scopeAgrees: boolean | null;
}

/** Case- and punctuation-insensitive subject comparison, for claims with no figure. */
export function subjectsAgree(a: string, b: string): boolean {
  const fold = (text: string): string =>
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[.,]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  return fold(a) === fold(b);
}

function scopeAgrees(gold: GoldClaim, produced: ProducedClaim): boolean {
  if (gold.scope === null) return produced.scope === null || produced.scope === '';
  return (produced.scope ?? '').trim().toLowerCase() === gold.scope.trim().toLowerCase();
}

/**
 * Finds the produced claim for one gold claim, if there is one.
 *
 * When several qualify, the one whose context also agrees is preferred, so a collection
 * holding both the quarter and the year figure is not scored on whichever happened to be
 * inserted first.
 */
export function matchClaim(
  gold: GoldClaim,
  produced: readonly ProducedClaim[],
  goldDocumentOf: (documentId: string) => string | undefined,
): MatchOutcome {
  const candidates = produced.filter((claim) => {
    if (goldDocumentOf(claim.documentId) !== gold.document) return false;
    if (!claim.pages.includes(gold.physical_page)) return false;
    if (!predicatesAgree(gold.predicate, claim.predicate)) return false;

    const verdict = compareFigures(gold, claim);
    if (verdict === 'equal') return true;
    // With no figure on either side there is nothing numeric to tell two claims apart,
    // and one page of an annual report lists several directors under the same predicate.
    // The subject is what distinguishes them, so it is required only here — asking for it
    // on figure claims would fail a correct extraction over "Delhivery" against
    // "Delhivery Limited".
    if (verdict === 'both_absent') return subjectsAgree(gold.subject, claim.subject);
    return false;
  });

  if (candidates.length === 0) {
    return { gold, produced: null, valueVerdict: null, periodAgrees: null, scopeAgrees: null };
  }

  const ranked = [...candidates].sort((a, b) => {
    const score = (claim: ProducedClaim): number =>
      (foldPeriodLabel(claim.periodLabel) === foldPeriodLabel(gold.period_label) ? 2 : 0) +
      (scopeAgrees(gold, claim) ? 1 : 0);
    return score(b) - score(a);
  });

  const best = ranked[0]!;
  return {
    gold,
    produced: best,
    valueVerdict: compareFigures(gold, best),
    periodAgrees: foldPeriodLabel(best.periodLabel) === foldPeriodLabel(gold.period_label),
    scopeAgrees: scopeAgrees(gold, best),
  };
}

/**
 * Whether a quote is present in the block it cites.
 *
 * Folds only what the parser itself can legitimately change between the page and the
 * stored block: run-together whitespace, the several dash and quote characters PDFs use
 * interchangeably, and the non-breaking space. Nothing here folds digits, letters or
 * currency symbols, so a figure that does not appear cannot be matched by normalisation.
 */
export function quoteLocates(quote: string, blockContent: string): boolean {
  const fold = (text: string): string =>
    text
      .normalize('NFKC')
      .replace(/[‐-―−]/g, '-')
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/ /g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const needle = fold(quote);
  return needle !== '' && fold(blockContent).includes(needle);
}
