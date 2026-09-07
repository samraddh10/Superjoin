/**
 * Page and region classification.
 *
 * Two decisions come out of this. First, which pages need the visual route that plan
 * section 3.1 describes, since native text does not reliably reconstruct financial
 * tables. Second, and just as important, whether a page that yielded almost nothing is
 * *empty* or *failed*. `docs/difficult-pages.md` lists seven starter pages that are
 * legitimately near-empty — dividers, a title slide, a contact slide, an infographic —
 * and treating those as extraction failures would fill the issues view with problems
 * that are not problems, and burn retries on pages that will never yield more.
 *
 * Classification runs per block, not per page. `doc-02` is printed two pages to a sheet,
 * so physical page 21 carries a narrative half and a tabular half; scoring the sheet as a
 * whole dilutes the table's numeric density with the prose beside it and the table stops
 * looking like one. Splitting by column is not enough either: the left half of that same
 * page runs the Directors' Report prose *above* its financial summary, and averaged
 * together the table reads as narrative. Blocks are the smallest unit layout
 * reconstruction produces that a table reliably occupies alone.
 */

import type { LayoutRegion, PageLayout, TextBlock } from './layout.ts';

export type RegionKind = 'empty' | 'sparse' | 'narrative' | 'structured';

/**
 * A number as these documents write them: thousands separators, a currency mark, a
 * trailing percent, or parentheses for negatives. `(1,229)` and `₹8,142` are values;
 * `FY24` is not.
 */
const NUMERIC = /^[₹$€£]?\s?\(?-?\d[\d,]*(\.\d+)?\)?\s?%?$/;

export interface RegionFeatures {
  readonly characterCount: number;
  readonly runCount: number;
  /** Share of runs that are bare numbers. Tables and charts run high; prose runs low. */
  readonly numericRatio: number;
  /** How many left edges are shared by three or more runs, the signature of a column. */
  readonly alignedColumns: number;
  /** Mean characters per run. Cells and axis labels are short; sentences are not. */
  readonly meanRunLength: number;
}

export interface RegionClassification {
  readonly kind: RegionKind;
  readonly features: RegionFeatures;
  /** Which signals fired, so a routing decision can be inspected rather than trusted. */
  readonly reasons: readonly string[];
}

export interface PageClassification {
  readonly physicalPage: number;
  readonly kind: RegionKind;
  readonly regions: readonly RegionClassification[];
  /**
   * Whether this page should also be read by the multimodal model.
   *
   * True for structured content, where column-to-header association is positional rather
   * than encoded and native text alone loses it. Never true merely because a page is
   * sparse: an empty page has nothing for a second reader to find either.
   */
  readonly needsVisualRoute: boolean;
  readonly characterCount: number;
  readonly reasons: readonly string[];
}

export interface ClassifyOptions {
  /** Below this many characters *and* runs, a region is sparse rather than failed. */
  readonly sparseCharacterLimit?: number;
  readonly sparseRunLimit?: number;
  readonly numericRatioThreshold?: number;
  readonly alignedColumnThreshold?: number;
  readonly meanRunLengthThreshold?: number;
}

const DEFAULTS = {
  // Calibrated on the seven pages docs/difficult-pages.md lists as legitimately sparse.
  // The densest of them, a photo page with two short narrative blocks, has 617 characters
  // across 18 runs; the thinnest real content page has 34 runs. The run count is the
  // load-bearing half of this test, since a short slide can still be a real page.
  sparseCharacterLimit: 700,
  sparseRunLimit: 25,
  numericRatioThreshold: 0.3,
  alignedColumnThreshold: 4,
  meanRunLengthThreshold: 15,
} as const;

/** Left edges within this many points are treated as the same column. */
const COLUMN_BUCKET_PT = 3;

/**
 * Below this many runs a block is too small to judge.
 *
 * A two-line caption under a figure is numeric and short and aligned, and would score as
 * a table on every signal. Requiring some bulk before the signals are consulted keeps
 * captions, headings and stray labels from routing a page to the visual reader.
 */
const MIN_RUNS_TO_JUDGE = 8;

function describeRuns(runs: readonly { text: string; x: number }[]): RegionFeatures {

  if (runs.length === 0) {
    return {
      characterCount: 0,
      runCount: 0,
      numericRatio: 0,
      alignedColumns: 0,
      meanRunLength: 0,
    };
  }

  const characterCount = runs.reduce((total, run) => total + run.text.length, 0);
  const numeric = runs.filter((run) => NUMERIC.test(run.text)).length;

  const columns = new Map<number, number>();
  for (const run of runs) {
    const bucket = Math.round(run.x / COLUMN_BUCKET_PT);
    columns.set(bucket, (columns.get(bucket) ?? 0) + 1);
  }

  return {
    characterCount,
    runCount: runs.length,
    numericRatio: numeric / runs.length,
    alignedColumns: [...columns.values()].filter((count) => count >= 3).length,
    meanRunLength: characterCount / runs.length,
  };
}

/** Features of one block, the unit a table occupies on its own. */
export function describeBlock(block: TextBlock): RegionFeatures {
  return describeRuns(block.lines.flatMap((line) => line.items));
}

