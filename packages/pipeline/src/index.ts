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
  BedrockClient,
  GroqClient,
  ModelError,
  SwitchingClient,
  configuredProviders,
  createModelClient,
  extractJson,
  imageContentPart,
  withRetries,
  type BedrockOptions,
  type ChatMessage,
  type GroqOptions,
  type ProviderEntry,
  type SwitchingClientOptions,
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

export {
  classifyPage,
  classifyRegion,
  describeBlock,
  describeRegion,
  isLegitimatelyEmpty,
  type ClassifyOptions,
  type PageClassification,
  type RegionClassification,
  type RegionFeatures,
  type RegionKind,
} from './parsing/classify.ts';

export { isPng, renderPage, type RenderOptions, type RenderedPage } from './parsing/render.ts';

export {
  readPrintedPageLabel,
  type PageLabelOptions,
  type PrintedPageLabel,
} from './parsing/page-label.ts';

export {
  PARSER_VERSION,
  classifyBlockType,
  persistPageBlocks,
  type BlockType,
  type PersistedPage,
} from './parsing/persist.ts';

export {
  chunkSourceBlocks,
  estimateTokens,
  type BlockRef,
  type Chunk,
  type ChunkOptions,
  type ChunkSourceBlock,
} from './parsing/chunk.ts';

export { parseDocument, parsingStage, type ParseSummary } from './parsing/stage.ts';

export {
  TRANSCRIPTION_PROMPT_VERSION,
  pagesNeedingTranscription,
  persistTranscription,
  renderTranscription,
  transcribePage,
  type Transcription,
  type TranscribeOptions,
  type TranscriptionResult,
} from './parsing/transcribe.ts';

export {
  createVisualStage,
  transcribeDocument,
  type VisualStageOptions,
  type VisualSummary,
} from './parsing/visual-stage.ts';

export {
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_RESPONSE_SCHEMA,
  assertionStatusSchema,
  extractedClaimSchema,
  extractionResponseSchema,
  parseExtraction,
  periodTypeSchema,
  qualifierSchema,
  type AssertionStatus,
  type ExtractedClaim,
  type ExtractionParse,
  type ExtractionResponse,
  type PeriodType,
  type Qualifier,
} from './extraction/contract.ts';

export {
  buildExtractionMessages,
  buildRepairMessages,
} from './extraction/prompt.ts';

export {
  extractChunk,
  type ChunkExtraction,
  type ExtractChunkOptions,
} from './extraction/extract.ts';

export {
  decideClaimStatus,
  locateQuote,
  normalizeForMatch,
  overlapsStatement,
  statesValue,
  verifyClaim,
  type ClaimVerification,
  type Entailment,
  type EvidenceBlock,
  type EvidenceVerdict,
  type QuoteLocation,
  type Verification,
  type VerifiedEvidence,
  type VerifyOptions,
} from './extraction/verify.ts';

export {
  assertionFingerprint,
  persistClaim,
  type PersistClaimOptions,
  type PersistedClaim,
} from './extraction/persist.ts';

export {
  createExtractionStage,
  extractDocument,
  selectExtractionBlocks,
  type ExtractionStageOptions,
  type ExtractionSummary,
} from './extraction/stage.ts';

export {
  compareValues,
  normalizeValue,
  parseNumeric,
  scaleRatio,
  significantDigits,
  type NormalizationStep,
  type NormalizedValue,
  type NormalizeInput,
  type ParsedNumber,
  type ValueAgreement,
  type ValueComparison,
  type ValueKind,
} from './normalize/numbers.ts';

export {
  compareContext,
  detectFiscalConvention,
  normalizeScope,
  parsePeriodLabel,
  resolvePeriod,
  type ClaimContext,
  type ContextDifference,
  type FiscalConvention,
  type ResolvedPeriod,
} from './normalize/context.ts';

export {
  normalizePredicate,
  predicateHead,
  predicateRelation,
  type PredicateComparison,
  type PredicateRelation,
} from './normalize/predicates.ts';

export {
  ENTITY_MATCH_PROMPT_VERSION,
  normalizeEntityLabel,
  resolveEntity,
  type EntityCandidate,
  type EntityResolution,
  type EntityResolutionMethod,
  type NormalizedEntityLabel,
  type ResolveEntityOptions,
} from './normalize/entities.ts';

export {
  NORMALIZATION_VERSION,
  createNormalizationStage,
  factGroupId,
  normalizeDocument,
  readFiscalConvention,
  type NormalizationStageOptions,
  type NormalizationSummary,
} from './normalize/stage.ts';

export {
  EMBEDDING_TASK_TYPE,
  EmbeddingUnavailableError,
  LocalEmbeddingProvider,
  createEmbeddingProvider,
  describeClaim,
  type ClaimDescription,
  type EmbeddingConfig,
  type EmbeddingProvider,
  type LocalEmbeddingOptions,
} from './embedding/index.ts';

export {
  CHECKS_VERSION,
  deterministicLabel,
  runDeterministicChecks,
  type ComparableClaim,
  type DeterministicChecks,
  type EntityMatch,
} from './compare/checks.ts';

export {
  ensureClaimEmbeddings,
  findCandidates,
  loadComparableClaims,
  type CandidatePair,
  type CandidateResult,
  type CandidateSource,
  type EmbeddingOutcome,
  type FindCandidatesOptions,
} from './compare/candidates.ts';

export {
  RELATIONSHIP_PROMPT_VERSION,
  buildClassificationMessages,
  classifyPair,
  relationshipLabelSchema,
  type ClassifiedRelationship,
  type ClassifyPairOptions,
  type EvidenceHandle,
  type RelationshipLabel,
} from './compare/classify.ts';

export {
  COMPARISON_METHOD_VERSION,
  compareDocument,
  createComparisonStage,
  type ComparisonStageOptions,
  type ComparisonSummary,
} from './compare/stage.ts';
