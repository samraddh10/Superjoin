/**
 * Reading the page number printed on a page.
 *
 * Plan section 3.2 requires printed labels to be stored separately from the physical page
 * index and left unknown when unreliable. `docs/difficult-pages.md` explains why they can
 * never be the identifier: none of the starter PDFs expose real page labels, `doc-02`
 * prints *two* numbers on every physical sheet because it is set two pages to a sheet,
 * and the excerpts keep non-contiguous ranges so labels jump. Evidence keys off the
 * physical index; this is a convenience for a reader comparing against the original
 * filing.
 *
 * The heuristic is positional. Measured across the three documents, every printed label
 * sits in the bottom margin: centred 38pt up in the prospectus, in both bottom corners
 * 24pt up in the annual report, and bottom-right 11pt up in the deck. A label is
 * therefore a short number alone in a margin band, and anything else is declined.
 *
 * Declining is the common case and not a failure. A wrong page label sends a reviewer to
 * the wrong page of the original document, which is worse than sending them to none.
 */

import type { PageText, PositionedText } from '../pdf-text.ts';

export type LabelConfidence = 'high' | 'none';

export interface PrintedPageLabel {
  /** The label as printed, or null when none could be read confidently. */
  readonly label: string | null;
  readonly confidence: LabelConfidence;
  /** Every candidate considered, so a null result can be explained. */
  readonly candidates: readonly string[];
  readonly reason: string;
}

export interface PageLabelOptions {
  /** Fraction of page height at the top and bottom treated as margin. */
  readonly marginFraction?: number;
  /** More candidates than this in one band means a data row, not a page number. */
  readonly maxCandidates?: number;
}

const DEFAULTS = {
  // Seven per cent of an 842pt page is 59pt, comfortably clear of the deepest observed
  // label at 38pt, while staying well inside the body text.
  marginFraction: 0.07,
  maxCandidates: 2,
} as const;

/** A page number as these documents print one: one to four digits, nothing else. */
const PAGE_NUMBER = /^\d{1,4}$/;

/** Roman numerals, which front matter often uses. */
const ROMAN = /^[ivxlcdm]{1,7}$/i;

function isLabelShaped(text: string): boolean {
  return PAGE_NUMBER.test(text) || ROMAN.test(text);
}

/**
 * Reads the printed label from a page.
 *
 * Two candidates are accepted rather than rejected, because on a two-up sheet both are
 * genuine printed labels for that sheet and reporting "10-11" is more useful to a reader
 * holding the original than reporting nothing. Three or more means the band caught a
 * table row and the whole result is declined.
 */
export function readPrintedPageLabel(
  page: PageText,
  options: PageLabelOptions = {},
): PrintedPageLabel {
  const marginFraction = options.marginFraction ?? DEFAULTS.marginFraction;
  const maxCandidates = options.maxCandidates ?? DEFAULTS.maxCandidates;
  const margin = page.heightPt * marginFraction;

  const inMargin = (item: PositionedText): boolean =>
    item.y <= margin || item.y >= page.heightPt - margin;

  const candidates = page.items.filter((item) => inMargin(item) && isLabelShaped(item.text));

  if (candidates.length === 0) {
    return {
      label: null,
      confidence: 'none',
      candidates: [],
      reason: 'no short number in the top or bottom margin',
    };
  }

  if (candidates.length > maxCandidates) {
    return {
      label: null,
      confidence: 'none',
      candidates: candidates.map((item) => item.text),
      reason: `${candidates.length} numbers in the margin; a data row rather than a page number`,
    };
  }

  // Left to right, so a two-up sheet reads in the order a person sees it.
  const ordered = [...candidates].sort((a, b) => a.x - b.x).map((item) => item.text);
  const unique = [...new Set(ordered)];

  return {
    label: unique.join('-'),
    confidence: 'high',
    candidates: ordered,
    reason:
      unique.length > 1
        ? 'two printed labels on one physical sheet, which is how this document is set'
        : 'a single number alone in the margin',
  };
}
