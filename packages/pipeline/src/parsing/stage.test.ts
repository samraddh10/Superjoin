/**
 * The parsing stage, end to end against a real starter document and a live database.
 *
 * The properties here are about what actually lands in `source_blocks`: whether a
 * re-parse duplicates evidence, whether an unreadable page costs the document, and
 * whether the coordinate metadata plan 3.2 requires is really written rather than merely
 * declared in the schema.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  collections,
  createDatabase,
  documents,
  processingRuns,
  sourceBlocks,
} from '@superjoin/db';
import type { DatabaseHandle } from '@superjoin/db';

import type { ProcessingContext } from '../processor.ts';
import { contentHash, documentStorageKey, writeObject } from '../storage.ts';
import { chunkSourceBlocks } from './chunk.ts';
import { parseDocument } from './stage.ts';

const EARNINGS_DECK = 'datasets/delhivery/03-delhivery-q4-fy24-earnings-presentation.pdf';

const connectionString =
  process.env['DATABASE_URL'] ?? 'postgres://superjoin:superjoin@localhost:55432/superjoin';

const database: DatabaseHandle = createDatabase(connectionString);
const reachable = await database.pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

if (!reachable) await closeDatabase(database);

let storageDir: string;
let context: ProcessingContext;

beforeAll(async () => {
  if (!reachable) return;
  storageDir = await mkdtemp(join(tmpdir(), 'superjoin-parse-'));

  const bytes = new Uint8Array(await readFile(EARNINGS_DECK));
  const hash = contentHash(bytes);
  const storageKey = documentStorageKey(hash);
  await writeObject(storageDir, storageKey, bytes);

  const [collection] = await database.db
    .insert(collections)
    .values({ name: `parse-${randomUUID()}` })
    .returning({ id: collections.id });

  const [document] = await database.db
    .insert(documents)
    .values({
      collectionId: collection!.id,
      filename: 'deck.pdf',
      contentHash: `${hash}-${randomUUID()}`.slice(0, 64),
      storageKey,
      byteSize: bytes.byteLength,
      pageCount: 27,
    })
    .returning({ id: documents.id });

  const [run] = await database.db
    .insert(processingRuns)
    .values({
      documentId: document!.id,
      stage: 'parsing',
      pipelineVersion: 'test-0',
      pagesTotal: 27,
    })
    .returning({ id: processingRuns.id });

  context = {
    database,
    storageDir,
    job: { runId: run!.id, documentId: document!.id, collectionId: collection!.id },
    storageKey,
    pageCount: 27,
  };
}, 120_000);

afterAll(async () => {
  if (!reachable) return;
  await closeDatabase(database);
  await rm(storageDir, { recursive: true, force: true });
});

describe.skipIf(!reachable)('parseDocument', () => {
  it('parses every page of the earnings deck and writes blocks', async () => {
    const summary = await parseDocument(context);

    expect(summary.pagesTotal).toBe(27);
    expect(summary.pagesParsed).toBe(27);
    expect(summary.pagesFailed).toBe(0);
    expect(summary.blocksWritten).toBeGreaterThan(0);

    // docs/difficult-pages.md records four legitimately near-empty pages in this deck:
    // the title slide, two dividers and the contact slide. They are counted, not failed.
    expect(summary.pagesEmpty).toBeGreaterThanOrEqual(4);

    // The table and chart pages the Phase 0.2 notes identified should want a second read.
    expect(summary.pagesNeedingVisualRoute.length).toBeGreaterThan(5);
    expect(summary.pagesNeedingVisualRoute).toContain(7);
  }, 180_000);

  it('stores the geometry a highlight would need', async () => {
    const [block] = await database.db
      .select()
      .from(sourceBlocks)
      .where(
        and(
          eq(sourceBlocks.documentId, context.job.documentId),
          eq(sourceBlocks.physicalPage, 5),
        ),
      )
      .limit(1);

    expect(block).toBeDefined();
    // Plan 3.2 names origin, dimensions and rotation specifically, so that a stored box
    // can be interpreted later without reopening the PDF.
    expect(block?.coordinateOrigin).toBe('bottom-left');
    expect(Number(block?.pageWidthPt)).toBeGreaterThan(0);
    expect(Number(block?.pageHeightPt)).toBeGreaterThan(0);
    expect(block?.pageRotation).toBe(0);
    expect(block?.extractionMethod).toBe('native_text');
    expect(block?.bboxWidth).not.toBeNull();
  });

  it('keeps the positioned runs alongside the reconstructed text', async () => {
    // Plan 3.1 requires raw items to be preserved. This is what lets a chart value be
    // re-bound to its axis by coordinate rather than by the order it arrived in.
    const [block] = await database.db
      .select()
      .from(sourceBlocks)
      .where(eq(sourceBlocks.documentId, context.job.documentId))
      .limit(1);

    const runs = block?.positionedItems as { text: string; x: number }[] | null;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs!.length).toBeGreaterThan(0);
    expect(typeof runs![0]?.x).toBe('number');
  });

  it('records the printed page label found on the page', async () => {
    const [block] = await database.db
      .select({ label: sourceBlocks.printedPageLabel })
      .from(sourceBlocks)
      .where(
        and(
          eq(sourceBlocks.documentId, context.job.documentId),
          eq(sourceBlocks.physicalPage, 5),
        ),
      )
      .limit(1);

    // Physical page 5 of the deck prints "5" in the bottom-right corner.
    expect(block?.label).toBe('5');
  });

  it('does not duplicate blocks when the document is parsed again', async () => {
    const before = await database.db
      .select()
      .from(sourceBlocks)
      .where(eq(sourceBlocks.documentId, context.job.documentId));

    const summary = await parseDocument(context);

    const after = await database.db
      .select()
      .from(sourceBlocks)
      .where(eq(sourceBlocks.documentId, context.job.documentId));

    // The unique index on (document, page, block index, parser version) is the cache
    // plan 3.1 asks for: a re-parse under the same version writes nothing new.
    expect(after.length).toBe(before.length);
    expect(summary.blocksWritten).toBe(0);
  }, 180_000);

  it('produces chunks that resolve back to real source blocks', async () => {
    const rows = await database.db
      .select({
        id: sourceBlocks.id,
        physicalPage: sourceBlocks.physicalPage,
        printedPageLabel: sourceBlocks.printedPageLabel,
        blockType: sourceBlocks.blockType,
        content: sourceBlocks.content,
      })
      .from(sourceBlocks)
      .where(eq(sourceBlocks.documentId, context.job.documentId))
      .orderBy(sourceBlocks.physicalPage, sourceBlocks.blockIndex);

    const chunks = chunkSourceBlocks(rows);
    expect(chunks.length).toBeGreaterThan(0);

    // The plan's exit condition for Phase 3: every chunk resolves to the correct source
    // page. Checked against the stored rows rather than against the chunker's own output.
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const chunk of chunks) {
      expect(chunk.sourceBlockIds.length).toBeGreaterThan(0);
      for (const id of chunk.sourceBlockIds) {
        const source = byId.get(id);
        expect(source).toBeDefined();
        expect(chunk.physicalPages).toContain(source!.physicalPage);
      }
    }
  }, 120_000);

  it('records an issue for an unreadable page without failing the document', async () => {
    // A document whose page count overstates the file: pages past the end cannot be
    // read. One bad page should cost that page, not the other twenty-seven.
    const summary = await parseDocument({ ...context, pageCount: 29 });

    expect(summary.pagesFailed).toBe(2);
    expect(summary.pagesParsed).toBe(27);
  }, 180_000);
});
