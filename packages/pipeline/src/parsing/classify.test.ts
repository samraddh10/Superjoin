/**
 * Page classification, checked against the pages `docs/difficult-pages.md` labelled by
 * hand during Phase 0.2.
 *
 * That document is the ground truth here: it names the sparse pages, the table-heavy
 * pages and the chart pages by physical index, from a reading of the actual documents.
 * Testing against it rather than against invented fixtures is what makes these thresholds
 * a measurement instead of a guess.
 */

import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import { extractPageText } from '../pdf-text.ts';
import { classifyPage, classifyRegion, describeRegion, isLegitimatelyEmpty } from './classify.ts';
import { buildLayout, type PageLayout } from './layout.ts';

const ANNUAL_REPORT = 'datasets/delhivery/02-delhivery-annual-report-fy24-excerpt.pdf';
const EARNINGS_DECK = 'datasets/delhivery/03-delhivery-q4-fy24-earnings-presentation.pdf';
const PROSPECTUS = 'datasets/delhivery/01-delhivery-prospectus-2022-excerpt.pdf';

const bytes = new Map<string, Uint8Array>();
const layouts = new Map<string, PageLayout>();

async function layoutFor(file: string, physicalPage: number): Promise<PageLayout> {
  const key = `${file}#${physicalPage}`;
  const cached = layouts.get(key);
  if (cached !== undefined) return cached;

  let data = bytes.get(file);
  if (data === undefined) {
    data = new Uint8Array(await readFile(file));
    bytes.set(file, data);
  }

  const layout = buildLayout(await extractPageText(data, physicalPage));
  layouts.set(key, layout);
  return layout;
}

/** Pages docs/difficult-pages.md records as sparse or image-only, with their character counts. */
const SPARSE_PAGES: [string, string, number][] = [
  ['deck divider "Appendix"', EARNINGS_DECK, 17],
  ['deck divider "FY24: EBITDA profitable"', EARNINGS_DECK, 3],
  ['deck title slide', EARNINGS_DECK, 1],
  ['deck contact slide', EARNINGS_DECK, 26],
  ['annual report infographic', ANNUAL_REPORT, 8],
  ['annual report photo page', ANNUAL_REPORT, 4],
];

/** Table-heavy pages, from the routing table in docs/difficult-pages.md. */
const TABLE_PAGES: [string, string, number][] = [
  ['deck operating metrics', EARNINGS_DECK, 7],
  ['deck quarterly P&L', EARNINGS_DECK, 13],
  ['deck balance sheet', EARNINGS_DECK, 16],
  ['deck cost drivers', EARNINGS_DECK, 22],
  ['annual report MD&A', ANNUAL_REPORT, 35],
  ['prospectus key indicators', PROSPECTUS, 43],
];

/** Bar-chart pages, which failure F1 is about. */
const CHART_PAGES: [string, string, number][] = [
  ['deck chart page 8', EARNINGS_DECK, 8],
  ['deck chart page 9', EARNINGS_DECK, 9],
  ['deck chart page 21', EARNINGS_DECK, 21],
  ['annual report performance charts', ANNUAL_REPORT, 5],
];

beforeAll(async () => {
  const all = [...SPARSE_PAGES, ...TABLE_PAGES, ...CHART_PAGES];
  for (const [, file, page] of all) await layoutFor(file, page);
}, 120_000);

describe('legitimately empty pages', () => {
  it.each(SPARSE_PAGES)('treats %s as sparse, not failed', async (_label, file, page) => {
    const classification = classifyPage(await layoutFor(file, page));

    // A divider or a title slide contains no facts and never will. Calling it a failure
    // would fill the issues view with non-problems and burn retries on pages that cannot
    // yield more.
    expect(classification.kind).toBe('sparse');
    expect(isLegitimatelyEmpty(classification)).toBe(true);
  });

  it('never routes a sparse page to the visual reader', async () => {
    // Sending one would spend a model call to confirm an absence.
    for (const [, file, page] of SPARSE_PAGES) {
      const classification = classifyPage(await layoutFor(file, page));
      expect(classification.needsVisualRoute, `page ${page}`).toBe(false);
    }
  });

  it('explains why a page was called sparse', async () => {
    const classification = classifyPage(await layoutFor(EARNINGS_DECK, 17));
    expect(classification.reasons.join(' ')).toMatch(/characters across/);
  });
});

