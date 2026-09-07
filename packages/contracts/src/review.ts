/**
 * Wire shapes for the review interface: documents, facts, evidence and relationships.
 *
 * These are the read side of plan section 7.1. Two rules shape almost every field here.
 *
 * The first is from plan 6.4: a relationship never replaces conflicting values with an
 * invented single truth, and nothing model-generated is presented as a calibrated
 * probability. So a relationship carries both claims whole, and carries no score.
 *
 * The second is from plan 4.3: citation existence and entailment are separate questions.
 * Every evidence item therefore reports `verification` and `entailment` independently,
 * and the interface has to be able to show a quote that is genuinely present in the
 * source and still fails to support the claim attached to it.
 */

import { z } from 'zod';

import { processingIssueSchema, runStageSchema } from './runs.ts';

/** Mirrors the claim_status enum. `needs_review` is a real outcome, not a lesser failure. */
export const claimStatusSchema = z.enum(['accepted', 'needs_review', 'rejected']);
export type ClaimStatusContract = z.infer<typeof claimStatusSchema>;

/** Whether the cited passage was found in the stored source. Citation existence only. */
export const evidenceVerificationSchema = z.enum([
  'verified_native_text',
  'visual_only',
  'quote_not_found',
  'block_not_found',
  'unchecked',
]);
export type EvidenceVerificationContract = z.infer<typeof evidenceVerificationSchema>;

/** Whether the located passage supports the claim. Independent of whether it exists. */
export const evidenceEntailmentSchema = z.enum([
  'supported',
  'unsupported',
  'unclear',
  'unchecked',
]);
export type EvidenceEntailmentContract = z.infer<typeof evidenceEntailmentSchema>;

export const relationshipLabelSchema = z.enum([
  'corroborates',
  'contradicts',
  'likely_contradiction',
  'reconciled_by_context',
  'insufficient_context',
  'unrelated',
]);
export type RelationshipLabelContract = z.infer<typeof relationshipLabelSchema>;

export const sourceBlockTypeSchema = z.enum([
  'paragraph',
  'heading',
  'list',
  'table',
  'table_cell',
  'chart',
  'figure',
  'caption',
  'other',
]);

export const extractionMethodSchema = z.enum(['native_text', 'model_transcription']);

/**
 * The source block a piece of evidence points at.
 *
 * `physicalPage` is the zero-based physical page index and is what the viewer navigates
 * by. `printedPageLabel` is shown beside it when known but is never used to locate a
 * page: `docs/difficult-pages.md` records that one starter document prints two labels per
 * physical sheet, so a label identifies nothing on its own.
 *
 * The geometry fields are carried per plan 3.2 so a stored box can be interpreted without
 * re-opening the PDF. Region highlighting is optional in plan 7.3; page navigation is not.
 */
export const sourceBlockRefSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  filename: z.string(),
  physicalPage: z.number().int().nonnegative(),
  printedPageLabel: z.string().nullable(),
  blockType: sourceBlockTypeSchema,
  extractionMethod: extractionMethodSchema,
  content: z.string(),
  tableHeaders: z.unknown().nullable(),
  bbox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullable(),
  coordinateOrigin: z.string(),
  pageWidthPt: z.number().nullable(),
  pageHeightPt: z.number().nullable(),
  pageRotation: z.number().int(),
  /** Set when the page was rendered for the visual route. The image is evidence too. */
  pageImageKey: z.string().nullable(),
});
export type SourceBlockRef = z.infer<typeof sourceBlockRefSchema>;

