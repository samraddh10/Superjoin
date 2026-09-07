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
let deck: { documentId: string; runId: string };
let report: { documentId: string; runId: string };

async function seedDocument(
  filename: string,
  blockText: string,
): Promise<{ documentId: string; runId: string }> {
  const [document] = await database.db
    .insert(documents)
    .values({
      collectionId,
      filename,
      contentHash: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      storageKey: `documents/${filename}`,
      byteSize: 1024,
      pageCount: 1,
    })
    .returning({ id: documents.id });

  await database.db.insert(sourceBlocks).values({
    documentId: document!.id,
    physicalPage: 5,
    printedPageLabel: null,
    blockType: 'paragraph',
    extractionMethod: 'native_text',
    blockIndex: 0,
    content: blockText,
    producedBy: 'test-parser@1',
  });

  const [run] = await database.db
    .insert(processingRuns)
    .values({ documentId: document!.id, stage: 'extracting', pipelineVersion: 'test-0' })
    .returning({ id: processingRuns.id });

  return { documentId: document!.id, runId: run!.id };
}

function contextFor(seeded: { documentId: string; runId: string }): ProcessingContext {
  return {
    database,
    storageDir: '/tmp',
    job: { runId: seeded.runId, documentId: seeded.documentId, collectionId },
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
    const summary = await compareDocument(contextFor(report), { client });

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
    await compareDocument(contextFor(report), { client });

    const stored = await database.db
      .select({ id: relationships.id })
      .from(relationships)
      .where(eq(relationships.collectionId, collectionId));

    expect(stored).toHaveLength(1);
  }, 60_000);

  it('abstains rather than guessing when no classifier is configured', async () => {
    // The deterministic fallback. It reaches `corroborates` here because the pair is two
    // independent accepted claims agreeing in the same context, and it would abstain for
    // anything less clear-cut; it can never reach a contradiction.
    await database.db.delete(relationships).where(eq(relationships.collectionId, collectionId));

    const summary = await compareDocument(contextFor(report), {});

    expect(summary.classifiedDeterministically).toBe(1);
    expect(summary.classifiedByModel).toBe(0);

    const [stored] = await database.db
      .select({ label: relationships.label, method: relationships.method })
      .from(relationships)
      .where(eq(relationships.collectionId, collectionId));

    expect(stored?.method).toBe('deterministic');
    expect(['corroborates', 'insufficient_context']).toContain(stored?.label);
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
