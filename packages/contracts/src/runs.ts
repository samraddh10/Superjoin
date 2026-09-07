/**
 * Processing stages, progress and issues.
 *
 * Its own module rather than part of the barrel because the review shapes need these and
 * a barrel cannot supply them. `export *` is hoisted like any other import, so a module
 * re-exported from `index.ts` that imports back from `index.ts` is evaluated first and
 * reads its dependency mid-initialisation. Shared definitions therefore live in leaf
 * modules and `index.ts` only re-exports.
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
