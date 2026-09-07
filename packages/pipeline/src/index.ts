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

export {
  checkStorageHealth,
  contentHash,
  documentStorageKey,
  ensureStorage,
  objectExists,
  pageImageStorageKey,
  readObject,
  resolvePath,
  writeObject,
  StorageError,
  type StorageHealth,
} from './storage.ts';

export {
  checkReadiness,
  type DependencyStatus,
  type Readiness,
} from './readiness.ts';

export {
  classifyOpenError,
  limitsFromConfig,
  validateUpload,
  type RejectionReason,
  type ValidationLimits,
  type ValidationResult,
} from './validation.ts';

export {
  DOCUMENT_QUEUE,
  DEFAULT_QUEUE_POLICY,
  createQueueClient,
  enqueueDocumentJob,
  startQueue,
  type DocumentJob,
  type QueuePolicy,
} from './queue.ts';

export {
  ingestDocument,
  type IngestionContext,
  type IngestionOutcome,
  type IngestionRequest,
} from './ingestion.ts';

export {
  abandonIssue,
  beginRun,
  enterStage,
  finishRun,
  heartbeat,
  recordIssue,
  recordProgress,
  resolveOpenIssues,
  type FailureClass,
  type FailureRecord,
  type ProgressUpdate,
  type RunStage,
} from './run-state.ts';

export {
  ProcessingError,
  classifyFailure,
  processDocumentJob,
  type ProcessingContext,
  type ProcessingOutcome,
  type ProcessorOptions,
  type StageHandler,
} from './processor.ts';

export {
  ModelError,
  OpenRouterClient,
  RecordingClient,
  SavedOutputClient,
  createModelClient,
  extractJson,
  imageContentPart,
  requestFingerprint,
  type ChatMessage,
  type CompletionProvider,
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
  type ModelClientConfig,
} from './model/index.ts';

export {
  buildLayout,
  detectGutters,
  groupLines,
  toLayoutText,
  type Gutter,
  type LayoutOptions,
  type LayoutRegion,
  type PageLayout,
  type TextBlock,
  type TextLine,
} from './parsing/layout.ts';
