/**
 * Phases 4 to 6 end to end, against a real database.
 *
 * Source blocks are seeded directly rather than parsed from a PDF. Parsing has its own
 * test against a real starter document; what this one is for is the path from a chunk to
 * a stored relationship, and driving it through a hundred-page render would make a slow
 * test that fails for reasons unrelated to what it checks.
 *
 * The model is scripted. That is not a way of avoiding the real one: the point of these
 * assertions is what the pipeline does with a reply, including a reply that cites a block
 * it was never shown, and a live free-tier model cannot be asked to produce that on
 * demand.
 *
 * The claims are the FY24 revenue pair from `evaluation/goldset.json` — 8,142 Cr in the
 * earnings deck against 81,415 million in the annual report — which is the corroboration
 * case the acceptance criteria require to be demonstrable.
 */

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  claimEvidence,
  claims,
  closeDatabase,
  collections,
  createDatabase,
  documents,
  entities,
  processingRuns,
  relationships,
  sourceBlocks,
  type DatabaseHandle,
} from '@superjoin/db';
import {
  LocalEmbeddingProvider,
  ModelError,
  ProcessingError,
  compareDocument,
  extractDocument,
  findCandidates,
  normalizeDocument,
  type CompletionProvider,
  type CompletionRequest,
  type CompletionResult,
  type ProcessingContext,
} from '@superjoin/pipeline';

const connectionString =
  process.env['DATABASE_URL'] ?? 'postgres://superjoin:superjoin@localhost:55432/superjoin';

const database: DatabaseHandle = createDatabase(connectionString);
const reachable = await database.pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

if (!reachable) await closeDatabase(database);

/**
 * A model that answers by matching what it was asked.
 *
 * Keyed on a phrase in the prompt rather than on call order, because extraction runs its
 * chunks concurrently and an order-based script would be answering a different question
 * on every run.
 */
class ScriptedClient implements CompletionProvider {
  readonly mode = 'live' as const;
  readonly model = 'test/model';
  readonly calls: string[] = [];

  constructor(private readonly answers: readonly (readonly [string, string])[]) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const text = request.messages.map((message) => String(message.content)).join('\n');
    this.calls.push(text);

    for (const [needle, answer] of this.answers) {
      if (text.includes(needle)) {
        return {
          text: answer,
          servedByModel: 'test/model-served',
          promptTokens: 100,
          completionTokens: 40,
          latencyMs: 5,
        };
      }
    }

    return {
      text: JSON.stringify({ claims: [] }),
      servedByModel: 'test/model-served',
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 1,
    };
  }
}

const deckText = 'Revenue from services was 8,142 Cr in FY24.';
const reportText = 'All figures in INR million. Revenue from services 81,415 for the year ended March 31, 2024.';

const extracted = (
  overrides: Record<string, unknown>,
): string =>
  JSON.stringify({
    claims: [
      {
        subject: 'Delhivery Limited',
        predicate: 'revenue_from_services',
        original_statement: deckText,
        raw_value: '8,142 Cr',
        numeric_value: '8142',
        currency: 'INR',
        scale: 'crore',
        unit: null,
        period_label: 'FY2024',
        period_type: 'fiscal_year',
        scope: 'consolidated',
        assertion_status: 'reported',
        qualifiers: [],
        evidence_block_ids: ['B1'],
        quote: deckText,
        ...overrides,
      },
    ],
  });

const classification = JSON.stringify({
  label: 'corroborates',
  rationale: 'Both documents report the same FY24 revenue once the crore figure is converted to millions.',
  evidence_ids: ['E1', 'E2'],
  differing_context: [],
  uncertainty_reasons: [],
});

let collectionId: string;
let deck: Seeded;
let report: Seeded;
/** Extra collections a test made, torn down with the main one. */
const spentCollections: string[] = [];

type Seeded = { documentId: string; runId: string; collectionId: string };

async function seedDocument(filename: string, blockText: string): Promise<Seeded> {
  return seedPages(filename, [blockText]);
}

/**
 * Seeds one document with one block per physical page.
 *
 * A chunk never spans a page, so a block per page is the shortest way to a document that
 * chunks into more than one piece — which is what batching needs in order to be visible
 * at all.
 */
