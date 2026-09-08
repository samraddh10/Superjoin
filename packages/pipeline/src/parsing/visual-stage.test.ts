/**
 * The visual stage's behaviour when the model is unavailable.
 *
 * This is the part that matters most in practice. Measured on the free tier, the upstream
 * pool refuses a large share of requests, so these tests use stub clients to pin what
 * happens when it does: the document must stay usable, the failure must be recorded, and
 * the stage must stop asking once it is clear the answer is no.
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
  processingIssues,
  processingRuns,
  sourceBlocks,
} from '@superjoin/db';
import type { DatabaseHandle } from '@superjoin/db';

import { ModelError, type CompletionProvider, type CompletionResult } from '../model/index.ts';
import { ProcessingError, type ProcessingContext } from '../processor.ts';
import { contentHash, documentStorageKey, objectExists, writeObject } from '../storage.ts';
import { parseDocument } from './stage.ts';
import { renderTranscription } from './transcribe.ts';
import { transcribeDocument } from './visual-stage.ts';

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
let documentHash: string;

/** A client that always refuses, the way a saturated free pool does. */
const alwaysThrottled: CompletionProvider = {
  model: 'stub/throttled',
  async complete(): Promise<CompletionResult> {
    throw new ModelError('429 rate-limited upstream', 'provider_rate_limited', true);
  },
};

/** A client that answers with a valid transcription. */
const answers: CompletionProvider = {
  model: 'stub/answers',
  async complete(): Promise<CompletionResult> {
    return {
      text: JSON.stringify({
        tables: [
          {
            title: 'Operating metrics',
            unitNote: 'in Rs Cr',
            rows: [
              [
                {
                  text: '8,142',
                  rowHeader: 'Revenue from services',
                  columnHeader: 'FY24',
                  unit: 'Rs Cr',
                  footnote: null,
                },
              ],
            ],
          },
        ],
      }),
      servedByModel: 'stub/answers',
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 10,
    };
  },
};

