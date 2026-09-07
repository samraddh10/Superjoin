/**
 * The Phase 7.1 read endpoints, driven through Fastify's own injection against a live
 * database.
 *
 * Fixtures are inserted directly rather than produced by running the pipeline. What is
 * under test is the read path — filters, pagination, the shape that reaches the browser —
 * and making each assertion wait on an extraction would test the model instead, at a
 * rate limit, without making the query any more correct.
 *
 * The fixture is built to make the interesting cases real: two documents that state the
 * same measure differently, a claim whose only support is a model transcription, and a
 * relationship whose deterministic checks are attached.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '@superjoin/config';
import {
  claimEvidence,
  claims,
  collections,
  documents,
  entities,
  processingRuns,
  relationships,
  sourceBlocks,
} from '@superjoin/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer, PIPELINE_VERSION, type Server } from '../server.ts';

const THREE_PAGES = 'tests/fixtures/three-blank-pages.pdf';

const baseConfig = loadConfig();
const reachable = await (async () => {
  const { createDatabase, closeDatabase } = await import('@superjoin/db');
  const handle = createDatabase(baseConfig.databaseUrl);
  const ok = await handle.pool
    .query('select 1')
    .then(() => true)
    .catch(() => false);
  await closeDatabase(handle);
  return ok;
})();

let server: Server;
let storageDir: string;

/** Ids of the fixture, filled in by beforeAll and read by the assertions. */
interface Fixture {
  collectionId: string;
  reportId: string;
  excerptId: string;
  reportedClaimId: string;
  restatedClaimId: string;
  visualClaimId: string;
  relationshipId: string;
  storageKey: string;
}
let fixture: Fixture;

