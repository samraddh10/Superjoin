/**
 * Claims, their evidence and their embeddings.
 *
 * The governing rule, from plan section 1.2: a claim records what one document says, and
 * is never overwritten because another document disagrees. Disagreement is represented by
 * two claims and a relationship between them, never by editing either one.
 *
 * Field names follow `evaluation/goldset.json`, which is the evaluation contract this
 * schema has to be scorable against.
 */

import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

import { documents } from './collections.ts';
import { claimStatus, evidenceEntailment, evidenceVerification } from './enums.ts';
import { entities, factGroups } from './entities.ts';
import { processingRuns } from './processing.ts';
import { sourceBlocks } from './sources.ts';

export const claims = pgTable(
  'claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => processingRuns.id, { onDelete: 'set null' }),

    /** Null until Phase 5 resolves the subject to an entity. Unresolved is a valid state. */
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'set null' }),
    /** Null until Phase 5 groups this claim with others asserting the same fact. */
    factGroupId: uuid('fact_group_id').references(() => factGroups.id, { onDelete: 'set null' }),

    /** The subject exactly as the document names it, before any resolution. */
    subject: text('subject').notNull(),

    /**
     * Open predicate name. Text by requirement, not by omission: plan 1.2 states a new
     * fact type must be data rather than a new table, and plan 4.2 requires new
     * predicates instead of a fixed revenue/address/director schema.
     */
    predicate: text('predicate').notNull(),

    /** The sentence or cell as it appears in the source, preserved verbatim. */
    originalStatement: text('original_statement').notNull(),

    /** The value as written, for example "8,142 Cr" or "(1,229)". */
    rawValue: text('raw_value'),

    /**
     * The parsed value, as written, at source precision.
     *
     * NUMERIC, and read back as a string by the driver. Plan 4.1 forbids putting
     * financial values through JavaScript Number; arithmetic uses decimal.js.
     */
    numericValue: numeric('numeric_value'),

    /**
     * The same value converted to a common basis for comparison, with the conversion
     * recorded in `normalization`. Both are kept, per plan 5.1: the raw form is what the
     * document said, the normalized form is only what makes two claims comparable.
     */
    normalizedValue: numeric('normalized_value'),
    normalizedUnit: text('normalized_unit'),

    currency: text('currency'),
    /** crore, lakh, million, billion, percent, percentage_point, count, and so on. */
    scale: text('scale'),
    unit: text('unit'),

    /**
     * Significant digits in the source figure, used to judge rounding compatibility.
     *
     * Plan 5.1 requires source precision rather than one blanket tolerance: 8,142 Cr and
     * 81,415 million agree only because the first is rounded to the crore.
     */
    valuePrecision: integer('value_precision'),

    /** The period the claim is about. Distinct from the document's publication date. */
    periodLabel: text('period_label'),
    /** fiscal_year, calendar_year, quarter, as_of_date, range. */
    periodType: text('period_type'),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),

    /** consolidated, standalone, segment, geography. Open vocabulary per plan 5.2. */
    scope: text('scope'),
    /** reported, restated, estimate, forecast, pro_forma, target. */
    assertionStatus: text('assertion_status'),

    /**
     * Everything else that qualifies the claim, as data.
     *
     * JSONB so a new dimension, whether a methodology note, a revision marker or a
     * segment, can be represented without a migration. That is the extensibility plan
     * section 1.2 requires.
     */
    qualifiers: jsonb('qualifiers').notNull().default([]),

    /** What was done to reach normalizedValue, kept so the step is auditable (plan 6.4). */
    normalization: jsonb('normalization'),

    status: claimStatus('status').notNull().default('needs_review'),
    /** Why the status is what it is, especially for rejected and needs_review. */
    statusReason: text('status_reason'),

    /**
     * Stable identity for one assertion in one document, used to make re-extraction
     * idempotent. Plan 2.3 asks for uniqueness constraints that prevent duplicate claims;
     * plan 4.4 asks that repeated extraction of the same source assertion be
     * deduplicated while keeping every evidence link.
     */
    assertionFingerprint: text('assertion_fingerprint').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('claims_document_fingerprint_key').on(table.documentId, table.assertionFingerprint),
    index('claims_document_idx').on(table.documentId),
    index('claims_entity_predicate_idx').on(table.entityId, table.predicate),
    index('claims_predicate_idx').on(table.predicate),
    index('claims_status_idx').on(table.status),
    index('claims_fact_group_idx').on(table.factGroupId),
  ],
);

/**
 * Links a claim to the source block that supports it.
 *
 * A claim may have several. Plan 4.3 requires citation existence and entailment to be
 * recorded separately, so `verification` says whether the quote is really there and
 * `entailment` says whether it supports the claim. A row can be verified_native_text and
 * unsupported at once; that combination is a real finding, not a contradiction in the data.
 */
export const claimEvidence = pgTable(
  'claim_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),
    sourceBlockId: uuid('source_block_id')
      .notNull()
      .references(() => sourceBlocks.id, { onDelete: 'cascade' }),

    /** The passage as cited. Must be locatable in the block's stored text. */
    quote: text('quote').notNull(),
    /** Offsets of the quote within the block's content, when it was located. */
    quoteStart: integer('quote_start'),
    quoteEnd: integer('quote_end'),

    verification: evidenceVerification('verification').notNull().default('unchecked'),
    entailment: evidenceEntailment('entailment').notNull().default('unchecked'),
    verificationNote: text('verification_note'),

    /**
     * Whether this link supports the value itself or the context around it: the unit,
     * the row header, the footnote. Plan 4.3 requires a table value to be validated
     * together with its unit, headers and footnotes.
     */
    supportRole: text('support_role').notNull().default('value'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('claim_evidence_claim_block_quote_key').on(
      table.claimId,
      table.sourceBlockId,
      table.quote,
    ),
    index('claim_evidence_claim_idx').on(table.claimId),
    index('claim_evidence_block_idx').on(table.sourceBlockId),
  ],
);

/**
 * Claim embeddings for candidate retrieval.
 *
 * A separate table rather than a column, because plan 6.1 requires the model, dimensions
 * and task type to be recorded and forbids comparing vectors from different embedding
 * models. Keeping them as rows lets a re-embedding under a new model coexist with the old
 * one and be filtered on, instead of overwriting vectors whose provenance is then lost.
 *
 * The width must equal EMBEDDING_DIMENSIONS. Changing one without the other is a startup
 * error, which is why packages/config bounds that variable.
 */
export const claimEmbeddings = pgTable(
  'claim_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),

    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    /** SEMANTIC_SIMILARITY, per plan 6.1. Recorded because it changes what the vector means. */
    taskType: text('task_type').notNull(),

    /**
     * The text that was embedded: subject, predicate and qualifier description.
     *
     * Plan 6.1 keeps numeric values out of the embedded text so retrieval is not
     * dominated by them. Stored so it is checkable rather than assumed.
     */
    embeddedText: text('embedded_text').notNull(),

    /** Normalized, per plan 6.1, so cosine and inner product agree. */
    embedding: vector('embedding', { dimensions: 768 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('claim_embeddings_claim_model_key').on(table.claimId, table.model),
    index('claim_embeddings_model_idx').on(table.model),
  ],
);

export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
export type ClaimEvidence = typeof claimEvidence.$inferSelect;
export type NewClaimEvidence = typeof claimEvidence.$inferInsert;
export type ClaimEmbedding = typeof claimEmbeddings.$inferSelect;
export type NewClaimEmbedding = typeof claimEmbeddings.$inferInsert;