beforeAll(async () => {
  if (!reachable) return;
  storageDir = await mkdtemp(join(tmpdir(), 'superjoin-visual-'));

  const bytes = new Uint8Array(await readFile(EARNINGS_DECK));
  documentHash = contentHash(bytes);
  const storageKey = documentStorageKey(documentHash);
  await writeObject(storageDir, storageKey, bytes);

  const [collection] = await database.db
    .insert(collections)
    .values({ name: `visual-${randomUUID()}` })
    .returning({ id: collections.id });

  const [document] = await database.db
    .insert(documents)
    .values({
      collectionId: collection!.id,
      filename: 'deck.pdf',
      contentHash: randomUUID().repeat(2).replace(/-/g, '').slice(0, 64),
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

  // Native-text parsing first: the visual stage only revisits pages parsing marked.
  await parseDocument(context);
}, 240_000);

afterAll(async () => {
  if (!reachable) return;
  await closeDatabase(database);
  await rm(storageDir, { recursive: true, force: true });
});

describe.skipIf(!reachable)('when the model is unavailable', () => {
  it('fails the run rather than leaving the page read from a text layer it distrusts', async () => {
    // The page reached this stage because its native text was judged unusable. Returning
    // a summary here would report the document as parsed with that page silently unread.
    const failure = await transcribeDocument(context, {
      client: alwaysThrottled,
      documentHash: () => documentHash,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProcessingError);
    const error = failure as ProcessingError;
    expect(error.stage).toBe('parsing');
    // Throttling is worth retrying; the queue decides when, not this stage.
    expect(error.failureClass).toBe('transient');
    expect(error.failureKind).toBe('provider_rate_limited');
    expect(error.physicalPage).not.toBeUndefined();
  }, 180_000);

  it('leaves the document usable, with its native-text blocks intact', async () => {
    // The run failed, but nothing already written was rolled back: the retry starts from
    // stored native text rather than from a blank document.
    const blocks = await database.db
      .select()
      .from(sourceBlocks)
      .where(eq(sourceBlocks.documentId, context.job.documentId));

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((block) => block.extractionMethod === 'native_text')).toBe(true);
  });

  it('records the throttling as a transient issue naming the page', async () => {
    const issues = await database.db
      .select()
      .from(processingIssues)
      .where(eq(processingIssues.runId, context.job.runId));

    const throttles = issues.filter((issue) => issue.failureKind === 'visual_route_throttled');
    expect(throttles.length).toBeGreaterThan(0);
    expect(throttles[0]?.isTransient).toBe(true);
    expect(throttles[0]?.physicalPage).not.toBeNull();

    // Recorded before the throw, so the failed run says which page it died on.
    expect(throttles[0]?.message).toMatch(/physical page \d+/);
  });
});

describe.skipIf(!reachable)('when the model answers', () => {
  it('stores the transcription as model output, never as source text', async () => {
    const summary = await transcribeDocument(context, {
      client: answers,
      documentHash: () => documentHash,
      maxPages: 2,
    });

    expect(summary.pagesTranscribed).toBe(2);
    expect(summary.blocksWritten).toBeGreaterThan(0);

    const transcribed = await database.db
      .select()
      .from(sourceBlocks)
      .where(eq(sourceBlocks.extractionMethod, 'model_transcription'));

    const mine = transcribed.filter((block) => block.documentId === context.job.documentId);
    expect(mine.length).toBeGreaterThan(0);
    // Plan 4.3: a transcription cannot independently verify a claim extracted by the same
    // model, so it must stay distinguishable from the document's own text.
    expect(mine[0]?.extractionMethod).toBe('model_transcription');
    expect(mine[0]?.content).toContain('8,142');
  }, 180_000);

  it('keeps the rendered page image as evidence', async () => {
    // Plan 3.1 requires the original page image to be retained, so a reviewer can see
    // what the model was actually shown.
    //
    // Scoped to this test's own document, as the transcription test above already is.
    // `model_transcription` is not rare in a database that has processed anything real,
    // and an unscoped `limit 1` returned another document's block whose image lives in
    // the worker's storage volume rather than this test's temporary directory.
    const [block] = await database.db
      .select({ key: sourceBlocks.pageImageKey })
      .from(sourceBlocks)
      .where(
        and(
          eq(sourceBlocks.extractionMethod, 'model_transcription'),
          eq(sourceBlocks.documentId, context.job.documentId),
        ),
      )
      .limit(1);

    expect(block?.key).toBeTruthy();
    expect(await objectExists(storageDir, block!.key!)).toBe(true);
  });

  it('does not transcribe a page it has already read under this model version', async () => {
    // Scoped to this document, for the reason the test above gives: any database that has
    // processed something real holds other documents' transcription blocks, and counting
    // them all measures whatever else has run rather than what this test did.
    const transcribedPages = async (): Promise<Set<number>> => {
      const rows = await database.db
        .selectDistinct({ page: sourceBlocks.physicalPage })
        .from(sourceBlocks)
        .where(
          and(
            eq(sourceBlocks.extractionMethod, 'model_transcription'),
            eq(sourceBlocks.documentId, context.job.documentId),
          ),
        );
      return new Set(rows.map((row) => row.page));
    };

    const before = await transcribedPages();
    expect(before.size).toBeGreaterThan(0);

    const summary = await transcribeDocument(context, {
      client: answers,
      documentHash: () => documentHash,
      maxPages: 2,
    });

    const after = await transcribedPages();

    /**
     * The cache is at the call, not at the write.
     *
     * The unique index always made a second insert a no-op, so a re-read could never
     * duplicate a block — but the transcription that produced the row it collided with had
     * already been paid for, and the page was read again to learn nothing. On a
     * rate-limited tier that is the difference between a document finishing and a retry
     * spending its whole quota on pages it had already done.
     *
     * So a second pass reads only what the first did not, and moves the document forward
     * rather than back over itself.
     */
    // Nothing already read was dropped, and every page this pass read is one the first
    // pass had not: the two sets are disjoint, and the document moved forward by exactly
    // what was transcribed.
    expect([...before].filter((page) => !after.has(page))).toEqual([]);
    expect(summary.pagesTranscribed).toBe(after.size - before.size);
    expect(summary.pagesTranscribed).toBeGreaterThan(0);
  }, 180_000);
});

describe('renderTranscription', () => {
  it('keeps the unit note with the rows it applies to', () => {
    // A figure without its unit is not a fact. The unit note is the table's, not the
    // cell's, so it has to survive flattening.
    const text = renderTranscription({
      tables: [
        {
          title: 'Revenue',
          unitNote: 'in Rs Cr',
          rows: [[{ text: '8,142', rowHeader: null, columnHeader: 'FY24', unit: null, footnote: null }]],
        },
      ],
    });

    expect(text).toContain('Revenue');
    expect(text).toContain('in Rs Cr');
    expect(text).toContain('8,142');
  });
});
