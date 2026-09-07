/**
 * Processing issues.
 *
 * Defined after the tables it points at, so the affected source block and claim carry
 * real foreign keys rather than loose identifiers.
 *
 * Issues are kept, never deleted. Acceptance requires a real observed failure to be
 * shown in the interface with how the system handled it, and this table is where that
 * evidence lives; a tidy-up that removed resolved issues would remove the record.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { claims } from './claims.ts';
import { issueResolution, runStage } from './enums.ts';
import { processingRuns } from './processing.ts';
import { sourceBlocks } from './sources.ts';

export const processingIssues = pgTable(
  'processing_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => processingRuns.id, { onDelete: 'cascade' }),

    stage: runStage('stage').notNull(),

    /**
     * Open vocabulary rather than an enum: failure kinds accumulate as the system meets
     * new documents, and a new kind must not require a migration.
     */
    failureKind: text('failure_kind').notNull(),

    /**
     * Whether a retry could plausibly succeed.
     *
     * Plan 2.3 requires transient provider failures to be told apart from an invalid
     * PDF, which no number of retries will fix. Nullable because the distinction is
     * sometimes not yet known when the issue is first recorded.
     */
    isTransient: boolean('is_transient'),

    /** What the issue is about. All optional: a failure can precede having any of them. */
    physicalPage: integer('physical_page'),
    sourceBlockId: uuid('source_block_id').references(() => sourceBlocks.id, {
      onDelete: 'set null',
    }),
    claimId: uuid('claim_id').references(() => claims.id, { onDelete: 'set null' }),

    message: text('message').notNull(),
    /** Provider error codes, stack context, retry timings: whatever aids diagnosis. */
    detail: jsonb('detail'),

    attemptCount: integer('attempt_count').notNull().default(1),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),

    resolution: issueResolution('resolution').notNull().default('open'),
    resolutionNote: text('resolution_note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('processing_issues_run_idx').on(table.runId),
    index('processing_issues_resolution_idx').on(table.resolution),
    index('processing_issues_kind_idx').on(table.failureKind),
  ],
);

export type ProcessingIssue = typeof processingIssues.$inferSelect;
export type NewProcessingIssue = typeof processingIssues.$inferInsert;