beforeAll(async () => {
  if (!reachable) return;
  storageDir = await mkdtemp(join(tmpdir(), 'superjoin-review-'));
  server = await buildServer({ ...baseConfig, storageDir, port: 0 }, { logger: false });
  await server.app.ready();

  const { db } = server.database;

  const [collection] = await db
    .insert(collections)
    .values({ name: `review-${randomUUID()}` })
    .returning();
  const collectionId = collection!.id;

  // A real PDF on disk, so the file endpoint serves something a viewer could open.
  const pdfBytes = new Uint8Array(await readFile(THREE_PAGES));
  const storageKey = `${randomUUID()}.pdf`;
  await writeFile(join(storageDir, storageKey), pdfBytes);

  const [report] = await db
    .insert(documents)
    .values({
      collectionId,
      filename: 'annual-report.pdf',
      contentHash: randomUUID(),
      storageKey,
      byteSize: pdfBytes.byteLength,
      pageCount: 3,
    })
    .returning();

  const [excerpt] = await db
    .insert(documents)
    .values({
      collectionId,
      filename: 'analyst-excerpt.pdf',
      contentHash: randomUUID(),
      // Deliberately points at nothing on disk: the missing-file case is a real one and
      // the endpoint has to report it as its own condition.
      storageKey: `${randomUUID()}.pdf`,
      byteSize: 1024,
      pageCount: 2,
    })
    .returning();

  const [run] = await db
    .insert(processingRuns)
    .values({
      documentId: report!.id,
      stage: 'completed',
      pipelineVersion: PIPELINE_VERSION,
      pagesTotal: 3,
      pagesProcessed: 3,
      claimsExtracted: 3,
      claimsAccepted: 2,
      relationshipsCreated: 1,
    })
    .returning();

  const [entity] = await db
    .insert(entities)
    .values({
      collectionId,
      canonicalLabel: 'Example Logistics Limited',
      entityType: 'company',
      normalizedLabel: 'example logistics',
    })
    .returning();

  async function addBlock(
    documentId: string,
    physicalPage: number,
    blockIndex: number,
    content: string,
    method: 'native_text' | 'model_transcription' = 'native_text',
  ): Promise<string> {
    const [block] = await db
      .insert(sourceBlocks)
      .values({
        documentId,
        physicalPage,
        blockIndex,
        blockType: 'paragraph',
        extractionMethod: method,
        content,
        producedBy: 'test-fixture',
        pageWidthPt: 595,
        pageHeightPt: 842,
      })
      .returning();
    return block!.id;
  }

  const reportBlock = await addBlock(
    report!.id,
    1,
    0,
    'Revenue from operations for FY2024 stood at 8,142 Cr.',
  );
  const excerptBlock = await addBlock(
    excerpt!.id,
    0,
    0,
    'Revenue from operations was 81,415 million for the year ended March 2024.',
  );
  const visualBlock = await addBlock(
    report!.id,
    2,
    0,
    'Adjusted EBITDA | FY2024 | (1,229)',
    'model_transcription',
  );

  async function addClaim(
    documentId: string,
    values: Partial<typeof claims.$inferInsert> & { predicate: string; subject: string },
  ): Promise<string> {
    const [claim] = await db
      .insert(claims)
      .values({
        documentId,
        runId: run!.id,
        entityId: entity!.id,
        originalStatement: values.originalStatement ?? '',
        assertionFingerprint: randomUUID(),
        ...values,
      })
      .returning();
    return claim!.id;
  }

  const reportedClaimId = await addClaim(report!.id, {
    subject: 'Example Logistics Limited',
    predicate: 'revenue_from_operations',
    originalStatement: 'Revenue from operations for FY2024 stood at 8,142 Cr.',
    rawValue: '8,142 Cr',
    numericValue: '8142',
    normalizedValue: '81420000000',
    normalizedUnit: 'INR',
    currency: 'INR',
    scale: 'crore',
    periodLabel: 'FY2024',
    periodType: 'fiscal_year',
    scope: 'consolidated',
    assertionStatus: 'reported',
    status: 'accepted',
    valuePrecision: 4,
    normalization: { version: '1', valueSteps: [{ step: 'scale', from: '8142', to: '81420000000' }] },
  });

  const restatedClaimId = await addClaim(excerpt!.id, {
    subject: 'Example Logistics',
    predicate: 'revenue_from_operations',
    originalStatement: 'Revenue from operations was 81,415 million for the year ended March 2024.',
    rawValue: '81,415 million',
    numericValue: '81415',
    normalizedValue: '81415000000',
    normalizedUnit: 'INR',
    currency: 'INR',
    scale: 'million',
    periodLabel: 'FY2024',
    periodType: 'fiscal_year',
    scope: 'consolidated',
    assertionStatus: 'reported',
    status: 'accepted',
    valuePrecision: 5,
  });

  const visualClaimId = await addClaim(report!.id, {
    subject: 'Example Logistics Limited',
    predicate: 'adjusted_ebitda',
    originalStatement: 'Adjusted EBITDA | FY2024 | (1,229)',
    rawValue: '(1,229)',
    numericValue: '-1229',
    scale: 'crore',
    periodLabel: 'FY2024',
    // Supported only by a transcription the model itself wrote, so it stays in review.
    status: 'needs_review',
    statusReason: 'supported only by a model transcription of the page image',
  });

  await db.insert(claimEvidence).values([
    {
      claimId: reportedClaimId,
      sourceBlockId: reportBlock,
      quote: 'Revenue from operations for FY2024 stood at 8,142 Cr.',
      quoteStart: 0,
      quoteEnd: 52,
      verification: 'verified_native_text',
      entailment: 'supported',
    },
    {
      claimId: restatedClaimId,
      sourceBlockId: excerptBlock,
      quote: 'Revenue from operations was 81,415 million',
      verification: 'verified_native_text',
      entailment: 'supported',
    },
    {
      claimId: visualClaimId,
      sourceBlockId: visualBlock,
      quote: 'Adjusted EBITDA | FY2024 | (1,229)',
      verification: 'visual_only',
      entailment: 'unclear',
      verificationNote: 'no native text layer on this page',
    },
  ]);

  const [relationship] = await db
    .insert(relationships)
    .values({
      collectionId,
      claimAId: reportedClaimId,
      claimBId: restatedClaimId,
      label: 'corroborates',
      rationale:
        '8,142 Cr rounded to the crore covers 81,415 million; same period, scope and currency.',
      contextDifferences: [
        { dimension: 'unit', a: 'crore', b: 'million', couldExplainGap: true },
      ],
      uncertaintyReasons: [],
      deterministicChecks: { version: '1', bothAccepted: true, sameDocument: false },
      supportingEvidenceIds: [],
      method: 'model',
      methodVersion: 'test-1',
      modelName: 'google/gemma-4-26b-a4b-it:free',
      promptVersion: 'test',
    })
    .returning();

  fixture = {
    collectionId,
    reportId: report!.id,
    excerptId: excerpt!.id,
    reportedClaimId,
    restatedClaimId,
    visualClaimId,
    relationshipId: relationship!.id,
    storageKey,
  };
}, 60_000);