async function seedPages(
  filename: string,
  pages: readonly string[],
  into?: string,
): Promise<Seeded> {
  const collection = into ?? collectionId;
  const [document] = await database.db
    .insert(documents)
    .values({
      collectionId: collection,
      filename,
      contentHash: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      storageKey: `documents/${filename}`,
      byteSize: 1024,
      pageCount: pages.length,
    })
    .returning({ id: documents.id });

  await database.db.insert(sourceBlocks).values(
    pages.map((content, page) => ({
      documentId: document!.id,
      physicalPage: 5 + page,
      printedPageLabel: null,
      blockType: 'paragraph' as const,
      extractionMethod: 'native_text' as const,
      blockIndex: 0,
      content,
      producedBy: 'test-parser@1',
    })),
  );

  const [run] = await database.db
    .insert(processingRuns)
    .values({ documentId: document!.id, stage: 'extracting', pipelineVersion: 'test-0' })
    .returning({ id: processingRuns.id });

  return { documentId: document!.id, runId: run!.id, collectionId: collection };
}

/** A collection of its own, for a document that must not join the comparison fixtures. */
async function seedCollection(): Promise<string> {
  const [collection] = await database.db
    .insert(collections)
    .values({ name: `pipeline-${randomUUID()}` })
    .returning({ id: collections.id });

  spentCollections.push(collection!.id);
  return collection!.id;
}

function contextFor(seeded: Seeded): ProcessingContext {
  return {
    database,
    storageDir: '/tmp',
    job: { runId: seeded.runId, documentId: seeded.documentId, collectionId: seeded.collectionId },
    storageKey: 'unused',
    pageCount: 1,
  };
}

beforeAll(async () => {
  if (!reachable) return;

  const [collection] = await database.db
    .insert(collections)
    .values({ name: `pipeline-${randomUUID()}` })
    .returning({ id: collections.id });

  collectionId = collection!.id;
  deck = await seedDocument('deck.pdf', deckText);
  report = await seedDocument('report.pdf', reportText);
}, 60_000);

afterAll(async () => {
  if (!reachable) return;
  // The collection cascades to documents, blocks, claims and relationships, so one
  // delete leaves the database as the test found it.
  await database.db.delete(collections).where(eq(collections.id, collectionId));
  for (const spent of spentCollections) {
    await database.db.delete(collections).where(eq(collections.id, spent));
  }
  await closeDatabase(database);
});

