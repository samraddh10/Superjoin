/**
 * What a stage has already paid for.
 *
 * Plan 2.3 asks for a retried job to be idempotent, and the claim and relationship tables
 * already are: a replay collides with what the first attempt wrote instead of duplicating
 * it. Idempotent is not the same as free, though. A retry re-asked the model about every
 * chunk it had already read, spent the tokens again, and arrived back at rows it could
 * not change — the cost of a document was its length multiplied by its attempts.
 *
 * A row here says one chunk was extracted successfully, and under what. The identity is
 * what the answer depends on: the chunk's own text, the vocabulary shown alongside it, the
 * prompt version, and the model asked. Change any of those and the fingerprint changes,
 * the row no longer matches, and the chunk is read again — which is the point. A cache
 * that survived a prompt change would serve yesterday's reading of today's question.
 *
 * The counts are stored because the run summary has to stay truthful across a resume: a
 * second attempt that skipped forty chunks still has to report the claims and the tokens
 * those chunks cost, or the document appears to have been extracted for nothing.
 */

import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { documents } from './collections.ts';

export const chunkExtractions = pgTable(
  'chunk_extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    /**
     * Hash of everything the answer depended on: chunk text, block handles, and the
     * vocabulary rendered into the prompt beside it.
     *
     * Not the chunk index. Re-parsing a document under a new parser version renumbers its
     * chunks, and an index-keyed cache would then serve one chunk's result for another's
     * text.
     */
    chunkFingerprint: text('chunk_fingerprint').notNull(),

    /** Kept alongside the fingerprint so a stale row is legible rather than merely absent. */
    chunkIndex: integer('chunk_index').notNull(),

    promptVersion: text('prompt_version').notNull(),
    modelName: text('model_name').notNull(),

    claimsExtracted: integer('claims_extracted').notNull().default(0),
    claimsAccepted: integer('claims_accepted').notNull().default(0),
    claimsNeedingReview: integer('claims_needing_review').notNull().default(0),
    claimsRejected: integer('claims_rejected').notNull().default(0),

    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One row per chunk per prompt and model. A concurrent worker that reached the same
     * chunk collides here rather than writing a second record of one call.
     */
    uniqueIndex('chunk_extractions_identity_key').on(
      table.documentId,
      table.chunkFingerprint,
      table.promptVersion,
      table.modelName,
    ),
    index('chunk_extractions_document_idx').on(table.documentId),
  ],
);

export type ChunkExtraction = typeof chunkExtractions.$inferSelect;
export type NewChunkExtraction = typeof chunkExtractions.$inferInsert;
