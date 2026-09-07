/**
 * Pins failure F1 from `docs/difficult-pages.md` against the real starter document.
 *
 * These tests assert both halves of the finding: that reading order produces the wrong
 * answer, and that horizontal position produces the right one. The first half matters
 * as much as the second. If a future change makes reading order accidentally correct on
 * this page, the mitigation stops being exercised, and the test should fail loudly
 * rather than pass for the wrong reason.
 */

import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';

import { bindToAxisLabels, columnPitch } from './axis-binding.ts';
import { extractPageText, type PageText, type PositionedText } from './pdf-text.ts';

const ANNUAL_REPORT = 'datasets/delhivery/02-delhivery-annual-report-fy24-excerpt.pdf';

/** Physical page 5, zero-based, carrying the FY20-FY24 performance charts. */
const CHART_PAGE = 5;

/**
 * Runs whose baselines are within this many points are treated as one row of a chart.
 *
 * Five, not three: a value label sitting above a shorter bar drops slightly, and
 * `(4,039)` sits 3.9pt below its two neighbours on the adjusted-EBITDA chart.
 */
const ROW_TOLERANCE_PT = 5;

function inRow(items: readonly PositionedText[], y: number, minX: number, maxX: number): PositionedText[] {
  return inBand(items, y - ROW_TOLERANCE_PT, y + ROW_TOLERANCE_PT, minX, maxX);
}

/** Where labels track the tops of bars of differing height, a row is a band, not a line. */
function inBand(
  items: readonly PositionedText[],
  minY: number,
  maxY: number,
  minX: number,
  maxX: number,
): PositionedText[] {
  return items
    .filter((item) => item.y >= minY && item.y <= maxY && item.centerX >= minX && item.centerX <= maxX)
    .sort((a, b) => a.centerX - b.centerX);
}