afterAll(async () => {
  if (!reachable) return;
  // Cascades through documents, claims, evidence and relationships.
  await server.database.db.delete(collections).where(eq(collections.id, fixture.collectionId));
  await server.close();
  await rm(storageDir, { recursive: true, force: true });
});

describe.skipIf(!reachable)('listing facts', () => {
  it('returns every claim in the collection regardless of status', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/facts`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(3);

    // needs_review is a real outcome, not a hidden failure: suppressing it would inflate
    // the grounding precision Phase 8.1 has to report honestly.
    const statuses = body.items.map((item: { status: string }) => item.status).sort();
    expect(statuses).toEqual(['accepted', 'accepted', 'needs_review']);
  });

  it('keeps decimal figures as strings', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/facts`,
    });

    const claim = response
      .json()
      .items.find((item: { id: string }) => item.id === fixture.reportedClaimId);

    // Plan 4.1: a financial value must not pass through a JavaScript number, and JSON
    // parsing in the browser would do exactly that if these were sent as numbers.
    expect(typeof claim.numericValue).toBe('string');
    expect(claim.numericValue).toBe('8142');
    expect(typeof claim.normalizedValue).toBe('string');
  });

  it('reports the pages its evidence lands on and the evidence count', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/facts`,
    });

    const claim = response
      .json()
      .items.find((item: { id: string }) => item.id === fixture.reportedClaimId);

    expect(claim.pages).toEqual([1]);
    expect(claim.evidenceCount).toBe(1);
    expect(claim.entityLabel).toBe('Example Logistics Limited');
  });

  it('filters by document, predicate and status', async () => {
    const byDocument = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/facts?documentId=${fixture.excerptId}`,
    });
    expect(byDocument.json().total).toBe(1);
    expect(byDocument.json().items[0].id).toBe(fixture.restatedClaimId);

    const byPredicate = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/facts?predicate=adjusted_ebitda`,
    });
    expect(byPredicate.json().total).toBe(1);
    expect(byPredicate.json().items[0].id).toBe(fixture.visualClaimId);

    const byStatus = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/facts?status=needs_review`,
    });
    expect(byStatus.json().total).toBe(1);
  });

  it('offers the collection predicates unfiltered, so a chosen filter can be changed', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/facts?predicate=adjusted_ebitda`,
    });

    expect(response.json().items).toHaveLength(1);
    expect(response.json().predicates).toEqual(['adjusted_ebitda', 'revenue_from_operations']);
  });

  it('paginates with a total that is not the page size', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/facts?limit=1&offset=0`,
    });

    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.limit).toBe(1);
  });

  it('rejects an out-of-range limit and 404s an unknown collection', async () => {
    const bad = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/facts?limit=5000`,
    });
    expect(bad.statusCode).toBe(400);

    const missing = await server.app.inject({
      method: 'GET',
      url: `/collections/${randomUUID()}/facts`,
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe.skipIf(!reachable)('one fact in full', () => {
  it('carries evidence with verification and entailment kept apart', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/facts/${fixture.visualClaimId}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.evidence).toHaveLength(1);

    // Plan 4.3: a quote that exists is a separate question from a quote that supports the
    // claim. The transcription is present, and what it supports is not settled.
    expect(body.evidence[0].verification).toBe('visual_only');
    expect(body.evidence[0].entailment).toBe('unclear');
    expect(body.evidence[0].block.extractionMethod).toBe('model_transcription');
    expect(body.status).toBe('needs_review');
    expect(body.statusReason).toContain('transcription');
  });

  it('resolves the evidence block to a physical page and its geometry', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/facts/${fixture.reportedClaimId}`,
    });

    const block = response.json().evidence[0].block;
    expect(block.physicalPage).toBe(1);
    expect(block.filename).toBe('annual-report.pdf');
    expect(block.pageWidthPt).toBe(595);
    expect(block.coordinateOrigin).toBe('bottom-left');
    // No box was stored, and page navigation does not depend on one (plan 7.3).
    expect(block.bbox).toBeNull();
  });

  it('carries the normalization audit trail and the relationship count', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/facts/${fixture.reportedClaimId}`,
    });

    const body = response.json();
    expect(body.normalization.valueSteps).toHaveLength(1);
    expect(body.relationshipCount).toBe(1);
  });

  it('404s an unknown fact', async () => {
    const response = await server.app.inject({ method: 'GET', url: `/facts/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
  });
});

