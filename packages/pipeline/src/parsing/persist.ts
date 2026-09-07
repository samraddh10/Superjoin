/**
 * Writing reconstructed layout into `source_blocks`.
 *
 * This is where plan section 3.2's requirements land in the database: a stable ID per
 * block, the physical page index, the printed label kept separately and left null when
 * unreliable, block type, extraction method, the positioned runs that produced the text,
 * and enough geometry — origin, page dimensions, rotation — that a highlight can be
 * placed later.
 *
 * Caching is the unique index rather than a separate store. Plan 3.1 asks for parsing to
 * be cached by document hash, page, parser version and options; `source_blocks` is unique
 * on (document, physical page, block index, produced_by), so re-parsing under the same
 * parser version collides and is skipped, while a new version writes new blocks instead
 * of silently altering the evidence an existing claim already cites.
 */

import { and, eq } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { sourceBlocks } from '@superjoin/db';

import type { PageText } from '../pdf-text.ts';
import type { PageClassification } from './classify.ts';
import { buildLayout, type PageLayout, type TextBlock } from './layout.ts';
import { readPrintedPageLabel } from './page-label.ts';

/**
 * Version of the native-text parser.
 *
 * Bumped when a change alters the blocks this produces, so old evidence stays attached to
 * the parser that made it. Not bumped for changes that cannot affect output.
 */
export const PARSER_VERSION = 'native-text@1';

export type BlockType = 'paragraph' | 'heading' | 'list' | 'table' | 'chart' | 'other';

export interface PersistPageOptions {
  readonly documentId: string;
  readonly producedBy?: string;
}

export interface PersistedPage {
  readonly physicalPage: number;
  readonly blocksWritten: number;
  readonly blocksSkipped: number;
  readonly printedPageLabel: string | null;
}

/** A block is a heading if it is one short line set larger than the page's body text. */
function looksLikeHeading(block: TextBlock, medianTextHeight: number): boolean {
  if (block.lines.length !== 1) return false;
  const line = block.lines[0]!;
  return line.height > medianTextHeight * 1.15 && line.text.length <= 80;
}

/** A block is a list if most of its lines are short and start at the same left edge. */
function looksLikeList(block: TextBlock): boolean {
  if (block.lines.length < 3) return false;
  const left = block.lines[0]!.x0;
  const aligned = block.lines.filter((line) => Math.abs(line.x0 - left) < 2).length;
  const short = block.lines.filter((line) => line.text.length <= 60).length;
  return aligned >= block.lines.length * 0.8 && short >= block.lines.length * 0.8;
}

/**
 * Chooses a block type.
 *
 * The page's classification decides between table and chart, since neither can be told
 * from the other by text alone: a chart's axis labels align as neatly as a table's
 * columns. Both are recorded as structured content needing the visual route, and the
 * distinction between them is left to the transcription that actually looks at the page.
 */
export function classifyBlockType(
  block: TextBlock,
  layout: PageLayout,
  page: PageClassification,
): BlockType {
  if (looksLikeHeading(block, layout.medianTextHeight)) return 'heading';

  if (page.kind === 'structured') {
    // Only blocks that are themselves dense count as the table; a heading above a table
    // is still a heading.
    const runs = block.lines.flatMap((line) => line.items);
    if (runs.length >= 8) return 'table';
  }

  if (looksLikeList(block)) return 'list';
  return 'paragraph';
}

/**
 * Persists one page's blocks.
 *
 * Returns counts rather than rows: the caller needs progress, and loading every block
 * back would defeat the point of writing them.
 */
export async function persistPageBlocks(
  db: Database,
  pageText: PageText,
  classification: PageClassification,
  options: PersistPageOptions,
): Promise<PersistedPage> {
  const producedBy = options.producedBy ?? PARSER_VERSION;
  const layout = buildLayout(pageText);
  const printed = readPrintedPageLabel(pageText);

  // Already parsed by this version. The unique index would reject the inserts anyway;
  // checking first keeps a re-run cheap instead of merely safe.
  const existing = await db
    .select({ id: sourceBlocks.id })
    .from(sourceBlocks)
    .where(
      and(
        eq(sourceBlocks.documentId, options.documentId),
        eq(sourceBlocks.physicalPage, pageText.physicalPage),
        eq(sourceBlocks.producedBy, producedBy),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return {
      physicalPage: pageText.physicalPage,
      blocksWritten: 0,
      blocksSkipped: 1,
      printedPageLabel: printed.label,
    };
  }

  const rows = [];
  let blockIndex = 0;

  for (const region of layout.regions) {
    for (const block of region.blocks) {
      const runs = block.lines.flatMap((line) => line.items);

      rows.push({
        documentId: options.documentId,
        physicalPage: pageText.physicalPage,
        // Null rather than a guess. Plan 3.2: leave the label unknown when unreliable.
        printedPageLabel: printed.label,
        blockType: classifyBlockType(block, layout, classification),
        // Everything here came from the PDF's own text layer. Blocks derived from a page
        // image are written by the visual route with `model_transcription` instead, which
        // is what keeps a model's reading distinguishable from the document's own.
        extractionMethod: 'native_text' as const,
        blockIndex: blockIndex++,
        content: block.text,
        // Raw runs kept alongside reconstructed text, per plan 3.1. This is what lets a
        // chart value be re-bound to its axis by coordinate rather than by arrival order.
        positionedItems: runs.map((run) => ({
          text: run.text,
          x: run.x,
          y: run.y,
          width: run.width,
          height: run.height,
          readingIndex: run.readingIndex,
        })),
        bboxX: block.x0,
        bboxY: block.yBottom,
        bboxWidth: block.x1 - block.x0,
        bboxHeight: block.yTop - block.yBottom,
        coordinateOrigin: pageText.coordinateOrigin,
        pageWidthPt: pageText.widthPt,
        pageHeightPt: pageText.heightPt,
        pageRotation: pageText.rotation,
        producedBy,
      });
    }
  }

  if (rows.length === 0) {
    return {
      physicalPage: pageText.physicalPage,
      blocksWritten: 0,
      blocksSkipped: 0,
      printedPageLabel: printed.label,
    };
  }

  // onConflictDoNothing rather than a plain insert: two workers reaching the same page
  // concurrently is a collision to absorb, not a run to fail.
  await db.insert(sourceBlocks).values(rows).onConflictDoNothing();

  return {
    physicalPage: pageText.physicalPage,
    blocksWritten: rows.length,
    blocksSkipped: 0,
    printedPageLabel: printed.label,
  };
}