describe('structured pages', () => {
  it.each(TABLE_PAGES)('routes %s to the visual reader', async (_label, file, page) => {
    const classification = classifyPage(await layoutFor(file, page));

    // Native text does not reliably reconstruct a financial table: column-to-header
    // association is positional rather than encoded.
    expect(classification.kind).toBe('structured');
    expect(classification.needsVisualRoute).toBe(true);
  });

  it.each(CHART_PAGES)('routes %s to the visual reader', async (_label, file, page) => {
    // Chart pages carry failure F1, where a value binds to the wrong period. They need
    // the second reading at least as much as tables do.
    expect(classifyPage(await layoutFor(file, page)).needsVisualRoute).toBe(true);
  });

  it('finds the tabular half of a two-up sheet beside its narrative half', async () => {
    // Physical page 21 of the annual report is the directors' report: prose on one half,
    // a financial summary on the other. Scored as one sheet, the prose dilutes the
    // table's numeric density and the table stops looking like one.
    const classification = classifyPage(await layoutFor(ANNUAL_REPORT, 21));

    expect(classification.regions.length).toBeGreaterThan(1);
    expect(classification.kind).toBe('structured');
    expect(classification.needsVisualRoute).toBe(true);
  });

  it('states which signals fired', async () => {
    const classification = classifyPage(await layoutFor(EARNINGS_DECK, 7));
    // A routing decision should be inspectable rather than trusted.
    expect(classification.reasons.some((reason) => /bare numbers/.test(reason))).toBe(true);
  });
});

describe('narrative pages', () => {
  it('leaves a prose page off the visual route', async () => {
    // The shareholder letter: long sentences, almost no bare figures.
    const classification = classifyPage(await layoutFor(ANNUAL_REPORT, 6));
    expect(classification.kind).toBe('narrative');
    expect(classification.needsVisualRoute).toBe(false);
  });
});

describe('describeRegion', () => {
  const region = (texts: string[], xs: number[]) => ({
    index: 0,
    x0: 0,
    x1: 100,
    blocks: [
      {
        lines: texts.map((text, i) => ({
          text,
          items: [
            {
              text,
              x: xs[i] ?? 0,
              y: 100 - i * 10,
              width: 20,
              height: 10,
              centerX: (xs[i] ?? 0) + 10,
              readingIndex: i,
            },
          ],
          y: 100 - i * 10,
          x0: xs[i] ?? 0,
          x1: (xs[i] ?? 0) + 20,
          height: 10,
        })),
        text: texts.join('\n'),
        x0: 0,
        x1: 100,
        yTop: 100,
        yBottom: 0,
      },
    ],
  });

  it('counts figures written the way these documents write them', () => {
    // Parenthesised negatives, thousands separators, currency marks and percentages all
    // appear in the starter filings and all have to count as numeric.
    const features = describeRegion(region(['(1,229)', '₹8,142', '12.7%', '740'], [0, 0, 0, 0]));
    expect(features.numericRatio).toBe(1);
  });

  it('does not count a fiscal-year label as a figure', () => {
    // FY24 is a period, not a value; counting it would make every chart axis look numeric.
    expect(describeRegion(region(['FY24', 'FY23'], [0, 0])).numericRatio).toBe(0);
  });

  it('counts left edges shared by three or more runs as columns', () => {
    const features = describeRegion(region(['a', 'b', 'c', 'd'], [10, 10, 10, 90]));
    expect(features.alignedColumns).toBe(1);
  });
});

describe('classifyRegion', () => {
  it('requires two signals, so one alone does not make a region structured', () => {
    // A narrative region can quote several figures; a dense list has short runs without
    // being tabular. Either signal on its own would misroute ordinary prose.
    const numericProse = {
      index: 0,
      x0: 0,
      x1: 100,
      blocks: [
        {
          lines: Array.from({ length: 40 }, (_, i) => ({
            text: 'a sentence of ordinary narrative length goes here',
            items: [
              {
                text: 'a sentence of ordinary narrative length goes here',
                x: i * 7,
                y: 500 - i * 10,
                width: 200,
                height: 10,
                centerX: i * 7 + 100,
                readingIndex: i,
              },
            ],
            y: 500 - i * 10,
            x0: i * 7,
            x1: i * 7 + 200,
            height: 10,
          })),
          text: 'prose',
          x0: 0,
          x1: 100,
          yTop: 500,
          yBottom: 0,
        },
      ],
    };

    expect(classifyRegion(numericProse).kind).toBe('narrative');
  });
});
