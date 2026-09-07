/**
 * Positioned native-text extraction, via unpdf's PDF.js build.
 *
 * Reading order is not trustworthy in these documents. `docs/difficult-pages.md`
 * records two failures that follow directly from relying on it: chart values bind to
 * the wrong period (F1), and side-by-side columns interleave into one list (F2). Both
 * are recoverable from geometry, so every extracted run keeps its coordinates and the
 * order it was emitted in. Downstream code binds on coordinates; `readingIndex` is
 * retained only so a failure caused by reading order can be demonstrated rather than
 * merely asserted.
 *
 * Plan section 3.2 requires that coordinate origin, dimensions and rotation be stored
 * alongside the text so future PDF highlights align. All three live on `PageText`.
 * Coordinates are left in PDF user space with a bottom-left origin, which is what
 * PDF.js reports; converting here would silently disagree with the viewport a viewer
 * later uses to display the page.
 */

import { getDocumentProxy } from 'unpdf';

/** The only coordinate convention this module emits. Recorded so a consumer need not assume it. */
export type CoordinateOrigin = 'bottom-left';

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
  /** Position in the order PDF.js emitted this run. This is the order that produces failure F1. */
  readonly readingIndex: number;
}

export interface PageText {
  /** Zero-based physical page index, the identifier all evidence keys off. */
  readonly physicalPage: number;
  readonly widthPt: number;
  readonly heightPt: number;
  /** Page rotation in degrees, needed to map these coordinates onto a rendered viewport. */
  readonly rotation: number;
  readonly coordinateOrigin: CoordinateOrigin;
  readonly items: readonly PositionedText[];
  /** Total characters of native text, used to tell a legitimately empty page from a failed one. */
  readonly characterCount: number;
}

export class PdfExtractionError extends Error {
  override readonly name = 'PdfExtractionError';
}

/** Shape of a PDF.js text item. Narrowed locally so marked-content items are skipped, not coerced. */
interface RawTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

function toPositioned(items: readonly unknown[]): PositionedText[] {
  const positioned: PositionedText[] = [];

  for (const raw of items) {
    const item = raw as RawTextItem;
    // Marked-content items carry no `str`; they are structural, not text.
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
 * Opens a document from a copy of the caller's bytes.
 *
 * PDF.js takes ownership of the buffer it is handed and detaches it, so passing the
 * original would leave the caller holding an empty Uint8Array. That failure is silent:
 * a second extractPageText call on the same buffer sees zero bytes and reports a
 * malformed PDF rather than the page it was asked for.
 */
async function openDocument(bytes: Uint8Array) {
  try {
    return await getDocumentProxy(new Uint8Array(bytes));
  } catch (cause) {
    throw new PdfExtractionError(`could not open PDF: ${(cause as Error).message}`, { cause });
  }
}

/**
 * Releases a document's resources.
 *
 * unpdf returns the document proxy rather than the loading task that owns `destroy()`,
 * so the proxy's own `cleanup()` is what is available. Failing to release must not mask
 * a real extraction error, so this never throws.
 */
async function release(doc: { cleanup?: () => unknown }): Promise<void> {
  try {
    await doc.cleanup?.();
  } catch {
    // Nothing actionable: the page data has already been read.
  }
}

/**
 * Extracts one page.
 *
 * @param physicalPage Zero-based physical page index, as used throughout the project
 *   and in `evaluation/goldset.json`. PDF.js numbers pages from one; the conversion
 *   happens here so no caller has to remember it.
 */
export async function extractPageText(bytes: Uint8Array, physicalPage: number): Promise<PageText> {
  if (!Number.isInteger(physicalPage) || physicalPage < 0) {
    throw new PdfExtractionError(`physicalPage must be a non-negative integer, got ${physicalPage}`);
  }

  const doc = await openDocument(bytes);
  try {
    if (physicalPage >= doc.numPages) {
      throw new PdfExtractionError(
        `physical page ${physicalPage} is out of range for a ${doc.numPages}-page document`,
      );
    }

    const page = await doc.getPage(physicalPage + 1);
    try {
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });
      const items = toPositioned(content.items);

      return {
        physicalPage,
        widthPt: viewport.width,
        heightPt: viewport.height,
        rotation: viewport.rotation,
        coordinateOrigin: 'bottom-left',
        items,
        characterCount: items.reduce((total, item) => total + item.text.length, 0),
      };
    } finally {
      page.cleanup();
    }
  } finally {
    await release(doc);
  }
}

/** Number of physical pages, read without extracting any text. */
export async function countPages(bytes: Uint8Array): Promise<number> {
  const doc = await openDocument(bytes);
  try {
    return doc.numPages;
  } finally {
    await release(doc);
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
