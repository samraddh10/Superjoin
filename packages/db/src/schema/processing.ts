/**
 * Processing runs.
 *
 * Progress lives in Postgres rather than in memory so it survives an API or worker
 * restart, which plan section 2.2 requires and section 2.3 tests.
 */

import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { documents } from './collections.ts';
import { runStage } from './enums.ts';

export const processingRuns = pgTable(
  'processing_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    stage: runStage('stage').notNull().default('queued'),

    /**
     * Versions under which this run produced its output, per plan 1.2 and 4.2.
     *
     * Results are only comparable across runs that share these. Storing them per run,
     * rather than reading them from the current build, is what makes an old run's output
     * interpretable after the code has moved on.
     */
    pipelineVersion: text('pipeline_version').notNull(),
    modelName: text('model_name'),
    promptVersion: text('prompt_version'),
    embeddingModel: text('embedding_model'),

    /** Counts for progress display and for the coverage figures Phase 8.1 reports. */
    pagesTotal: integer('pages_total'),
    pagesProcessed: integer('pages_processed').notNull().default(0),
    chunksTotal: integer('chunks_total'),
    chunksProcessed: integer('chunks_processed').notNull().default(0),
    claimsExtracted: integer('claims_extracted').notNull().default(0),
    claimsAccepted: integer('claims_accepted').notNull().default(0),
    relationshipsCreated: integer('relationships_created').notNull().default(0),

    /** Token use and latency, so Phase 8.1 can report cost without re-running. */
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),

    /**
     * A short human-readable summary of why a run failed or completed with issues.
     * The detail belongs in processing_issues; this is what the documents view shows.
     */
    errorSummary: text('error_summary'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /**
     * Touched by the worker as it progresses. A run that is not terminal and has not
     * been touched recently is stalled rather than working, which is the distinction
     * plan 2.3 asks to be made explicit.
     */
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('processing_runs_document_idx').on(table.documentId),
    index('processing_runs_stage_idx').on(table.stage),
  ],
);

export type ProcessingRun = typeof processingRuns.$inferSelect;
export type NewProcessingRun = typeof processingRuns.$inferInsert;
