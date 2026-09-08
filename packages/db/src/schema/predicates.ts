/**
 * The predicate registry.
 *
 * Plan section 9, priority 4: a registry with descriptions, aliases and units, so a new
 * fact type appears as data rather than as a SQL migration.
 *
 * It exists because open predicates have a cost that only shows up across documents. Plan
 * 4.2 requires extraction to invent predicates rather than fill a fixed schema, and it
 * duly invents them — one collection produced **1,053 distinct predicates from 1,991
 * claims**, with `revenue`, `revenue_amount`, `total_revenues` and
 * `total_revenue_from_customers` all recorded separately. Only two (entity, predicate)
 * combinations existed in more than one document, so cross-document retrieval had almost
 * nothing to match on and corroboration could not be reached at all.
 *
 * The registry is the memory that fixes that: what a collection has already called a
 * thing, offered back to extraction so the second document reuses the first document's
 * name instead of coining its own.
 *
 * Scoped to a collection, because a collection is the comparison boundary. Two unrelated
 * datasets should not teach each other vocabulary.
 */

import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { collections } from './collections.ts';

export const predicateRegistry = pgTable(
  'predicate_registry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),

    /** The name this collection has settled on, normalized. What claims should carry. */
    canonicalName: text('canonical_name').notNull(),

    /**
     * One line on what the measure is, shown to extraction so it can tell whether an
     * existing predicate fits rather than guessing from the name alone.
     */
    description: text('description'),

    /**
     * Other names seen for the same measure.
     *
     * Recorded rather than discarded: a claim already extracted under `total_revenues`
     * keeps the words the document used, and the alias is how retrieval knows that name
     * points here. Adding one is data, which is the point of the registry.
     */
    aliases: jsonb('aliases').notNull().default([]),

    /** The unit or currency this measure is usually stated in, when it is consistent. */
    unitHint: text('unit_hint'),

    /**
     * How the entry got here: `extracted` when a document coined it, `operator` when a
     * person did. Kept because a name the system invented and a name a reviewer chose
     * deserve different trust when they disagree.
     */
    establishedBy: text('established_by').notNull().default('extracted'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('predicate_registry_collection_name_key').on(
      table.collectionId,
      table.canonicalName,
    ),
    index('predicate_registry_collection_idx').on(table.collectionId),
  ],
);

export type PredicateRegistryEntry = typeof predicateRegistry.$inferSelect;
export type NewPredicateRegistryEntry = typeof predicateRegistry.$inferInsert;
