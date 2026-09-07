/**
 * Shared API contracts.
 *
 * Zod schemas are the single definition of each shape: Fastify validates against them and
 * TypeScript types are inferred from them, so a route and its type cannot drift apart.
 * Plan section 4.1 will reuse the same approach for the extraction contract, where the
 * schema is also handed to Gemini and the response re-parsed before it is trusted.
 *
 * Nothing here imports a database client. These types cross the wire and are the only
 * part of the system the web app is allowed to depend on.
 */

import { z } from 'zod';

/** Processing stages, mirroring the run_stage enum in the database. See plan 2.2. */
export const runStageSchema = z.enum([
  'queued',
  'parsing',
  'extracting',
  'normalizing',
  'comparing',
  'completed',
  'completed_with_issues',
  'failed',
]);
export type RunStage = z.infer<typeof runStageSchema>;

/** Stages from which no further transition happens without a retry. */
export const TERMINAL_STAGES: readonly RunStage[] = ['completed', 'completed_with_issues', 'failed'];

export function isTerminal(stage: RunStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/** Why an upload was refused. Mirrors RejectionReason in the pipeline. */
export const rejectionReasonSchema = z.enum([
  'empty_file',
  'too_large',
  'not_a_pdf',
  'encrypted',
  'malformed',
  'no_pages',
  'too_many_pages',
]);
export type RejectionReasonContract = z.infer<typeof rejectionReasonSchema>;

export const createCollectionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});
export type CreateCollectionRequest = z.infer<typeof createCollectionSchema>;

export const collectionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
});
export type CollectionResponse = z.infer<typeof collectionSchema>;

/**
 * The result of one uploaded file.
 *
 * A single request may carry several PDFs, and they can land differently: one accepted,
 * one a duplicate, one rejected. Reporting per file rather than per request is what lets
 * the caller see which is which instead of getting one verdict for the batch.
 */
export const uploadResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('accepted'),
    filename: z.string(),
    documentId: z.uuid(),
    runId: z.uuid(),
    contentHash: z.string(),
    pageCount: z.number().int().positive(),
  }),
  z.object({
    status: z.literal('duplicate'),
    filename: z.string(),
    documentId: z.uuid(),
    contentHash: z.string(),
    /** The name the document was first uploaded under, so the caller can point at it. */
    existingFilename: z.string(),
  }),
  z.object({
    status: z.literal('rejected'),
    filename: z.string(),
    reason: rejectionReasonSchema,
    message: z.string(),
  }),
]);
export type UploadResult = z.infer<typeof uploadResultSchema>;

export const uploadResponseSchema = z.object({
  collectionId: z.uuid(),
  results: z.array(uploadResultSchema),
});
export type UploadResponse = z.infer<typeof uploadResponseSchema>;

/** Counts backing the progress display. Stored in Postgres so they survive a restart. */
export const runProgressSchema = z.object({
  pagesTotal: z.number().int().nullable(),
  pagesProcessed: z.number().int(),
  chunksTotal: z.number().int().nullable(),
  chunksProcessed: z.number().int(),
  claimsExtracted: z.number().int(),
  claimsAccepted: z.number().int(),
  relationshipsCreated: z.number().int(),
});
export type RunProgress = z.infer<typeof runProgressSchema>;

export const processingIssueSchema = z.object({
  id: z.uuid(),
  stage: runStageSchema,
  failureKind: z.string(),
  isTransient: z.boolean().nullable(),
  physicalPage: z.number().int().nullable(),
  message: z.string(),
  attemptCount: z.number().int(),
  resolution: z.enum(['open', 'retrying', 'resolved', 'abandoned']),
});
export type ProcessingIssueResponse = z.infer<typeof processingIssueSchema>;

export const runStatusSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  filename: z.string(),
  stage: runStageSchema,
  /** True once no further transition will happen without an explicit retry. */
  terminal: z.boolean(),
  progress: runProgressSchema,
  errorSummary: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  /**
   * Whether the run looks stalled: not terminal, but nothing has touched it recently.
   * Plan 2.3 requires interrupted work to be visibly recoverable rather than silently
   * stuck, and a caller cannot infer this from the stage alone.
   */
  stalled: z.boolean(),
  issues: z.array(processingIssueSchema),
});
export type RunStatus = z.infer<typeof runStatusSchema>;

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
