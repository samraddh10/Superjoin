/**
 * Reading a processed collection out of the database into the shapes the scorer wants.
 *
 * The scorer reads the same tables the interface does rather than a separate evaluation
 * export. An export would be a second description of what the pipeline produced, and the
 * two would eventually disagree about which one was being measured.
 */

import {
  claimEvidence,
  claims,
  collections,
  documents,
  processingIssues,
  processingRuns,
  relationships,
  sourceBlocks,
  type Database,
} from '@superjoin/db';
import { eq, inArray } from 'drizzle-orm';

import type { ProducedCandidate, ProducedRelationship, RunCost } from './metrics.ts';
import type { ProducedClaim, ProducedEvidence } from './match.ts';

export interface LoadedCollection {
  readonly collectionId: string;
  readonly name: string;
  /** Uploaded filename for a document id. Turned into a gold document id by the caller. */
  readonly filenameOf: (documentId: string) => string | undefined;
  readonly claims: readonly ProducedClaim[];
  readonly relationships: readonly ProducedRelationship[];
  readonly candidates: readonly ProducedCandidate[];
  readonly cost: RunCost;
}

export class CollectionNotFound extends Error {}

/** Resolves a collection by id, or by exact name when an id was not given. */
export async function resolveCollection(
  db: Database,
  idOrName: string,
): Promise<{ id: string; name: string }> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName);

  const rows = isUuid
    ? await db.select().from(collections).where(eq(collections.id, idOrName)).limit(1)
    : await db.select().from(collections).where(eq(collections.name, idOrName)).limit(1);

  const row = rows[0];
  if (row === undefined) throw new CollectionNotFound(`no collection matching ${idOrName}`);
  return { id: row.id, name: row.name };
}

export async function loadCollection(
  db: Database,
  collectionId: string,
  name: string,
): Promise<LoadedCollection> {
  const documentRows = await db
    .select()
    .from(documents)
    .where(eq(documents.collectionId, collectionId));

  const filenames = new Map(documentRows.map((row) => [row.id, row.filename]));
  const documentIds = documentRows.map((row) => row.id);

  const claimRows =
    documentIds.length === 0
      ? []
      : await db.select().from(claims).where(inArray(claims.documentId, documentIds));

  const claimIds = claimRows.map((row) => row.id);

  const evidenceRows =
    claimIds.length === 0
      ? []
      : await db
          .select({ evidence: claimEvidence, block: sourceBlocks })
          .from(claimEvidence)
          .innerJoin(sourceBlocks, eq(sourceBlocks.id, claimEvidence.sourceBlockId))
          .where(inArray(claimEvidence.claimId, claimIds));

  const evidenceByClaim = new Map<string, ProducedEvidence[]>();
  for (const row of evidenceRows) {
    const list = evidenceByClaim.get(row.evidence.claimId) ?? [];
    list.push({
      id: row.evidence.id,
      quote: row.evidence.quote,
      blockDocumentId: row.block.documentId,
      blockContent: row.block.content,
      physicalPage: row.block.physicalPage,
      verification: row.evidence.verification,
      entailment: row.evidence.entailment,
    });
    evidenceByClaim.set(row.evidence.claimId, list);
  }

  const producedClaims: ProducedClaim[] = claimRows.map((row) => {
    const evidence = evidenceByClaim.get(row.id) ?? [];
    return {
      id: row.id,
      documentId: row.documentId,
      filename: filenames.get(row.documentId) ?? '',
      subject: row.subject,
      predicate: row.predicate,
      numericValue: row.numericValue,
      scale: row.scale,
      currency: row.currency,
      unit: row.unit,
      periodLabel: row.periodLabel,
      periodType: row.periodType,
      scope: row.scope,
      status: row.status,
      pages: [...new Set(evidence.map((item) => item.physicalPage))].sort((a, b) => a - b),
      evidence,
    };
  });

  const relationshipRows = await db
    .select()
    .from(relationships)
    .where(eq(relationships.collectionId, collectionId));

  const producedRelationships: ProducedRelationship[] = relationshipRows.map((row) => ({
    id: row.id,
    claimAId: row.claimAId,
    claimBId: row.claimBId,
    label: row.label,
    method: row.method,
  }));

  /**
   * Every stored relationship was a retrieved candidate, so the relationship table is a
   * lower bound on retrieval. Pairs that retrieval surfaced and the classifier then
   * declined to store are not recoverable from the database, so candidate recall
   * measured this way cannot exceed classification coverage; the report says so rather
   * than presenting it as pure retrieval performance.
   */
  const candidates: ProducedCandidate[] = relationshipRows.map((row) => ({
    claimAId: row.claimAId,
    claimBId: row.claimBId,
  }));

  const runRows =
    documentIds.length === 0
      ? []
      : await db
          .select()
          .from(processingRuns)
          .where(inArray(processingRuns.documentId, documentIds));

  const runIds = runRows.map((row) => row.id);
  const issueRows =
    runIds.length === 0
      ? []
      : await db.select().from(processingIssues).where(inArray(processingIssues.runId, runIds));

  const issuesByKind = new Map<string, number>();
  for (const issue of issueRows) {
    issuesByKind.set(issue.failureKind, (issuesByKind.get(issue.failureKind) ?? 0) + 1);
  }

  const stages = new Map<string, number>();
  for (const run of runRows) stages.set(run.stage, (stages.get(run.stage) ?? 0) + 1);

  const started = runRows
    .map((run) => run.startedAt?.getTime())
    .filter((time): time is number => time !== undefined);
  const finished = runRows
    .map((run) => run.finishedAt?.getTime())
    .filter((time): time is number => time !== undefined);

  const sum = (pick: (run: (typeof runRows)[number]) => number | null): number =>
    runRows.reduce((total, run) => total + (pick(run) ?? 0), 0);

  const cost: RunCost = {
    documents: documentRows.length,
    pagesTotal: sum((run) => run.pagesTotal),
    pagesProcessed: sum((run) => run.pagesProcessed),
    chunksTotal: sum((run) => run.chunksTotal),
    chunksProcessed: sum((run) => run.chunksProcessed),
    inputTokens: sum((run) => run.inputTokens),
    outputTokens: sum((run) => run.outputTokens),
    claimsExtracted: sum((run) => run.claimsExtracted),
    claimsAccepted: sum((run) => run.claimsAccepted),
    relationshipsCreated: sum((run) => run.relationshipsCreated),
    wallClockMs:
      started.length > 0 && finished.length > 0
        ? Math.max(...finished) - Math.min(...started)
        : null,
    issuesByKind,
    stages,
  };

  return {
    collectionId,
    name,
    filenameOf: (documentId: string) => filenames.get(documentId),
    claims: producedClaims,
    relationships: producedRelationships,
    candidates,
    cost,
  };
}

