/**
 * Collections and the documents inside them.
 *
 * A collection is the boundary within which comparisons run (plan 1.2 and 6.1). The two
 * starter datasets are separate collections and are never compared with each other.
 */

import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const collections = pgTable('collections', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),

    /**
     * The name as uploaded. Recorded for display only: plan 0.1 requires runtime
     * processing to stay independent of filenames and of the ordinal prefixes in the
     * starter files, so nothing may branch on this.
     */
    filename: text('filename').notNull(),

    /** SHA-256 of the original bytes, used for duplicate detection (plan 2.1). */
    contentHash: text('content_hash').notNull(),

    /** Key under STORAGE_DIR holding the original bytes. */
    storageKey: text('storage_key').notNull(),

    byteSize: integer('byte_size').notNull(),

    /** Physical page count, validated against MAX_PDF_PAGES before extraction (plan 3.1). */
    pageCount: integer('page_count'),

    /**
     * When the document itself was published, where the document states it.
     *
     * Deliberately separate from the reporting period on a claim: plan 5.2 requires the
     * two to be tracked independently, since an annual report published in 2024 restates
     * figures for years before it.
     */
    publicationDate: date('publication_date'),

    /** Anything the PDF declares about itself. Kept raw; never trusted as fact. */
    pdfMetadata: jsonb('pdf_metadata'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Duplicate detection is scoped to the collection, per plan 2.1. The same file
     * uploaded into two different collections is two documents, because collections are
     * independent comparison boundaries; the same file twice in one collection is a
     * duplicate and must be reported rather than reprocessed.
     */
    uniqueIndex('documents_collection_content_hash_key').on(table.collectionId, table.contentHash),
    index('documents_collection_idx').on(table.collectionId),
  ],
);

export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
