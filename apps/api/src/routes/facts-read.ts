/**
 * Reading claims and their evidence out of the database and onto the wire.
 *
 * Shared by the facts endpoints and the relationship endpoints, because a relationship is
 * mostly two claims and showing it means showing both of them in full. Plan 6.4 requires
 * the original claims to survive comparison untouched, so there is one representation of
 * a claim and the relationship views use it rather than a flattened summary of their own.
 *
 * Every list here loads its evidence for the whole page of claims in one query. The
 * obvious alternative, a query per claim, turns a fifty-row list into fifty-one round
 * trips and would show up first as a slow relationships view.
 */

import type { EvidenceItem, FactDetail, FactSummary } from '@superjoin/contracts';
import {
  claimEvidence,
  claims,
  documents,
  entities,
  relationships,
  sourceBlocks,
  type Database,
} from '@superjoin/db';
import { and, count, eq, inArray, or, sql } from 'drizzle-orm';

/** The joined shape every claim query selects, so one mapper serves all of them. */
export interface ClaimRow {
  readonly claim: typeof claims.$inferSelect;
  readonly filename: string;
  readonly collectionId: string;
  readonly entityLabel: string | null;
}

export const claimSelection = {
  claim: claims,
  filename: documents.filename,
  collectionId: documents.collectionId,
  entityLabel: entities.canonicalLabel,
} as const;

/**
 * Joins a claim to the document it came from and the entity it resolved to.
 *
 * The document join is inner: a claim without a document cannot exist and would be a
 * broken row rather than a claim to display. The entity join is outer, because plan 5.3
 * requires an uncertain entity to be left unmerged, so an unresolved subject is a normal
 * state and must not remove the claim from the list.
 */
export function claimQuery(db: Database) {
  return db
    .select(claimSelection)
    .from(claims)
    .innerJoin(documents, eq(documents.id, claims.documentId))
    .leftJoin(entities, eq(entities.id, claims.entityId));
}

/** Qualifiers are stored as JSONB and re-checked here rather than trusted by shape. */
function readQualifiers(value: unknown): { name: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { name, value: qualifierValue } = entry as { name?: unknown; value?: unknown };
    if (typeof name !== 'string' || typeof qualifierValue !== 'string') return [];
    return [{ name, value: qualifierValue }];
  });
}

/**
 * Pages and evidence counts for a set of claims, in one query.
 *
 * Pages are what the list row shows and what the viewer navigates by, so they are read
 * from the source block rather than from anything the model said about where it looked.
 */
export async function loadEvidenceIndex(
  db: Database,
  claimIds: readonly string[],
): Promise<Map<string, { pages: number[]; evidenceCount: number }>> {
  const index = new Map<string, { pages: number[]; evidenceCount: number }>();
  if (claimIds.length === 0) return index;

  const rows = await db
    .select({
      claimId: claimEvidence.claimId,
      physicalPage: sourceBlocks.physicalPage,
    })
    .from(claimEvidence)
    .innerJoin(sourceBlocks, eq(sourceBlocks.id, claimEvidence.sourceBlockId))
    .where(inArray(claimEvidence.claimId, [...claimIds]));

  for (const row of rows) {
    const entry = index.get(row.claimId) ?? { pages: [], evidenceCount: 0 };
    entry.evidenceCount += 1;
    if (!entry.pages.includes(row.physicalPage)) entry.pages.push(row.physicalPage);
    index.set(row.claimId, entry);
  }
  for (const entry of index.values()) entry.pages.sort((a, b) => a - b);
  return index;
}

export function toFactSummary(
  row: ClaimRow,
  evidence: { pages: number[]; evidenceCount: number } | undefined,
): FactSummary {
  const { claim } = row;
  return {
    id: claim.id,
    documentId: claim.documentId,
    filename: row.filename,
    subject: claim.subject,
    predicate: claim.predicate,
    originalStatement: claim.originalStatement,
    // NUMERIC comes back from the driver as a string and stays one all the way to the
    // browser, per plan 4.1. Nothing here may parse it.
    rawValue: claim.rawValue,
    numericValue: claim.numericValue,
    normalizedValue: claim.normalizedValue,
    normalizedUnit: claim.normalizedUnit,
    currency: claim.currency,
    scale: claim.scale,
    unit: claim.unit,
    periodLabel: claim.periodLabel,
    periodType: claim.periodType,
    scope: claim.scope,
    assertionStatus: claim.assertionStatus,
    status: claim.status,
    statusReason: claim.statusReason,
    entityId: claim.entityId,
    entityLabel: row.entityLabel,
    pages: evidence?.pages ?? [],
    evidenceCount: evidence?.evidenceCount ?? 0,
    createdAt: claim.createdAt.toISOString(),
  };
}

/**
 * Every evidence link for a set of claims, with the source block resolved.
 *
 * verification and entailment are carried side by side and never collapsed into one
 * "valid" flag: plan 4.3 requires the two to stay separable, because a quote that is
 * genuinely in the document can still fail to support the claim citing it.
 */