/**
 * What parsing produced, independent of any gold set.
 *
 * Plan 8.1 asks for failed-page and chunk counts; this is that, plus the structural
 * coverage that says whether parsing generalized. It needs no ground truth, which is the
 * point: on a held-out collection with no reviewed sample, this is the part that can
 * still be measured, and a drop in printed-label or bounding-box coverage is a finding
 * even when nothing downstream ran.
 */
export interface StructureSummary {
  readonly blocks: number;
  readonly pagesTotal: number;
  readonly pagesWithBlocks: number;
  readonly byType: ReadonlyMap<string, number>;
  readonly withPrintedLabel: number;
  readonly withBoundingBox: number;
  readonly modelTranscribed: number;
}

export async function loadStructure(
  db: Database,
  collectionId: string,
): Promise<StructureSummary> {
  const documentRows = await db
    .select({ id: documents.id, pageCount: documents.pageCount })
    .from(documents)
    .where(eq(documents.collectionId, collectionId));

  const documentIds = documentRows.map((row) => row.id);
  const pagesTotal = documentRows.reduce((total, row) => total + (row.pageCount ?? 0), 0);

  if (documentIds.length === 0) {
    return {
      blocks: 0,
      pagesTotal: 0,
      pagesWithBlocks: 0,
      byType: new Map(),
      withPrintedLabel: 0,
      withBoundingBox: 0,
      modelTranscribed: 0,
    };
  }

  const rows = await db
    .select({
      documentId: sourceBlocks.documentId,
      physicalPage: sourceBlocks.physicalPage,
      blockType: sourceBlocks.blockType,
      printedPageLabel: sourceBlocks.printedPageLabel,
      bboxX: sourceBlocks.bboxX,
      extractionMethod: sourceBlocks.extractionMethod,
    })
    .from(sourceBlocks)
    .where(inArray(sourceBlocks.documentId, documentIds));

  const byType = new Map<string, number>();
  const pages = new Set<string>();
  let withPrintedLabel = 0;
  let withBoundingBox = 0;
  let modelTranscribed = 0;

  for (const row of rows) {
    byType.set(row.blockType, (byType.get(row.blockType) ?? 0) + 1);
    pages.add(`${row.documentId}#${row.physicalPage}`);
    if (row.printedPageLabel !== null) withPrintedLabel += 1;
    if (row.bboxX !== null) withBoundingBox += 1;
    if (row.extractionMethod === 'model_transcription') modelTranscribed += 1;
  }

  return {
    blocks: rows.length,
    pagesTotal,
    pagesWithBlocks: pages.size,
    byType,
    withPrintedLabel,
    withBoundingBox,
    modelTranscribed,
  };
}