export const evidenceItemSchema = z.object({
  id: z.uuid(),
  quote: z.string(),
  quoteStart: z.number().int().nullable(),
  quoteEnd: z.number().int().nullable(),
  verification: evidenceVerificationSchema,
  entailment: evidenceEntailmentSchema,
  verificationNote: z.string().nullable(),
  /** Whether this link supports the value itself or the context around it. */
  supportRole: z.string(),
  block: sourceBlockRefSchema,
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

/**
 * A claim as listed.
 *
 * Decimal figures cross the wire as strings, per plan 4.1: putting a financial value
 * through a JavaScript number is exactly the loss the plan forbids, and JSON parsing on
 * the browser side would do it silently.
 */
export const factSummarySchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  filename: z.string(),
  subject: z.string(),
  predicate: z.string(),
  originalStatement: z.string(),
  rawValue: z.string().nullable(),
  numericValue: z.string().nullable(),
  normalizedValue: z.string().nullable(),
  normalizedUnit: z.string().nullable(),
  currency: z.string().nullable(),
  scale: z.string().nullable(),
  unit: z.string().nullable(),
  periodLabel: z.string().nullable(),
  periodType: z.string().nullable(),
  scope: z.string().nullable(),
  assertionStatus: z.string().nullable(),
  status: claimStatusSchema,
  statusReason: z.string().nullable(),
  entityId: z.uuid().nullable(),
  entityLabel: z.string().nullable(),
  /** Physical pages the claim's evidence lands on, for the list row's page hint. */
  pages: z.array(z.number().int().nonnegative()),
  evidenceCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type FactSummary = z.infer<typeof factSummarySchema>;

/**
 * A claim with everything a reviewer needs to judge it.
 *
 * `normalization` is the audit trail plan 6.4 requires: what was done to reach
 * `normalizedValue`, kept so an agreement can be seen to come from a stated conversion
 * rather than from a tolerance wide enough to swallow the difference.
 */
export const factDetailSchema = factSummarySchema.extend({
  collectionId: z.uuid(),
  runId: z.uuid().nullable(),
  factGroupId: z.uuid().nullable(),
  valuePrecision: z.number().int().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  qualifiers: z.array(z.object({ name: z.string(), value: z.string() })),
  normalization: z.unknown().nullable(),
  evidence: z.array(evidenceItemSchema),
  /** How many relationships this claim takes part in, so the detail view can link out. */
  relationshipCount: z.number().int().nonnegative(),
});
export type FactDetail = z.infer<typeof factDetailSchema>;

export const factListSchema = z.object({
  items: z.array(factSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  /** Distinct predicates present in the collection, so the filter can offer real values. */
  predicates: z.array(z.string()),
});
export type FactList = z.infer<typeof factListSchema>;

/** One context dimension on which two compared claims differ. See plan 6.2. */
export const contextDifferenceSchema = z.object({
  dimension: z.enum([
    'period',
    'period_type',
    'scope',
    'assertion_status',
    'unit',
    'currency',
    'qualifier',
  ]),
  a: z.string().nullable(),
  b: z.string().nullable(),
  /**
   * Whether this difference could account for a numerical gap. A different period could;
   * a different currency makes the figures incomparable rather than explaining them.
   */
  couldExplainGap: z.boolean(),
});
export type ContextDifferenceContract = z.infer<typeof contextDifferenceSchema>;

/**
 * A relationship as listed.
 *
 * Both claims are carried in full, evidence included, rather than as summaries. The
 * relationships view has to offer evidence inspection on either side of every pair, and
 * fetching each claim separately would be a request per row. Declaring them as summaries
 * would also be false: an object schema strips what it does not declare, so the evidence
 * the endpoint does send would be removed on arrival.
 *
 * No confidence score, per plan 6.4.
 */
export const relationshipSummarySchema = z.object({
  id: z.uuid(),
  collectionId: z.uuid(),
  label: relationshipLabelSchema,
  rationale: z.string(),
  contextDifferences: z.array(contextDifferenceSchema),
  uncertaintyReasons: z.array(z.string()),
  method: z.string(),
  methodVersion: z.string(),
  modelName: z.string().nullable(),
  promptVersion: z.string().nullable(),
  claimA: factDetailSchema,
  claimB: factDetailSchema,
  createdAt: z.string(),
});
export type RelationshipSummary = z.infer<typeof relationshipSummarySchema>;

/**
 * A relationship with both claims' evidence resolved.
 *
 * `deterministicChecks` is included because plan 6.2 makes those checks inputs to
 * classification rather than proof of either conclusion, and a reviewer cannot judge the
 * label without seeing what the classifier was given.
 */
export const relationshipDetailSchema = relationshipSummarySchema.extend({
  deterministicChecks: z.unknown().nullable(),
  /** claim_evidence ids the classifier named as justifying this label specifically. */
  supportingEvidenceIds: z.array(z.string()),
});
export type RelationshipDetail = z.infer<typeof relationshipDetailSchema>;

export const relationshipListSchema = z.object({
  items: z.array(relationshipSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  /** Count per label across the whole collection, unaffected by the current filter. */
  counts: z.record(relationshipLabelSchema, z.number().int().nonnegative()),
});
export type RelationshipList = z.infer<typeof relationshipListSchema>;

/**
 * A document with its latest run.
 *
 * The documents view needs status, pages processed, accepted facts and errors in one
 * place (plan 7.2), and the run is where all four live. Issues ride along so the failure
 * panel plan 7.3 asks for has something to show without a request per document.
 */
export const documentSummarySchema = z.object({
  id: z.uuid(),
  collectionId: z.uuid(),
  filename: z.string(),
  contentHash: z.string(),
  byteSize: z.number().int().nonnegative(),
  pageCount: z.number().int().nullable(),
  publicationDate: z.string().nullable(),
  createdAt: z.string(),
  latestRun: z
    .object({
      id: z.uuid(),
      stage: runStageSchema,
      terminal: z.boolean(),
      stalled: z.boolean(),
      pagesTotal: z.number().int().nullable(),
      pagesProcessed: z.number().int(),
      chunksTotal: z.number().int().nullable(),
      chunksProcessed: z.number().int(),
      claimsExtracted: z.number().int(),
      claimsAccepted: z.number().int(),
      relationshipsCreated: z.number().int(),
      errorSummary: z.string().nullable(),
      startedAt: z.string().nullable(),
      finishedAt: z.string().nullable(),
      issues: z.array(processingIssueSchema),
    })
    .nullable(),
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const documentListSchema = z.object({
  collectionId: z.uuid(),
  items: z.array(documentSummarySchema),
});
export type DocumentList = z.infer<typeof documentListSchema>;

/** Query parameters accepted by the facts list. Coerced, because they arrive as strings. */
export const factQuerySchema = z.object({
  documentId: z.uuid().optional(),
  entityId: z.uuid().optional(),
  predicate: z.string().min(1).max(200).optional(),
  status: claimStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type FactQuery = z.infer<typeof factQuerySchema>;

export const relationshipQuerySchema = z.object({
  label: relationshipLabelSchema.optional(),
  claimId: z.uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type RelationshipQuery = z.infer<typeof relationshipQuerySchema>;
