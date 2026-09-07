/**
 * Entities and canonical fact groups.
 *
 * Plan section 5.3 governs merging: exact normalization and source-backed aliases first,
 * embeddings only to *suggest* candidates, the model only for ambiguous matches with
 * evidence attached, and anything still uncertain left unmerged. Similar names and vector
 * scores alone are never sufficient, so an alias records where it came from.
 */

import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { collections } from './collections.ts';
import { sourceBlocks } from './sources.ts';

export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),

    canonicalLabel: text('canonical_label').notNull(),

    /**
     * Open vocabulary: company, government body, index, region, person, and whatever the
     * next collection needs. An enum here would make a new entity type a migration.
     */
    entityType: text('entity_type').notNull(),

    /** Lowercased, whitespace-collapsed label used for exact matching before any embedding. */
    normalizedLabel: text('normalized_label').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('entities_collection_normalized_key').on(table.collectionId, table.normalizedLabel),
    index('entities_collection_idx').on(table.collectionId),
  ],
);

export const entityAliases = pgTable(
  'entity_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),

    alias: text('alias').notNull(),
    normalizedAlias: text('normalized_alias').notNull(),

    /**
     * Where this alias came from. Plan 5.3 requires aliases to be source-backed, so an
     * alias asserted by the model with no supporting block is distinguishable from one
     * the document itself states.
     */
    sourceBlockId: uuid('source_block_id').references(() => sourceBlocks.id, {
      onDelete: 'set null',
    }),
    /** How the alias was established: `document_states`, `model_suggested`, `operator`. */
    establishedBy: text('established_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('entity_aliases_entity_alias_key').on(table.entityId, table.normalizedAlias),
    index('entity_aliases_normalized_idx').on(table.normalizedAlias),
  ],
);

/**
 * A canonical grouping of claims that assert the same fact.
 *
 * Plan section 1.2: "Multiple source claims may belong to a shared canonical fact group."
 * The group is a view over claims, never a replacement for them. Conflicting members are
 * exactly what a group is for; it holds no resolved value of its own, because plan 6.4
 * forbids replacing conflicting values with an invented single truth.
 *
 * Membership is decided during Phase 5 resolution, so `claims.fact_group_id` stays null
 * until then.
 */
export const factGroups = pgTable(
  'fact_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'set null' }),

    /** The resolved predicate shared by members. Text, so a new predicate needs no migration. */
    predicate: text('predicate').notNull(),

    /**
     * The context the members share, as resolved: period, scope, segment and so on.
     * JSONB because plan 1.2 requires qualifiers to be extensible as data.
     */
    contextKey: jsonb('context_key'),

    /** Human-readable summary of what the group is about, for the interface. */
    label: text('label'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('fact_groups_collection_predicate_idx').on(table.collectionId, table.predicate)],
);

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type EntityAlias = typeof entityAliases.$inferSelect;
export type NewEntityAlias = typeof entityAliases.$inferInsert;
export type FactGroup = typeof factGroups.$inferSelect;
export type NewFactGroup = typeof factGroups.$inferInsert;