export async function loadEvidence(
  db: Database,
  claimIds: readonly string[],
): Promise<Map<string, EvidenceItem[]>> {
  const byClaim = new Map<string, EvidenceItem[]>();
  if (claimIds.length === 0) return byClaim;

  const rows = await db
    .select({
      evidence: claimEvidence,
      block: sourceBlocks,
      filename: documents.filename,
    })
    .from(claimEvidence)
    .innerJoin(sourceBlocks, eq(sourceBlocks.id, claimEvidence.sourceBlockId))
    .innerJoin(documents, eq(documents.id, sourceBlocks.documentId))
    .where(inArray(claimEvidence.claimId, [...claimIds]))
    .orderBy(sourceBlocks.physicalPage, sourceBlocks.blockIndex);

  for (const row of rows) {
    const { evidence, block } = row;
    const hasBox =
      block.bboxX !== null &&
      block.bboxY !== null &&
      block.bboxWidth !== null &&
      block.bboxHeight !== null;

    const item: EvidenceItem = {
      id: evidence.id,
      quote: evidence.quote,
      quoteStart: evidence.quoteStart,
      quoteEnd: evidence.quoteEnd,
      verification: evidence.verification,
      entailment: evidence.entailment,
      verificationNote: evidence.verificationNote,
      supportRole: evidence.supportRole,
      block: {
        id: block.id,
        documentId: block.documentId,
        filename: row.filename,
        physicalPage: block.physicalPage,
        printedPageLabel: block.printedPageLabel,
        blockType: block.blockType,
        extractionMethod: block.extractionMethod,
        content: block.content,
        tableHeaders: block.tableHeaders ?? null,
        bbox: hasBox
          ? {
              x: block.bboxX!,
              y: block.bboxY!,
              width: block.bboxWidth!,
              height: block.bboxHeight!,
            }
          : null,
        coordinateOrigin: block.coordinateOrigin,
        pageWidthPt: block.pageWidthPt,
        pageHeightPt: block.pageHeightPt,
        pageRotation: block.pageRotation,
        pageImageKey: block.pageImageKey,
      },
    };

    const list = byClaim.get(evidence.claimId);
    if (list === undefined) byClaim.set(evidence.claimId, [item]);
    else list.push(item);
  }

  return byClaim;
}

/** How many relationships each claim takes part in, counting both sides of the pair. */
export async function loadRelationshipCounts(
  db: Database,
  claimIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (claimIds.length === 0) return counts;

  const ids = [...claimIds];
  const wanted = new Set(ids);
  const rows = await db
    .select({ claimAId: relationships.claimAId, claimBId: relationships.claimBId })
    .from(relationships)
    .where(
      or(inArray(relationships.claimAId, ids), inArray(relationships.claimBId, ids)),
    );

  // Both sides are counted, but only for claims that were asked about: the other end of
  // a pair is a claim the caller did not request and must not appear in the result.
  for (const row of rows) {
    for (const id of [row.claimAId, row.claimBId]) {
      if (!wanted.has(id)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Assembles full claim details for a set of ids, in a fixed number of queries. */
export async function loadFactDetails(
  db: Database,
  claimIds: readonly string[],
): Promise<Map<string, FactDetail>> {
  const details = new Map<string, FactDetail>();
  if (claimIds.length === 0) return details;

  const rows = await claimQuery(db).where(inArray(claims.id, [...claimIds]));
  const ids = rows.map((row) => row.claim.id);

  const [index, evidence, relationshipCounts] = await Promise.all([
    loadEvidenceIndex(db, ids),
    loadEvidence(db, ids),
    loadRelationshipCounts(db, ids),
  ]);

  for (const row of rows) {
    const { claim } = row;
    details.set(claim.id, {
      ...toFactSummary(row, index.get(claim.id)),
      collectionId: row.collectionId,
      runId: claim.runId,
      factGroupId: claim.factGroupId,
      valuePrecision: claim.valuePrecision,
      periodStart: claim.periodStart?.toISOString() ?? null,
      periodEnd: claim.periodEnd?.toISOString() ?? null,
      qualifiers: readQualifiers(claim.qualifiers),
      normalization: claim.normalization ?? null,
      evidence: evidence.get(claim.id) ?? [],
      relationshipCount: relationshipCounts.get(claim.id) ?? 0,
    });
  }

  return details;
}

/** Distinct predicates in a collection, so the filter offers values that actually exist. */
export async function loadPredicates(
  db: Database,
  collectionId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ predicate: claims.predicate })
    .from(claims)
    .innerJoin(documents, eq(documents.id, claims.documentId))
    .where(eq(documents.collectionId, collectionId))
    .orderBy(claims.predicate);
  return rows.map((row) => row.predicate);
}

/** Total matching claims, run as its own count so the page size does not limit it. */
export async function countClaims(
  db: Database,
  where: ReturnType<typeof and>,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(claims)
    .innerJoin(documents, eq(documents.id, claims.documentId))
    .where(where);
  return row?.total ?? 0;
}

/**
 * Orders claims by document, then page, then position on the page.
 *
 * Reading order rather than insertion order: a reviewer scanning the list is following
 * the document, and extraction order reflects chunk scheduling, which is arbitrary to
 * them. Ties break on id so paging is stable across requests.
 */
export const claimOrdering = [
  documents.filename,
  sql`(
    select min(sb.physical_page)
    from claim_evidence ce
    join source_blocks sb on sb.id = ce.source_block_id
    where ce.claim_id = ${claims.id}
  ) nulls last`,
  claims.id,
];