describe.skipIf(!reachable)('relationships', () => {
  it('returns both claims in full rather than a pair of ids', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/relationships`,
    });

    expect(response.statusCode).toBe(200);
    const item = response.json().items[0];

    // Plan 6.4: the two claims survive comparison untouched and are the answer itself.
    expect(item.claimA.originalStatement).toContain('8,142 Cr');
    expect(item.claimB.originalStatement).toContain('81,415 million');
    expect(item.claimA.evidence).toHaveLength(1);
  });

  it('carries no confidence figure', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/relationships/${fixture.relationshipId}`,
    });

    const body = response.json();
    // Plan 6.4 forbids presenting a model score as a calibrated probability. None is
    // stored, and the wire shape must not acquire one by accident later.
    expect(body).not.toHaveProperty('confidence');
    expect(body).not.toHaveProperty('score');
    expect(body.rationale).toContain('rounded to the crore');
  });

  it('reports the differing context dimensions and the deterministic checks', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/relationships/${fixture.relationshipId}`,
    });

    const body = response.json();
    expect(body.contextDifferences).toEqual([
      { dimension: 'unit', a: 'crore', b: 'million', couldExplainGap: true },
    ]);
    // Inputs to classification, not proof of the label (plan 6.2).
    expect(body.deterministicChecks.bothAccepted).toBe(true);
  });

  it('filters by label and counts every label in the collection', async () => {
    const matching = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/relationships?label=corroborates`,
    });
    expect(matching.json().total).toBe(1);

    const other = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/relationships?label=contradicts`,
    });
    expect(other.json().total).toBe(0);
    // Counts are collection-wide, so the chips still show what else exists.
    expect(other.json().counts.corroborates).toBe(1);
  });

  it('counts every label, including the ones with no rows', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/relationships`,
    });

    // A label absent from the map and a label with zero rows mean the same thing to a
    // reader, so all six are always present. The contract's record is exhaustive over the
    // enum, and a partial map fails validation in the browser rather than at the boundary.
    expect(Object.keys(response.json().counts).sort()).toEqual([
      'contradicts',
      'corroborates',
      'insufficient_context',
      'likely_contradiction',
      'reconciled_by_context',
      'unrelated',
    ]);
    expect(response.json().counts.contradicts).toBe(0);
  });

  it('matches a claim on either side of the pair', async () => {
    for (const claimId of [fixture.reportedClaimId, fixture.restatedClaimId]) {
      const response = await server.app.inject({
        method: 'GET',
        url: `/collections/${fixture.collectionId}/relationships?claimId=${claimId}`,
      });
      expect(response.json().total).toBe(1);
    }
  });

  it('404s an unknown relationship', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/relationships/${randomUUID()}`,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe.skipIf(!reachable)('documents', () => {
  it('lists documents with their latest run, counts and issues', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/collections/${fixture.collectionId}/documents`,
    });

    expect(response.statusCode).toBe(200);
    const items = response.json().items;
    expect(items).toHaveLength(2);

    const report = items.find((item: { id: string }) => item.id === fixture.reportId);
    expect(report.latestRun.stage).toBe('completed');
    expect(report.latestRun.terminal).toBe(true);
    expect(report.latestRun.stalled).toBe(false);
    expect(report.latestRun.claimsAccepted).toBe(2);
    expect(report.latestRun.issues).toEqual([]);

    // A document that was never queued has no run, which is a state the view must render.
    const excerpt = items.find((item: { id: string }) => item.id === fixture.excerptId);
    expect(excerpt.latestRun).toBeNull();
  });

  it('serves the original PDF inline', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/documents/${fixture.reportId}/file`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toContain('inline');
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('reports a missing file as its own condition, not as success', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/documents/${fixture.excerptId}/file`,
    });

    // The row exists and the bytes do not. Plan 2.1 warns against a document that looks
    // successful when its file is gone, so this is 410 rather than 404 or 500.
    expect(response.statusCode).toBe(410);
    expect(response.json().error).toBe('file_missing');
  });

  it('404s an unknown document', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/documents/${randomUUID()}/file`,
    });
    expect(response.statusCode).toBe(404);
  });
});
