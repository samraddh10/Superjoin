/**
 * Layout reconstruction: turning positioned runs into lines, columns and blocks.
 *
 * Plan section 3.1 asks for lines and blocks to be reconstructed from positions rather
 * than taken from reading order. Failure F2 in `docs/difficult-pages.md` is why. On
 * `doc-02` physical page 20, "Board of Directors" and "Key Managerial Personnel" sit side
 * by side, and PDF.js emits them interleaved, so a linear reader concludes the Chief
 * Financial Officer is a board member.
 *
 * The fix is to segment the page before assigning any reading order:
 *
 *   1. Project every run onto the x-axis and find the vertical bands no text crosses.
 *   2. Keep only bands wide enough to be real gutters, not inter-word or inter-column
 *      gaps inside a table.
 *   3. Read each region top to bottom, and the regions left to right.
 *
 * The width test in step 2 is what keeps a table intact. A table's column gaps are a
 * character or two wide; a genuine reading gutter is several times the font size. Cutting
 * a page at every empty stripe would split table rows into unrelated fragments, which is
 * a worse failure than the one being fixed.
 */

import type { PageText, PositionedText } from '../pdf-text.ts';

export interface TextLine {
  readonly text: string;
  readonly items: readonly PositionedText[];
  /** Baseline of the line, in PDF points from the bottom of the page. */
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
  /** Tallest run on the line, used as a proxy for its font size. */
  readonly height: number;
}

export interface TextBlock {
  readonly lines: readonly TextLine[];
  readonly text: string;
  readonly x0: number;
  readonly x1: number;
  readonly yTop: number;
  readonly yBottom: number;
}

export interface LayoutRegion {
  /** Left-to-right position of this region on the page, from zero. */
  readonly index: number;
  readonly x0: number;
  readonly x1: number;
  readonly blocks: readonly TextBlock[];
}

export interface Gutter {
  readonly x0: number;
  readonly x1: number;
  readonly width: number;
}

export interface PageLayout {
  readonly physicalPage: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly regions: readonly LayoutRegion[];
  readonly gutters: readonly Gutter[];
  /** Median run height on the page, the font-size proxy the thresholds are scaled to. */
  readonly medianTextHeight: number;
}

export interface LayoutOptions {
  /**
   * How many multiples of the median text height a blank vertical band must span before
   * it separates reading regions.
   *
   * Two and a half is deliberately conservative. Below about two, ordinary table column
   * gaps qualify and rows get torn apart; well above three, the two-up sheet split in
   * the annual report is the only thing that still counts, and genuine side-by-side
   * columns are merged again.
   */
  readonly gutterWidthInTextHeights?: number;
  /** Runs whose baselines differ by less than this fraction of text height are one line. */
  readonly lineToleranceInTextHeights?: number;
  /** A vertical gap larger than this many text heights starts a new block. */
  readonly blockGapInTextHeights?: number;
}

const DEFAULTS = {
  gutterWidthInTextHeights: 2.5,
  lineToleranceInTextHeights: 0.5,
  blockGapInTextHeights: 1.6,
} as const;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Finds the vertical bands that no run crosses.
 *
 * Works on a one-point-per-column occupancy map rather than by comparing every pair of
 * runs, so a dense page costs a single pass rather than a quadratic scan.
 */
export function detectGutters(
  items: readonly PositionedText[],
  widthPt: number,
  minWidthPt: number,
): Gutter[] {
  if (items.length === 0) return [];

  const width = Math.ceil(widthPt);
  const occupied = new Uint8Array(width + 2);

  for (const item of items) {
    const from = Math.max(0, Math.floor(item.x));
    const to = Math.min(width, Math.ceil(item.x + item.width));
    for (let x = from; x <= to; x += 1) occupied[x] = 1;
  }

  // The page margins are not gutters: they bound the text area rather than divide it.
  let textStart = 0;
  while (textStart <= width && occupied[textStart] !== 1) textStart += 1;
  let textEnd = width;
  while (textEnd >= 0 && occupied[textEnd] !== 1) textEnd -= 1;

  const gutters: Gutter[] = [];
  let runStart: number | null = null;

  for (let x = textStart; x <= textEnd; x += 1) {
    if (occupied[x] !== 1) {
      if (runStart === null) runStart = x;
      continue;
    }
    if (runStart !== null) {
      const gutterWidth = x - runStart;
      if (gutterWidth >= minWidthPt) gutters.push({ x0: runStart, x1: x - 1, width: gutterWidth });
      runStart = null;
    }
  }

  return gutters;
}

