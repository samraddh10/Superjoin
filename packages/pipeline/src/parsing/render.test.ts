/**
 * Page rendering, against the real starter documents.
 *
 * The failure worth guarding here is a render that succeeds and produces nothing useful.
 * A blank canvas is still a valid PNG, and a model handed one will describe an empty page
 * rather than report an error, so these tests check that the output actually varies with
 * the page's content rather than merely that a buffer came back.
 */

import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import { PdfExtractionError } from '../pdf-text.ts';
import { isPng, renderPage } from './render.ts';

const EARNINGS_DECK = 'datasets/delhivery/03-delhivery-q4-fy24-earnings-presentation.pdf';
const ANNUAL_REPORT = 'datasets/delhivery/02-delhivery-annual-report-fy24-excerpt.pdf';

let deck: Uint8Array;
let annualReport: Uint8Array;

beforeAll(async () => {
  deck = new Uint8Array(await readFile(EARNINGS_DECK));
  annualReport = new Uint8Array(await readFile(ANNUAL_REPORT));
}, 60_000);

describe('rendering a page', () => {
  it('produces a PNG for a table page', async () => {
    // Physical page 7 of the deck is the operating-metrics table, one of the pages
    // classification routes to the visual reader.
    const rendered = await renderPage(deck, 7);

    expect(isPng(rendered.bytes)).toBe(true);
    expect(rendered.physicalPage).toBe(7);
    expect(rendered.mimeType).toBe('image/png');
    expect(rendered.bytes.byteLength).toBeGreaterThan(10_000);
  }, 60_000);

  it('renders a chart page differently from a divider', async () => {
    // The real hazard is a render that returns a blank canvas: still a valid PNG, and a
    // model handed one reports an empty page rather than a failure. A content-bearing
    // page must not encode to the same size as a near-empty one.
    const [chart, divider] = await Promise.all([renderPage(deck, 8), renderPage(deck, 17)]);

    expect(isPng(chart.bytes)).toBe(true);
    expect(isPng(divider.bytes)).toBe(true);
    expect(chart.bytes.byteLength).toBeGreaterThan(divider.bytes.byteLength);
  }, 90_000);

  it('leaves the caller buffer intact', async () => {
    // Same detachment hazard as extraction: PDF.js takes ownership of the array it is
    // given, so a second render from one buffer would otherwise see zero bytes.
    const before = deck.byteLength;
    await renderPage(deck, 5);
    expect(deck.byteLength).toBe(before);
  }, 60_000);

  it('can render twice from one buffer', async () => {
    const first = await renderPage(deck, 5);
    const second = await renderPage(deck, 7);
    expect(isPng(first.bytes)).toBe(true);
    expect(isPng(second.bytes)).toBe(true);
  }, 90_000);

  it('renders a larger image at a higher scale', async () => {
    // Financial tables carry small type, and scale is the parameter that decides whether
    // a footnote marker or a final digit survives into the image.
    const [low, high] = await Promise.all([
      renderPage(deck, 7, { scale: 1 }),
      renderPage(deck, 7, { scale: 2 }),
    ]);
    expect(high.bytes.byteLength).toBeGreaterThan(low.bytes.byteLength);
    expect(high.scale).toBe(2);
  }, 90_000);

  it('renders the two-up annual report sheet', async () => {
    // 1190pt wide rather than 595. Worth covering because it is the widest thing the
    // renderer meets and the closest to any size limit.
    const rendered = await renderPage(annualReport, 5);
    expect(isPng(rendered.bytes)).toBe(true);
  }, 60_000);
});

describe('refusing to render', () => {
  it('rejects a page index past the end of the document', async () => {
    await expect(renderPage(deck, 9999)).rejects.toThrow(PdfExtractionError);
  }, 60_000);

  it('rejects a negative page index', async () => {
    await expect(renderPage(deck, -1)).rejects.toThrow(PdfExtractionError);
  });

  it('reports an oversized render rather than sending it', async () => {
    // A request rejected for size looks, at the call site, exactly like a model that
    // failed. Catching it here says which it was, and what to do about it.
    const error = await renderPage(annualReport, 5, { scale: 3, maxBytes: 1024 }).catch(
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(PdfExtractionError);
    expect(error.message).toMatch(/above the/);
    expect(error.message).toMatch(/render it smaller/);
  }, 60_000);
});

describe('isPng', () => {
  it('recognises the PNG signature', () => {
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isPng(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false);
    expect(isPng(new Uint8Array())).toBe(false);
  });
});