describe('positional extraction of doc-02 physical page 5', () => {
  let page: PageText;

  beforeAll(async () => {
    page = await extractPageText(new Uint8Array(await readFile(ANNUAL_REPORT)), CHART_PAGE);
  });

  it('can extract twice from one buffer', async () => {
    // Same detachment hazard as validation: PDF.js neuters the array it is given, so
    // without a defensive copy the second call sees zero bytes and reports the document
    // as unreadable rather than returning page 20.
    const bytes = new Uint8Array(await readFile(ANNUAL_REPORT));

    const first = await extractPageText(bytes, CHART_PAGE);
    const second = await extractPageText(bytes, 20);

    expect(first.items.length).toBeGreaterThan(0);
    expect(second.physicalPage).toBe(20);
    expect(second.items.length).toBeGreaterThan(0);
  });

  it('reports the two-up sheet geometry the annual report is laid out on', () => {
    // A4 landscape. Each physical page holds two printed pages side by side, which is
    // why a page is not a semantic unit for chunking.
    expect(page.widthPt > page.heightPt, 'expected a landscape sheet').toBe(true);
    expect(page.physicalPage).toBe(CHART_PAGE);
    expect(page.characterCount > 1000, `expected a dense page, got ${page.characterCount} characters`).toBe(true);
  });

  describe('the adjusted-EBITDA chart', () => {
    // Values sit on one baseline, the FY axis labels on another well below it.
    const VALUE_ROW_Y = 486.6;
    const LABEL_ROW_Y = 381;
    const CHART_MIN_X = 950;
    const CHART_MAX_X = 1090;

    it('emits the two adjacent values in an order that inverts the years', () => {
      const values = inRow(page.items, VALUE_ROW_Y, CHART_MIN_X, CHART_MAX_X)
        .filter((item) => /^\(\d,\d{3}\)$/.test(item.text));

      const byReadingOrder = [...values].sort((a, b) => a.readingIndex - b.readingIndex);
      expect(byReadingOrder[0]?.text).toBe('(2,533)');
      expect(byReadingOrder[1]?.text).toBe('(2,532)');

      // Pairing that sequence with the left-to-right axis gives FY20 = (2,533), which
      // is the wrong answer, and is what a linear extractor reports.
      expect(byReadingOrder[0]?.text).not.toBe('(2,532)');
    });

    it('binds each value to the correct fiscal year by horizontal position', () => {
      const labels = inRow(page.items, LABEL_ROW_Y, CHART_MIN_X, CHART_MAX_X)
        .filter((item) => /^FY\d{2}$/.test(item.text));
      const values = inRow(page.items, VALUE_ROW_Y, CHART_MIN_X, CHART_MAX_X)
        .filter((item) => /^\(\d,\d{3}\)$/.test(item.text));

      expect(labels.map((l) => l.text)).toEqual(['FY20', 'FY21', 'FY22', 'FY23', 'FY24']);

      const bound = bindToAxisLabels(values, labels);
      const mapping = new Map(bound.map((b) => [b.value.text, b.label?.text ?? null]));

      // The finding, stated as an assertion: FY20 = (2,532) and FY21 = (2,533),
      // corroborated by doc-01 physical page 43 at (2,531.93) and (2,532.83).
      expect(mapping.get('(2,532)')).toBe('FY20');
      expect(mapping.get('(2,533)')).toBe('FY21');
      expect(mapping.get('(4,039)')).toBe('FY23');

      for (const binding of bound) {
        expect(binding.ambiguous).toBe(false, `${binding.value.text}: ${binding.reason}`);
      }
    });

    it('separates the columns far enough that the binding is not a close call', () => {
      const labels = inRow(page.items, LABEL_ROW_Y, CHART_MIN_X, CHART_MAX_X)
        .filter((item) => /^FY\d{2}$/.test(item.text));

      const pitch = columnPitch(labels);
      expect(pitch !== null && pitch > 20, `expected a measurable column pitch, got ${pitch}`).toBe(true);

      const values = inRow(page.items, VALUE_ROW_Y, CHART_MIN_X, CHART_MAX_X)
        .filter((item) => /^\(\d,\d{3}\)$/.test(item.text));
      for (const binding of bindToAxisLabels(values, labels)) {
        expect(binding.deltaX < (pitch ?? 0) * 0.1, `${binding.value.text} sits ${binding.deltaX.toFixed(1)}pt from its column, which is not a clean match`).toBe(true);
      }
    });
  });

  it('emits the neighbouring chart left to right, so the inversion is local', () => {
    // The top-five-customers chart on the same page, at the same column positions, is
    // emitted in correct left-to-right order: 41.8, 42.7, 40.5, 39.1, 38.4.
    //
    // This is the sharpest part of the finding, and it goes beyond what
    // docs/difficult-pages.md records. Reading order is not uniformly wrong on chart
    // pages; it is usually right. So there is no global signal that says "this page's
    // order is untrustworthy" and no cheap heuristic that catches F1. Positional
    // binding has to be applied to every chart value unconditionally, because the one
    // case where order flips looks exactly like the cases where it does not.
    const values = inBand(page.items, 220, 250, 950, 1090).filter((item) => /^\d{2}\.\d$/.test(item.text));
    expect(values.length).toBe(5);

    const byReadingOrder = [...values].sort((a, b) => a.readingIndex - b.readingIndex);
    expect(byReadingOrder.map((item) => item.text), 'expected this chart to be emitted in column order').toEqual(['41.8', '42.7', '40.5', '39.1', '38.4']);

    // Position agrees with order here, which is the point: both routes give the same
    // answer, and only the adjusted-EBITDA chart disagrees.
    const labels = inRow(page.items, 113.5, 950, 1090).filter((item) => /^FY\d{2}$/.test(item.text));
    const mapping = new Map(bindToAxisLabels(values, labels).map((b) => [b.value.text, b.label?.text ?? null]));
    expect(mapping.get('41.8')).toBe('FY20');
    expect(mapping.get('42.7')).toBe('FY21');
  });
});
