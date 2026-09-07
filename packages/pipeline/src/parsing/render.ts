/**
 * Rendering a physical page to a PNG.
 *
 * Plan section 3.1 routes table-heavy, scanned or garbled pages through the multimodal
 * model, which needs an image of the page. The rendered image is also evidence in its own
 * right: plan 3.1 requires the original page image and raw text to be kept, so a reviewer
 * can see what the model was actually shown rather than only what it reported.
 *
 * Scale is the one parameter that matters here. Financial tables carry small type, and a
 * page rendered at its native 1.0 is often illegible to a vision model at exactly the
 * places that matter, the footnote markers and the last significant digit. Rendering
 * larger costs tokens on every call, so the default is a compromise rather than a maximum.
 */

import { renderPageAsImage } from 'unpdf';

import { PdfExtractionError } from '../pdf-text.ts';

export interface RenderOptions {
  /**
   * Multiplier on the page's natural size.
   *
   * Two is roughly 150 DPI for a standard page, which keeps a 7pt footnote readable
   * without doubling the image tokens again. Raise it for a page the model misreads;
   * lower it if a page is large enough to approach the request size limit.
   */
  readonly scale?: number;
  /**
   * Hard ceiling on the encoded image, in bytes.
   *
   * A rendered two-up spread at a high scale can exceed what a provider will accept, and
   * a request rejected for size is indistinguishable at the call site from a model that
   * simply failed. Checking here turns that into a specific, actionable error.
   */
  readonly maxBytes?: number;
}

const DEFAULTS = {
  scale: 2,
  // Comfortably under typical provider limits once base64 expands it by about a third.
  maxBytes: 4 * 1024 * 1024,
} as const;

export interface RenderedPage {
  /** Zero-based physical page index, matching every other reference to this page. */
  readonly physicalPage: number;
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/png';
  readonly scale: number;
}

/**
 * Renders one page.
 *
 * Takes a copy of the caller's bytes for the same reason extraction does: PDF.js takes
 * ownership of the buffer it is handed and detaches it, so passing the original would
 * leave the caller holding nothing.
 */
export async function renderPage(
  bytes: Uint8Array,
  physicalPage: number,
  options: RenderOptions = {},
): Promise<RenderedPage> {
  if (!Number.isInteger(physicalPage) || physicalPage < 0) {
    throw new PdfExtractionError(
      `physicalPage must be a non-negative integer, got ${physicalPage}`,
    );
  }

  const scale = options.scale ?? DEFAULTS.scale;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;

  let image: ArrayBuffer;
  try {
    // PDF.js numbers pages from one; the conversion happens here so no caller repeats it.
    image = await renderPageAsImage(new Uint8Array(bytes), physicalPage + 1, {
      scale,
      canvasImport: () => import('@napi-rs/canvas'),
    });
  } catch (cause) {
    throw new PdfExtractionError(
      `could not render physical page ${physicalPage}: ${(cause as Error).message}`,
      { cause },
    );
  }

  const rendered = new Uint8Array(image);

  if (rendered.byteLength > maxBytes) {
    throw new PdfExtractionError(
      `rendered page ${physicalPage} is ${(rendered.byteLength / 1024 / 1024).toFixed(1)}MB at scale ${scale}, above the ${(maxBytes / 1024 / 1024).toFixed(1)}MB limit; render it smaller`,
    );
  }

  return { physicalPage, bytes: rendered, mimeType: 'image/png', scale };
}

/** PNG magic bytes, so a caller can tell a real render from an empty buffer. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}
