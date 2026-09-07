/**
 * Source blocks: the unit every piece of evidence points at.
 *
 * Plan section 3.2 requires a stable ID, the physical page, the printed label when it is
 * reliable, block type, extraction method, verification status, an optional bounding box,
 * and enough coordinate metadata that a future highlight aligns. All of that lives here.
 *
 * Page identity is the **zero-based physical page index**, never the printed label.
 * `docs/difficult-pages.md` records why: none of the starter PDFs expose page labels, the
 * annual report prints two labels per physical sheet, and the excerpts have
 * non-contiguous page ranges, so a label neither identifies a page nor implies its
 * neighbours.
 */

import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { documents } from './collections.ts';
import { extractionMethod, sourceBlockType } from './enums.ts';

export const sourceBlocks = pgTable(
  'source_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    /** Zero-based physical page index. The identifier all citations key off. */
    physicalPage: integer('physical_page').notNull(),

    /**
     * The page number printed on the page, when one could be read reliably.
     *
     * Null is the normal case, not a defect. Text, because `doc-02` prints two page
     * numbers on each physical sheet and the value is a label rather than a number.
     */
    printedPageLabel: text('printed_page_label'),

    blockType: sourceBlockType('block_type').notNull(),
    extractionMethod: extractionMethod('extraction_method').notNull(),

    /**
     * Ordinal within the page, assigned by the parser's own ordering.
     *
     * This is not reading order and must not be treated as semantic sequence: PDF.js
     * emits the adjusted-EBITDA chart on `doc-02` page 5 in an order that inverts two
     * fiscal years (failure F1). It exists to make block identity stable across re-parses.
     */
    blockIndex: integer('block_index').notNull(),

    /** The block's text. For a table cell, the cell value alone. */
    content: text('content').notNull(),

    /**
     * Positioned runs backing this block, as extracted.
     *
     * Retained per plan 3.1, which requires raw items to be preserved alongside
     * reconstructed text. This is what lets a chart value be re-bound to its axis by
     * coordinate rather than by the order it arrived in.
     */
    positionedItems: jsonb('positioned_items'),

    /** Table cell address, when the block is one. Null otherwise. */
    tableRowIndex: integer('table_row_index'),
    tableColumnIndex: integer('table_column_index'),
    /** Row and column headers, and any footnote markers attached to the cell (plan 4.3). */
    tableHeaders: jsonb('table_headers'),

    /**
     * Bounding box in PDF user-space points, optional per plan 7.3, which makes region
     * highlighting optional but page navigation core.
     */
    bboxX: doublePrecision('bbox_x'),
    bboxY: doublePrecision('bbox_y'),
    bboxWidth: doublePrecision('bbox_width'),
    bboxHeight: doublePrecision('bbox_height'),

    /**
     * Page geometry, stored per block so a stored box can be interpreted without
     * re-opening the PDF. Plan 3.2 names origin, dimensions and rotation specifically.
     */
    coordinateOrigin: text('coordinate_origin').notNull().default('bottom-left'),
    pageWidthPt: doublePrecision('page_width_pt'),
    pageHeightPt: doublePrecision('page_height_pt'),
    pageRotation: integer('page_rotation').notNull().default(0),

    /**
     * Reference to a stored render of the page, when one was made for the visual route.
     * The image is evidence in its own right and is kept per plan 3.1.
     */
    pageImageKey: text('page_image_key'),

    /**
     * Version of the parser or model that produced this block.
     *
     * Part of the cache key plan 3.1 asks for: document hash, page, parser/model version
     * and options. Re-parsing under a new version yields new blocks rather than
     * silently altering the evidence an existing claim already cites.
     */
    producedBy: text('produced_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Makes re-parsing idempotent, which plan 2.3 requires: a retried page insert
     * collides rather than duplicating the evidence a claim already points at.
     */
    uniqueIndex('source_blocks_identity_key').on(
      table.documentId,
      table.physicalPage,
      table.blockIndex,
      table.producedBy,
    ),
    index('source_blocks_document_page_idx').on(table.documentId, table.physicalPage),
  ],
);

export type SourceBlock = typeof sourceBlocks.$inferSelect;
export type NewSourceBlock = typeof sourceBlocks.$inferInsert;
