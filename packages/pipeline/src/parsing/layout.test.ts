/**
 * Layout reconstruction, pinned against the real starter documents.
 *
 * The central case is failure F2 from `docs/difficult-pages.md`: on `doc-02` physical
 * page 20 a linear reader concludes the Chief Financial Officer is a board member. These
 * tests assert both that the raw emission order really does produce that error, and that
 * the reconstructed layout does not. If a future change makes emission order accidentally
 * correct here, the first assertion fails rather than the mitigation quietly ceasing to
 * matter.
 */

import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import { extractPageText, toReadingOrderText, type PageText } from '../pdf-text.ts';
import { buildLayout, detectGutters, groupLines, toLayoutText } from './layout.ts';

const ANNUAL_REPORT = 'datasets/delhivery/02-delhivery-annual-report-fy24-excerpt.pdf';
const EARNINGS_DECK = 'datasets/delhivery/03-delhivery-q4-fy24-earnings-presentation.pdf';

/** Physical page 20: "Board of Directors" beside "Key Managerial Personnel". */
const BOARD_PAGE = 20;

let boardPage: PageText;
let deckPage: PageText;

beforeAll(async () => {
  const annualReport = new Uint8Array(await readFile(ANNUAL_REPORT));
  boardPage = await extractPageText(annualReport, BOARD_PAGE);
  deckPage = await extractPageText(new Uint8Array(await readFile(EARNINGS_DECK)), 5);
}, 60_000);

describe('failure F2: side-by-side lists', () => {
  it('confirms emission order interleaves the two lists', () => {
    const linear = toReadingOrderText(boardPage);

    // Amit Agarwal is the Chief Financial Officer and appears in the right-hand column.
    // In emission order he lands between two directors, which is what makes a linear
    // extractor assert that the CFO sits on the board.
    const aruna = linear.indexOf('Aruna Sundararajan');
    const amit = linear.indexOf('Amit Agarwal');
    const saugata = linear.indexOf('Saugata Gupta');

    expect(aruna).toBeGreaterThan(-1);
    expect(amit).toBeGreaterThan(-1);
    expect(saugata).toBeGreaterThan(-1);
    expect(amit).toBeGreaterThan(aruna);
    expect(amit).toBeLessThan(saugata);
  });

  it('separates the board from the key managerial personnel', () => {
    const layout = buildLayout(boardPage);

    // The annual report is printed two pages to a sheet, so the page splits in half.
    expect(layout.regions.length).toBeGreaterThanOrEqual(2);

    const regionOf = (name: string) =>
      layout.regions.findIndex((region) =>
        region.blocks.some((block) => block.text.includes(name)),
      );

    const directors = ['Deepak Kapoor', 'Aruna Sundararajan', 'Saugata Gupta', 'Romesh Sobti'];
    const personnel = ['Amit Agarwal', 'Suraj Saharan', 'Madhulika Rawat'];

    const directorRegions = new Set(directors.map(regionOf));
    const personnelRegions = new Set(personnel.map(regionOf));

    expect(directorRegions.has(-1)).toBe(false);
    expect(personnelRegions.has(-1)).toBe(false);
    // Every director on one side, every officer on the other, and the two sides distinct.
    expect(directorRegions.size).toBe(1);
    expect(personnelRegions.size).toBe(1);
    expect([...directorRegions][0]).not.toBe([...personnelRegions][0]);
  });

  it('no longer places the CFO between two directors', () => {
    const text = toLayoutText(buildLayout(boardPage));

    const aruna = text.indexOf('Aruna Sundararajan');
    const amit = text.indexOf('Amit Agarwal');
    const saugata = text.indexOf('Saugata Gupta');

    // The specific wrong reading is gone: Amit Agarwal now falls outside the run of
    // director entries rather than inside it.
    expect(amit > aruna && amit < saugata).toBe(false);
  });

  it('finds the two-up sheet split as the widest gutter', () => {
    const layout = buildLayout(boardPage);
    const widest = [...layout.gutters].sort((a, b) => b.width - a.width)[0];

    expect(widest).toBeDefined();
    // The sheet is 1190pt wide, so the split sits near the middle.
    expect(widest!.x0).toBeGreaterThan(layout.widthPt * 0.35);
    expect(widest!.x1).toBeLessThan(layout.widthPt * 0.65);
    expect(widest!.width).toBeGreaterThan(50);
  });
});

