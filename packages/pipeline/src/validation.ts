/**
 * Upload validation.
 *
 * Plan section 2.1 requires the file signature, readable PDF structure, size and page
 * limit to be checked, and encrypted or malformed files to be reported clearly. "Clearly"
 * is the operative word: every rejection names a specific cause, because a reviewer
 * seeing only "invalid file" cannot tell a password-protected filing from a truncated
 * download, and the two need different responses.
 *
 * Checks run cheapest first, so a 60MB upload is rejected on its length before anything
 * tries to parse it.
 */

import { getDocumentProxy } from 'unpdf';

import { contentHash } from './storage.ts';

/**
 * Why an upload was refused. These are stable identifiers, safe to branch on and to show
 * in the issues view; the accompanying message is for a human and may change.
 */
export type RejectionReason =
  | 'empty_file'
  | 'too_large'
  | 'not_a_pdf'
  | 'encrypted'
  | 'malformed'
  | 'no_pages'
  | 'too_many_pages';

export interface ValidationLimits {
  readonly maxUploadBytes: number;
  readonly maxPages: number;
}

export type ValidationResult =
  | {
      readonly ok: true;
      readonly pageCount: number;
      readonly contentHash: string;
      readonly byteSize: number;
    }
  | {
      readonly ok: false;
      readonly reason: RejectionReason;
      readonly message: string;
    };

/** Builds limits from the configured megabyte and page ceilings. */
export function limitsFromConfig(maxUploadMb: number, maxPdfPages: number): ValidationLimits {
  return { maxUploadBytes: maxUploadMb * 1024 * 1024, maxPages: maxPdfPages };
}

/**
 * The PDF signature, searched within the leading bytes rather than only at offset zero.
 *
 * The specification allows a header preceded by other data, and readers accept it, so an
 * offset-zero-only check would reject files that every other tool opens.
 */
const SIGNATURE_SEARCH_WINDOW = 1024;

function hasPdfSignature(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, SIGNATURE_SEARCH_WINDOW);
  const text = new TextDecoder('latin1').decode(window);
  return text.includes('%PDF-');
}

/**
 * Maps a PDF.js open failure onto a rejection reason.
 *
 * Separated from the I/O so the mapping is testable without needing a specimen of every
 * kind of broken file. PDF.js signals a password-protected document with a distinctly
 * named exception; anything else that prevents opening is structural.
 */
export function classifyOpenError(error: unknown): {
  reason: Extract<RejectionReason, 'encrypted' | 'malformed'>;
  message: string;
} {
  const named = error as { name?: string; message?: string; code?: number };
  const name = named.name ?? '';
  const message = named.message ?? String(error);

  if (name === 'PasswordException' || /password/i.test(message)) {
    return {
      reason: 'encrypted',
      message: `the PDF is password protected and cannot be read: ${message}`,
    };
  }

  return { reason: 'malformed', message: `the PDF structure could not be read: ${message}` };
}

/**
 * Validates uploaded bytes and reports the page count and content hash on success.
 *
 * The page count comes from actually opening the document, so a file claiming to be a
 * PDF but unreadable past its header is refused here rather than at parse time, when a
 * document row would already exist.
 */
export async function validateUpload(
  bytes: Uint8Array,
  limits: ValidationLimits,
): Promise<ValidationResult> {
  if (bytes.byteLength === 0) {
    return { ok: false, reason: 'empty_file', message: 'the uploaded file is empty' };
  }

  if (bytes.byteLength > limits.maxUploadBytes) {
    const asMb = (value: number) => (value / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      reason: 'too_large',
      message: `the file is ${asMb(bytes.byteLength)}MB, above the ${asMb(limits.maxUploadBytes)}MB limit`,
    };
  }

  if (!hasPdfSignature(bytes)) {
    return {
      ok: false,
      reason: 'not_a_pdf',
      message: 'no %PDF- signature was found in the first 1024 bytes',
    };
  }

  // Measured before opening the document, because PDF.js takes ownership of the buffer
  // it is given and detaches it. Reading byteLength afterwards yields zero.
  const byteSize = bytes.byteLength;
  const hash = contentHash(bytes);

  let pageCount: number;
  try {
    // A copy, for the same reason: the caller still needs these bytes to write to
    // storage, and handing the original to PDF.js would leave it with an empty buffer.
    const document = await getDocumentProxy(new Uint8Array(bytes));
    pageCount = document.numPages;
    await document.cleanup?.();
  } catch (error) {
    const { reason, message } = classifyOpenError(error);
    return { ok: false, reason, message };
  }

  if (pageCount === 0) {
    return { ok: false, reason: 'no_pages', message: 'the PDF contains no pages' };
  }

  if (pageCount > limits.maxPages) {
    return {
      ok: false,
      reason: 'too_many_pages',
      message: `the PDF has ${pageCount} pages, above the ${limits.maxPages}-page limit`,
    };
  }

  return { ok: true, pageCount, contentHash: hash, byteSize };
}
