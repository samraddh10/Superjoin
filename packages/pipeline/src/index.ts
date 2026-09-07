/**
 * Parsing, extraction, normalization and comparison code shared by the API and worker.
 *
 * Nothing here may depend on a collection name, a filename or the ordinal prefixes in
 * the starter filenames: plan section 0.1 requires runtime processing to stay
 * independent of them.
 */

export {
  countPages,
  extractPageText,
  toReadingOrderText,
  PdfExtractionError,
  type CoordinateOrigin,
  type PageText,
  type PositionedText,
} from './pdf-text.ts';

export {
  bindToAxisLabels,
  columnPitch,
  type Binding,
  type Positioned,
} from './axis-binding.ts';
