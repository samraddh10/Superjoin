/**
 * Relationships between two claims.
 *
 * Plan section 6.4 governs what may be stored here. The two claims stay untouched; a
 * relationship never replaces conflicting values with an invented single truth. Nothing
 * here is a calibrated probability, so no confidence score is stored: plan 6.4 forbids
 * presenting a model-generated score as one, and the surest way not to present it is not
 * to keep it.
 */

import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { collections } from './collections.ts';
import { relationshipLabel } from './enums.ts';
import { claims } from './claims.ts';

export const relationships = pgTable(
  'relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Comparisons run within a collection (plan 0.1 and 6.1). Denormalized from the two
     * claims so the boundary is enforceable here rather than trusted to every query.
     */
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),

    claimAId: uuid('claim_a_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),
    claimBId: uuid('claim_b_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),

    label: relationshipLabel('label').notNull(),

    /** Why this label, in a sentence or two. Shown to the reviewer, never generated post hoc. */
    rationale: text('rationale').notNull(),

    /**
     * Which context dimensions differ between the two claims: period, scope, units,
     * definition, as-of date. Required by the interface, which must show them.
     */
    contextDifferences: jsonb('context_differences').notNull().default([]),

    /**
     * What kept this from a firmer label.
     *
     * Carries the residual question behind `likely_contradiction` and the reason behind
     * `insufficient_context`. Plan 6.3 makes abstention a correct answer, so the reason
     * for abstaining is data, not an absence.
     */
    uncertaintyReasons: jsonb('uncertainty_reasons').notNull().default([]),

    /**
     * Output of the deterministic checks from plan 6.2: unit conversion, interval
     * compatibility, period difference, scope mismatch, rounding interval.
     *
     * Stored because those are inputs to classification, not proof of either conclusion,
     * and a reviewer needs to see what the classifier was given.
     */
    deterministicChecks: jsonb('deterministic_checks'),

    /** claim_evidence IDs that justify this relationship specifically. */
    supportingEvidenceIds: jsonb('supporting_evidence_ids').notNull().default([]),

    /** How the label was reached: `deterministic`, `model`, `operator`. */
    method: text('method').notNull(),
    methodVersion: text('method_version').notNull(),
    modelName: text('model_name'),
    promptVersion: text('prompt_version'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One relationship per ordered claim pair per method version, so a retried
     * comparison collides instead of duplicating, per plan 2.3. Callers order the pair
     * consistently before insert; the constraint cannot express that itself.
     */
    uniqueIndex('relationships_pair_method_key').on(
      table.claimAId,
      table.claimBId,
      table.methodVersion,
    ),
    index('relationships_collection_label_idx').on(table.collectionId, table.label),
    index('relationships_claim_a_idx').on(table.claimAId),
    index('relationships_claim_b_idx').on(table.claimBId),
  ],
);

export type Relationship = typeof relationships.$inferSelect;
export type NewRelationship = typeof relationships.$inferInsert;