describe.skipIf(!reachable)('extraction, normalization and comparison', () => {
  it('extracts, grounds and accepts a claim whose quote is in the document', async () => {
    const client = new ScriptedClient([[deckText, extracted({})]]);
    const summary = await extractDocument(contextFor(deck), { client, concurrency: 1 });

    expect(summary.claimsExtracted).toBe(1);
    expect(summary.claimsAccepted).toBe(1);

    const [stored] = await database.db
      .select({ status: claims.status, numericValue: claims.numericValue })
      .from(claims)
      .where(eq(claims.documentId, deck.documentId));

    expect(stored?.status).toBe('accepted');
    // NUMERIC comes back as a string. Nothing on this path put it through a double.
    expect(stored?.numericValue).toBe('8142');
  }, 60_000);

  it('links the accepted claim to the block its quote was found in', async () => {
    const [evidence] = await database.db
      .select({
        verification: claimEvidence.verification,
        entailment: claimEvidence.entailment,
        quoteStart: claimEvidence.quoteStart,
      })
      .from(claimEvidence)
      .innerJoin(claims, eq(claims.id, claimEvidence.claimId))
      .where(eq(claims.documentId, deck.documentId));

    expect(evidence?.verification).toBe('verified_native_text');
    expect(evidence?.entailment).toBe('supported');
    expect(evidence?.quoteStart).toBe(0);
  });

  it('does not duplicate the assertion when extraction runs again', async () => {
    // Plan 4.4: repeated extraction of one source assertion is deduplicated, and plan
    // 2.3 requires the insert to be idempotent under a retried job.
    const client = new ScriptedClient([[deckText, extracted({})]]);
    await extractDocument(contextFor(deck), { client, concurrency: 1 });

    const stored = await database.db
      .select({ id: claims.id })
      .from(claims)
      .where(eq(claims.documentId, deck.documentId));

    expect(stored).toHaveLength(1);
  }, 60_000);

  it('reads two chunks in one request and grounds each in its own block', async () => {
    // Chunking flushes at every page, so a two-page document is two chunks. They used to
    // be two requests, each resending the system prompt, the rules and the collection's
    // whole vocabulary to ask about one sentence.
    const pages = [
      'Revenue from services was 8,142 Cr in FY24.',
      'Adjusted EBITDA was 1,229 million in FY24.',
    ];
    // Its own collection: these claims are not part of the cross-document pair the
    // comparison tests below are built around, and letting them join it would change
    // what those tests are measuring.
    const batched = await seedPages('batched.pdf', pages, await seedCollection());

    const client = new ScriptedClient([
      [
        'passage P2',
        JSON.stringify({
          claims: [
            {
              subject: 'Delhivery Limited',
              predicate: 'revenue_from_services',
              original_statement: pages[0],
              raw_value: '8,142 Cr',
              numeric_value: '8142',
              currency: 'INR',
              scale: 'crore',
              unit: null,
              period_label: 'FY2024',
              period_type: 'fiscal_year',
              scope: null,
              assertion_status: 'reported',
              qualifiers: [],
              evidence_block_ids: ['P1B1'],
              quote: pages[0],
            },
            {
              subject: 'Delhivery Limited',
              predicate: 'adjusted_ebitda',
              original_statement: pages[1],
              raw_value: '1,229 million',
              numeric_value: '1229',
              currency: 'INR',
              scale: 'million',
              unit: null,
              period_label: 'FY2024',
              period_type: 'fiscal_year',
              scope: null,
              assertion_status: 'reported',
              qualifiers: [],
              evidence_block_ids: ['P2B1'],
              quote: pages[1],
            },
          ],
        }),
      ],
    ]);

    const summary = await extractDocument(contextFor(batched), { client, concurrency: 1 });

    // Two chunks, one call. That is the whole of the saving.
    expect(client.calls).toHaveLength(1);
    expect(summary.chunksTotal).toBe(2);
    expect(summary.chunksProcessed).toBe(2);
    expect(summary.claimsAccepted).toBe(2);

    // And each claim is anchored to the page it was actually read from, which is what the
    // batch-unique handles are for: both chunks call their own block B1.
    const stored = await database.db
      .select({ predicate: claims.predicate, page: sourceBlocks.physicalPage })
      .from(claims)
      .innerJoin(claimEvidence, eq(claimEvidence.claimId, claims.id))
      .innerJoin(sourceBlocks, eq(sourceBlocks.id, claimEvidence.sourceBlockId))
      .where(eq(claims.documentId, batched.documentId));

    expect(stored).toHaveLength(2);
    expect(stored.find((row) => row.predicate === 'revenue_from_services')?.page).toBe(5);
    expect(stored.find((row) => row.predicate === 'adjusted_ebitda')?.page).toBe(6);
  }, 60_000);

  it('sends one chunk per request when batching is turned off', async () => {
    // The switch that makes the saving measurable against what it replaced.
    const pages = ['Revenue was 1 Cr in FY24.', 'Revenue was 2 Cr in FY23.'];
    const unbatched = await seedPages('unbatched.pdf', pages, await seedCollection());
    const client = new ScriptedClient([]);

    await extractDocument(contextFor(unbatched), {
      client,
      concurrency: 1,
      batchMaxChunks: 1,
    });

    expect(client.calls).toHaveLength(2);
  }, 60_000);

  it('rejects a claim that cites a block it was never shown', async () => {
    const client = new ScriptedClient([
      [reportText, extracted({ evidence_block_ids: ['B99'], quote: reportText })],
    ]);

    await extractDocument(contextFor(report), { client, concurrency: 1 });

    const [stored] = await database.db
      .select({ status: claims.status, statusReason: claims.statusReason })
      .from(claims)
      .where(eq(claims.documentId, report.documentId));

    expect(stored?.status).toBe('rejected');
    expect(stored?.statusReason).toContain('outside the material');
  }, 60_000);

  it('extracts the corresponding claim from the second document', async () => {
    // Replaces the rejected claim above with a grounded one, so the pair exists to
    // compare. The fingerprint differs because the value does, so both rows remain.
    const client = new ScriptedClient([
      [
        reportText,
        extracted({
          original_statement: reportText,
          raw_value: '81,415',
          numeric_value: '81415',
          scale: 'million',
          quote: 'Revenue from services 81,415',
        }),
      ],
    ]);

    const summary = await extractDocument(contextFor(report), { client, concurrency: 1 });
    expect(summary.claimsAccepted).toBe(1);
  }, 60_000);

  it('normalizes both documents onto one entity and one comparable basis', async () => {
    await normalizeDocument(contextFor(deck));
    const summary = await normalizeDocument(contextFor(report));

    // "for the year ended March 31, 2024" is in the report's own text, so its fiscal
    // dates may be resolved. The deck never says, and keeps its label without dates.
    expect(summary.fiscalConvention).toBe('april-march');

    const normalized = await database.db
      .select({
        documentId: claims.documentId,
        normalizedValue: claims.normalizedValue,
        normalizedUnit: claims.normalizedUnit,
        entityId: claims.entityId,
      })
      .from(claims)
      .where(and(eq(claims.status, 'accepted')));

    const mine = normalized.filter(
      (row) => row.documentId === deck.documentId || row.documentId === report.documentId,
    );

    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((row) => row.entityId)).size).toBe(1);
    expect(mine.every((row) => row.normalizedUnit === 'INR')).toBe(true);
    // 8,142 crore and 81,415 million are different figures at the rupee, and both are
    // recorded as what their source said rather than reconciled into one value.
    expect(new Set(mine.map((row) => row.normalizedValue)).size).toBe(2);
  }, 60_000);

  it('records the entity once for two spellings of the same company', async () => {
    const stored = await database.db
      .select({ id: entities.id, label: entities.normalizedLabel })
      .from(entities)
      .where(eq(entities.collectionId, collectionId));

    expect(stored).toHaveLength(1);
    expect(stored[0]?.label).toBe('delhivery');
  });

  it('retrieves the cross-document pair and explains it', async () => {
    const client = new ScriptedClient([['Claim A', classification]]);
    // This pair is a plain corroboration, which the checks now settle without a call, so
    // the fast path is turned off here: what this test is for is the classified route —
    // retrieval, evidence handles, a model verdict, and a stored explanation that points
    // at quotes. The shortcut over the same pair is the test below.
    const summary = await compareDocument(contextFor(report), {
      client,
      fastPathCorroborations: false,
    });

    expect(summary.pairsConsidered).toBe(1);
    expect(summary.exactPairs).toBe(1);
    expect(summary.classifiedByModel).toBe(1);

    const [stored] = await database.db
      .select({
        label: relationships.label,
        rationale: relationships.rationale,
        method: relationships.method,
        supporting: relationships.supportingEvidenceIds,
      })
      .from(relationships)
      .where(eq(relationships.collectionId, collectionId));

    expect(stored?.label).toBe('corroborates');
    expect(stored?.method).toBe('model');
    // The rationale points at evidence rather than at a number it invented.
    expect((stored?.supporting as string[]).length).toBeGreaterThan(0);
  }, 60_000);

  it('does not duplicate the relationship when comparison runs again', async () => {
    const client = new ScriptedClient([['Claim A', classification]]);
    const summary = await compareDocument(contextFor(report), {
      client,
      fastPathCorroborations: false,
    });

    const stored = await database.db
      .select({ id: relationships.id })
      .from(relationships)
      .where(eq(relationships.collectionId, collectionId));

    expect(stored).toHaveLength(1);

    // Nor pay for it again. The unique index always made the second write a no-op, but
    // the call that produced the duplicate verdict had already been made and charged.
    expect(summary.resumedFromStore).toBe(1);
    expect(client.calls).toHaveLength(0);
  }, 60_000);

  it('settles a plain corroboration without asking the model', async () => {
    // Two accepted claims, two documents, two independent blocks, one entity, one measure,
    // one stated period, and figures that agree after a recorded conversion. There is no
    // open question for a classifier to read, and it used to be asked anyway.
    await database.db.delete(relationships).where(eq(relationships.collectionId, collectionId));

    const client = new ScriptedClient([['Claim A', classification]]);
    const summary = await compareDocument(contextFor(report), { client });

    expect(client.calls).toHaveLength(0);
    expect(summary.classifiedByModel).toBe(0);
    expect(summary.classifiedDeterministically).toBe(1);

    const [stored] = await database.db
      .select({
        label: relationships.label,
        method: relationships.method,
        supporting: relationships.supportingEvidenceIds,
      })
      .from(relationships)
      .where(eq(relationships.collectionId, collectionId));

    expect(stored?.label).toBe('corroborates');
    expect(stored?.method).toBe('deterministic');
    // A shortcut, not a shrug: the verdict still points at the quotes it compared.
    expect((stored?.supporting as string[]).length).toBeGreaterThan(0);
  }, 60_000);

  it('fails the run when the classifier cannot be reached, rather than labelling anyway', async () => {
    // The checks had already failed to settle this pair — that is why it was sent to the
    // model. A label written in the model's absence would be a guess stored in the same
    // shape as a considered answer, and no reader could tell the two apart.
    await database.db.delete(relationships).where(eq(relationships.collectionId, collectionId));

    let attempts = 0;
    const unavailable: CompletionProvider = {
      model: 'stub/unavailable',
      complete() {
        attempts += 1;
        return Promise.reject(new ModelError('quota exhausted', 'provider_rate_limited', true));
      },
    };

    // A throttle buys a pause and another attempt at the same pair, so the failure only
    // arrives once those are spent. Zero milliseconds here: the cooldown's length is not
    // what is under test, and the real one would put this test to sleep for 90 seconds.
    // The one pair here is a plain corroboration, which the checks would settle on their
    // own. The behaviour under test is the other path — a pair the checks could not
    // settle, whose classifier is then unreachable — so the shortcut is turned off rather
    // than the pair being contrived into an unsettleable one.
    const failure = await compareDocument(contextFor(report), {
      client: unavailable,
      cooldownMs: 0,
      cooldownAttempts: 2,
      fastPathCorroborations: false,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProcessingError);
    expect((failure as ProcessingError).stage).toBe('comparing');
    expect((failure as ProcessingError).failureClass).toBe('transient');

    const stored = await database.db
      .select({ id: relationships.id })
      .from(relationships)
      .where(eq(relationships.collectionId, collectionId));

    expect(stored).toHaveLength(0);
    // The first ask plus one per cooldown: the pair was retried rather than abandoned,
    // and it still failed the run rather than being labelled from the checks.
    expect(attempts).toBe(3);
  }, 60_000);

  it('runs the pgvector search when an embedding model is available', async () => {
    // The semantic channel is raw SQL against pgvector, so it is worth executing rather
    // than only typechecking. The pair is already found by the exact channel, so what
    // this asserts is that vectors were stored and the neighbour query ran, not that
    // retrieval needed it.
    const embeddings = new LocalEmbeddingProvider({
      model: process.env['EMBEDDING_MODEL'] ?? 'Xenova/all-mpnet-base-v2',
      dimensions: 768,
    });

    const loadable = await embeddings.embed(['probe']).then(
      () => true,
      () => false,
    );

    if (!loadable) return;

    const found = await findCandidates(database.db, {
      collectionId,
      documentId: report.documentId,
      topK: 15,
      provider: embeddings,
    });

    expect(found.embedding.available).toBe(true);
    expect(found.embedding.reason).toBeNull();
    expect(found.pairs.length).toBeGreaterThan(0);
    // Both channels found the one pair there is, which is what the union is for.
    expect(found.pairs[0]?.sources).toContain('exact');
    expect(found.pairs[0]?.sources).toContain('semantic');
  }, 180_000);

  it('keeps both original figures rather than resolving them into one', async () => {
    // Plan 6.4. The relationship explains the pair; it does not replace it.
    const values = await database.db
      .select({ raw: claims.rawValue })
      .from(claims)
      .where(eq(claims.status, 'accepted'));

    const mine = values.map((row) => row.raw);
    expect(mine).toContain('8,142 Cr');
    expect(mine).toContain('81,415');
  });
});