/** Groups runs sharing a baseline into lines, each ordered left to right. */
export function groupLines(items: readonly PositionedText[], tolerance: number): TextLine[] {
  if (items.length === 0) return [];

  // Sorted by descending y, since PDF coordinates put the top of the page at the high end.
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: PositionedText[][] = [];

  for (const item of sorted) {
    const current = groups[groups.length - 1];
    const reference = current?.[0];

    if (current !== undefined && reference !== undefined && Math.abs(reference.y - item.y) <= tolerance) {
      current.push(item);
    } else {
      groups.push([item]);
    }
  }

  return groups.map((group) => {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    return {
      // Joined with single spaces: PDF runs carry no reliable inter-word spacing, and
      // inventing one from the x-gap would be a guess embedded in the evidence text.
      text: ordered.map((item) => item.text).join(' '),
      items: ordered,
      y: ordered[0]?.y ?? 0,
      x0: Math.min(...ordered.map((item) => item.x)),
      x1: Math.max(...ordered.map((item) => item.x + item.width)),
      height: Math.max(...ordered.map((item) => item.height)),
    };
  });
}

/** Splits a region's lines into blocks wherever the vertical gap widens. */
function buildBlocks(lines: readonly TextLine[], maxGap: number): TextBlock[] {
  if (lines.length === 0) return [];

  const blocks: TextBlock[] = [];
  let current: TextLine[] = [];

  const flush = () => {
    if (current.length === 0) return;
    blocks.push({
      lines: current,
      text: current.map((line) => line.text).join('\n'),
      x0: Math.min(...current.map((line) => line.x0)),
      x1: Math.max(...current.map((line) => line.x1)),
      yTop: Math.max(...current.map((line) => line.y)),
      yBottom: Math.min(...current.map((line) => line.y)),
    });
    current = [];
  };

  for (const line of lines) {
    const previous = current[current.length - 1];
    if (previous !== undefined && previous.y - line.y > maxGap) flush();
    current.push(line);
  }
  flush();

  return blocks;
}

/**
 * Reconstructs a page's reading structure.
 *
 * Regions are returned left to right and their blocks top to bottom, which is the order a
 * reader would follow and is not the order PDF.js emitted.
 */
export function buildLayout(page: PageText, options: LayoutOptions = {}): PageLayout {
  const gutterFactor = options.gutterWidthInTextHeights ?? DEFAULTS.gutterWidthInTextHeights;
  const lineFactor = options.lineToleranceInTextHeights ?? DEFAULTS.lineToleranceInTextHeights;
  const blockFactor = options.blockGapInTextHeights ?? DEFAULTS.blockGapInTextHeights;

  const heights = page.items.map((item) => item.height).filter((height) => height > 0);
  // Ten points is a plausible body size and only matters when a page reports no heights
  // at all, which would otherwise collapse every threshold to zero and split everything.
  const textHeight = median(heights) || 10;

  const gutters = detectGutters(page.items, page.widthPt, textHeight * gutterFactor);

  // Region boundaries are the gutter midpoints, so a run sitting inside a gutter's edge
  // still lands on the side it visually belongs to.
  const boundaries = gutters.map((gutter) => (gutter.x0 + gutter.x1) / 2);
  const edges = [Number.NEGATIVE_INFINITY, ...boundaries, Number.POSITIVE_INFINITY];

  const regions: LayoutRegion[] = [];

  for (let index = 0; index < edges.length - 1; index += 1) {
    const from = edges[index]!;
    const to = edges[index + 1]!;
    const members = page.items.filter((item) => {
      const centre = item.centerX;
      return centre >= from && centre < to;
    });

    if (members.length === 0) continue;

    const lines = groupLines(members, textHeight * lineFactor);
    regions.push({
      index: regions.length,
      x0: Math.min(...members.map((item) => item.x)),
      x1: Math.max(...members.map((item) => item.x + item.width)),
      blocks: buildBlocks(lines, textHeight * blockFactor),
    });
  }

  return {
    physicalPage: page.physicalPage,
    widthPt: page.widthPt,
    heightPt: page.heightPt,
    regions,
    gutters,
    medianTextHeight: textHeight,
  };
}

/**
 * The page's text in reconstructed reading order.
 *
 * This is what should be shown or chunked, in contrast to `toReadingOrderText`, which
 * reproduces the emission order that causes F1 and F2 and exists only to demonstrate them.
 */
export function toLayoutText(layout: PageLayout): string {
  return layout.regions
    .map((region) => region.blocks.map((block) => block.text).join('\n\n'))
    .join('\n\n');
}