describe('single-column pages', () => {
  it('keeps a slide body in one region rather than fragmenting it', () => {
    // The deck lays each slide out as metric tiles, not columns. Splitting between them
    // would separate a figure from the caption that gives it meaning.
    const layout = buildLayout(deckPage);

    const regionOf = (needle: string) =>
      layout.regions.findIndex((region) =>
        region.blocks.some((block) => block.text.includes(needle)),
      );

    const bodyRegions = new Set(
      ['8,142', '740 Mn', '1.4 Mn Tons', 'EBITDA margin'].map(regionOf),
    );
    expect(bodyRegions.has(-1)).toBe(false);
    expect(bodyRegions.size).toBe(1);
  });

  it('isolates the printed page number from the slide body', () => {
    // The "5" sits at x=940 with an 81pt gap before it, so it separates out. That is
    // correct rather than unfortunate: plan 3.2 wants the printed page label identified
    // and stored apart from the content, and this is where such a run shows itself.
    const layout = buildLayout(deckPage);
    const marginal = layout.regions.filter((region) =>
      region.blocks.every((block) => block.text.trim().length <= 3),
    );
    expect(marginal.length).toBeGreaterThanOrEqual(1);
    expect(marginal.some((region) => region.x0 > layout.widthPt * 0.9)).toBe(true);
  });

  it('keeps the layout text readable rather than empty', () => {
    const text = toLayoutText(buildLayout(deckPage));
    expect(text.length).toBeGreaterThan(50);
    expect(text).toContain('8,142');
  });
});

describe('detectGutters', () => {
  const run = (x: number, width: number) => ({
    text: 'x',
    x,
    y: 100,
    width,
    height: 10,
    centerX: x + width / 2,
    readingIndex: 0,
  });

  it('finds the gap between two columns', () => {
    const gutters = detectGutters([run(0, 100), run(200, 100)], 300, 50);
    expect(gutters).toHaveLength(1);
    expect(gutters[0]?.width).toBeGreaterThanOrEqual(50);
  });

  it('ignores a gap narrower than the threshold', () => {
    // This is what protects table rows: their column gaps are a character or two wide,
    // and treating them as reading boundaries would tear each row into fragments.
    expect(detectGutters([run(0, 100), run(110, 100)], 300, 50)).toHaveLength(0);
  });

  it('does not report the page margins as gutters', () => {
    // The margins bound the text area; they do not divide it.
    const gutters = detectGutters([run(100, 50)], 300, 20);
    expect(gutters).toHaveLength(0);
  });

  it('returns nothing for an empty page', () => {
    expect(detectGutters([], 300, 20)).toEqual([]);
  });
});

describe('groupLines', () => {
  const run = (text: string, x: number, y: number) => ({
    text,
    x,
    y,
    width: 20,
    height: 10,
    centerX: x + 10,
    readingIndex: 0,
  });

  it('joins runs on one baseline, ordered left to right', () => {
    // Deliberately supplied out of order, since that is how PDF.js often emits them.
    const lines = groupLines([run('world', 40, 100), run('hello', 10, 100)], 5);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('hello world');
  });

  it('separates baselines further apart than the tolerance', () => {
    const lines = groupLines([run('first', 10, 100), run('second', 10, 80)], 5);
    expect(lines).toHaveLength(2);
    // Top of the page first: PDF y increases upward.
    expect(lines[0]?.text).toBe('first');
  });

  it('tolerates a small baseline drift within one line', () => {
    // Superscripts and mixed font sizes shift the baseline slightly without starting a
    // new line.
    expect(groupLines([run('a', 10, 100), run('b', 40, 98)], 5)).toHaveLength(1);
  });
});