/** Features of a whole region, used for the sparse test rather than for routing. */
export function describeRegion(region: LayoutRegion): RegionFeatures {
  return describeRuns(region.blocks.flatMap((block) => block.lines.flatMap((line) => line.items)));
}

/** Scores the three structural signals. Two must fire before a block counts as tabular. */
function scoreStructure(
  features: RegionFeatures,
  options: ClassifyOptions,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const numericThreshold = options.numericRatioThreshold ?? DEFAULTS.numericRatioThreshold;
  const columnThreshold = options.alignedColumnThreshold ?? DEFAULTS.alignedColumnThreshold;
  const lengthThreshold = options.meanRunLengthThreshold ?? DEFAULTS.meanRunLengthThreshold;

  let score = 0;

  if (features.numericRatio >= numericThreshold) {
    score += 1;
    reasons.push(`${Math.round(features.numericRatio * 100)}% of runs are bare numbers`);
  }
  if (features.alignedColumns >= columnThreshold) {
    score += 1;
    reasons.push(`${features.alignedColumns} left edges shared by three or more runs`);
  }
  if (features.meanRunLength <= lengthThreshold) {
    score += 1;
    reasons.push(
      `runs average ${features.meanRunLength.toFixed(1)} characters, cell-length rather than sentence-length`,
    );
  }

  return { score, reasons };
}

export function classifyRegion(
  region: LayoutRegion,
  options: ClassifyOptions = {},
): RegionClassification {
  const sparseChars = options.sparseCharacterLimit ?? DEFAULTS.sparseCharacterLimit;
  const sparseRuns = options.sparseRunLimit ?? DEFAULTS.sparseRunLimit;

  const features = describeRegion(region);

  if (features.runCount === 0) {
    return { kind: 'empty', features, reasons: ['no text runs'] };
  }

  if (features.characterCount < sparseChars && features.runCount < sparseRuns) {
    return {
      kind: 'sparse',
      features,
      reasons: [
        `only ${features.characterCount} characters across ${features.runCount} runs; a divider or title rather than a failure`,
      ],
    };
  }

  // Three independent signals, any two of which mark content as structured. No single one
  // is reliable: a narrative region can quote several figures, a chart's axis labels align
  // as neatly as a table's, and a dense list has short runs without being tabular.
  //
  // Scored at two scales, because a table hides from each one differently. Judged only by
  // block, a table whose rows are separated by wide leading fragments into row-sized
  // blocks that are each too small to read as tabular. Judged only by region, a table
  // sitting beneath prose is averaged away by the paragraphs above it, which is what
  // happens on the Directors' Report sheet. Either scale finding a table is enough.
  const { score: regionScore, reasons: regionReasons } = scoreStructure(features, options);
  if (regionScore >= 2) {
    return { kind: 'structured', features, reasons: regionReasons };
  }

  for (const block of region.blocks) {
    const blockFeatures = describeBlock(block);
    if (blockFeatures.runCount < MIN_RUNS_TO_JUDGE) continue;

    const { score, reasons: blockReasons } = scoreStructure(blockFeatures, options);
    if (score >= 2) {
      return {
        kind: 'structured',
        features,
        reasons: [`a block of ${blockFeatures.runCount} runs is tabular: ${blockReasons.join('; ')}`],
      };
    }
  }

  return {
    kind: 'narrative',
    features,
    reasons:
      regionReasons.length > 0
        ? regionReasons
        : ['prose-length runs with little numeric content'],
  };
}

/**
 * Classifies a page from its regions.
 *
 * The page takes the kind of its most demanding region: one tabular half of a two-up
 * sheet is enough to route the page to the visual reader, because the table is the part
 * that native text handles worst.
 */
export function classifyPage(layout: PageLayout, options: ClassifyOptions = {}): PageClassification {
  const regions = layout.regions.map((region) => classifyRegion(region, options));

  const characterCount = regions.reduce(
    (total, region) => total + region.features.characterCount,
    0,
  );

  if (regions.length === 0 || characterCount === 0) {
    return {
      physicalPage: layout.physicalPage,
      kind: 'empty',
      regions,
      needsVisualRoute: false,
      characterCount,
      reasons: ['the page yielded no native text'],
    };
  }

  const hasStructured = regions.some((region) => region.kind === 'structured');
  const hasNarrative = regions.some((region) => region.kind === 'narrative');

  const kind: RegionKind = hasStructured ? 'structured' : hasNarrative ? 'narrative' : 'sparse';

  return {
    physicalPage: layout.physicalPage,
    kind,
    regions,
    // Sparse pages are never routed: an empty page has nothing for a second reader to
    // find, and sending it would spend a model call to confirm an absence.
    needsVisualRoute: hasStructured,
    characterCount,
    reasons: regions.flatMap((region) => region.reasons),
  };
}

/**
 * Whether a near-empty page is a legitimate absence rather than a parsing failure.
 *
 * The distinction plan 3.1 requires. A page that is genuinely a section divider must not
 * be retried, must not raise an issue, and must not be counted against extraction
 * coverage in Phase 8.
 */
export function isLegitimatelyEmpty(classification: PageClassification): boolean {
  return classification.kind === 'empty' || classification.kind === 'sparse';
}
