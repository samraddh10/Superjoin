/**
 * Positioned native-text extraction.
 *
 * Reading order is not trustworthy in these documents. `docs/difficult-pages.md`
 * records two failures that follow directly from relying on it: chart values bind to
 * the wrong period (F1), and side-by-side columns interleave into one list (F2). Both
 * are recoverable from geometry, so every extracted run keeps its coordinates and the
 * order it was emitted in. Downstream code binds on coordinates; `readingIndex` is
 * retained only so that a failure caused by reading order can be demonstrated rather
 * than merely asserted.
 *
 * Coordinates are PDF user-space points with the origin at the bottom-left, which is
 * what pdf.js reports. Nothing here converts to a top-left origin: the conversion is a
 * rendering concern, and doing it at extraction time would silently disagree with the
 * viewport used to display a page.
 */

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** A single run of text as the PDF laid it out, with the geometry needed to place it. */
export interface PositionedText {
  readonly text: string;
  /** Left edge of the run, in PDF points from the left of the page. */
  readonly x: number;
  /** Text baseline, in PDF points from the bottom of the page. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Horizontal midpoint. Charts centre values over their columns, so this binds better than the left edge. */
  readonly centerX: number;
  /** Position in the order pdf.js emitted this run. This is the order that produces failure F1. */
  readonly readingIndex: number;
}

export interface PageText {
  /** Zero-based physical page index, the identifier all evidence keys off. */
  readonly physicalPage: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly items: readonly PositionedText[];
  /** Total characters of native text, used to tell a legitimately empty page from a failed one. */
  readonly characterCount: number;
}

export class PdfExtractionError extends Error {
  override readonly name = 'PdfExtractionError';
}

/**
 * Opens a PDF from bytes.
 *
 * `useSystemFonts` is off so that extraction does not vary with the fonts that happen
 * to be installed on the host. It does not affect text position.
 *
 * The loading task is returned alongside the document because `destroy()` lives on the
 * task, not on the document, and the worker leaks if it is never called.
 */
function open(bytes: Uint8Array) {
  return getDocument({
    data: bytes,
    useSystemFonts: false,
  });
}

function toPositioned(items: readonly unknown[]): PositionedText[] {
  const positioned: PositionedText[] = [];

  for (const raw of items) {
    // Marked-content items carry no `str` and are skipped rather than treated as empty text.
    const item = raw as { str?: string; transform?: number[]; width?: number; height?: number };
    if (typeof item.str !== 'string') continue;

    const text = item.str.trim();
    if (text === '') continue;

    const transform = item.transform;
    if (transform === undefined || transform.length < 6) continue;

    const x = transform[4] ?? 0;
    const y = transform[5] ?? 0;
    const width = item.width ?? 0;

    positioned.push({
      text,
      x,
      y,
      width,
      height: item.height ?? 0,
      centerX: x + width / 2,
      // Indexed against the runs that survive filtering, so the sequence is contiguous
      // and matches what a naive linear reader would actually see.
      readingIndex: positioned.length,
    });
  }

  return positioned;
}

/**
 * Extracts one page.
 *
 * @param physicalPage Zero-based physical page index, as used throughout the project
 *   and in `evaluation/goldset.json`. pdf.js numbers pages from one; the conversion
 *   happens here so that no caller has to remember it.
 */
export async function extractPageText(bytes: Uint8Array, physicalPage: number): Promise<PageText> {
  if (!Number.isInteger(physicalPage) || physicalPage < 0) {
    throw new PdfExtractionError(`physicalPage must be a non-negative integer, got ${physicalPage}`);
  }

  const loadingTask = open(bytes);
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (cause) {
    await loadingTask.destroy();
    throw new PdfExtractionError(`could not open PDF: ${(cause as Error).message}`, { cause });
  }

  try {
    if (physicalPage >= doc.numPages) {
      throw new PdfExtractionError(
        `physical page ${physicalPage} is out of range for a ${doc.numPages}-page document`,
      );
    }

    const page = await doc.getPage(physicalPage + 1);
    try {
      const [content, viewport] = [await page.getTextContent(), page.getViewport({ scale: 1 })];
      const items = toPositioned(content.items);

      return {
        physicalPage,
        widthPt: viewport.width,
        heightPt: viewport.height,
        items,
        characterCount: items.reduce((total, item) => total + item.text.length, 0),
      };
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Joins a page's runs in reading order.
 *
 * This is the representation that fails on charts and on multi-column layouts. It
 * exists so those failures can be reproduced and shown, and must not be used as the
 * evidence for a claim.
 */
export function toReadingOrderText(page: PageText): string {
  return page.items.map((item) => item.text).join(' ');
}
