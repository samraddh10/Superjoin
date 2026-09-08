/**
 * Candidate retrieval.
 *
 * Plan section 6.1: entity and predicate matching combined with embedding retrieval in
 * pgvector, embeddings taken over descriptions rather than values, a top-15 semantic
 * budget, same-entity/same-predicate exact matches kept *even when they fall outside the
 * semantic top-k*, no requirement that periods or scopes match, and comparison bounded to
 * one collection.
 *
 * The clause about keeping exact matches is the one that decides the shape of this file.
 * A vector search ranks by how a claim reads, and two documents describing the same
 * measure in different words can both be outranked by fifteen claims that merely sound
 * alike. The exact channel is therefore not a fallback for when embeddings are missing;
 * it runs every time, and its results are unioned in rather than competed with.
 *
 * Retrieval is cross-document by design. A new document is compared against everything
 * already stored in its collection, which is what makes ingestion incremental, and pairs
 * drawn from one document are left out: an inconsistency inside a single filing is a real
 * thing to look for, but it is not the comparison this system is being asked to make, and
 * including it would bury the cross-document pairs it is.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { claimEmbeddings, claimEvidence, claims, documents } from '@superjoin/db';

import type { AssertionStatus, PeriodType, Qualifier } from '../extraction/contract.ts';
import {
  describeClaim,
  EmbeddingUnavailableError,
  type EmbeddingProvider,
} from '../embedding/index.ts';
import { normalizeEntityLabel } from '../normalize/entities.ts';
import { predicateRelation } from '../normalize/predicates.ts';
import type { ComparableClaim } from './checks.ts';

/** Where a pair came from. Recorded so recall can be attributed in plan 8.1. */
export type CandidateSource = 'exact' | 'semantic';

export interface CandidatePair {
  readonly a: ComparableClaim;
  readonly b: ComparableClaim;
  readonly sources: readonly CandidateSource[];
  /** Cosine distance, when the pair was retrieved semantically. */
  readonly distance: number | null;
}

/**
 * Loads every claim in a collection that is fit to compare.
 *
 * Rejected claims are excluded: plan 4.3 requires unsupported claims to be kept out of
 * confident relationship conclusions, and the cheapest way to honour that is not to
 * retrieve them. Claims held for review are included, because a visual-only figure is
 * often the only reading of a table there is, and the pair it forms is marked provisional
 * rather than hidden.
 */
export async function loadComparableClaims(
  db: Database,
  collectionId: string,
): Promise<ComparableClaim[]> {
  const rows = await db
    .select({
      id: claims.id,
      documentId: claims.documentId,
      entityId: claims.entityId,
      subject: claims.subject,
      predicate: claims.predicate,
      originalStatement: claims.originalStatement,
      rawValue: claims.rawValue,
      numericValue: claims.numericValue,
      currency: claims.currency,
      scale: claims.scale,
      unit: claims.unit,
      periodLabel: claims.periodLabel,
      periodType: claims.periodType,
      periodStart: claims.periodStart,
      periodEnd: claims.periodEnd,
      scope: claims.scope,
      assertionStatus: claims.assertionStatus,
      qualifiers: claims.qualifiers,
      status: claims.status,
    })
    .from(claims)
    .innerJoin(documents, eq(documents.id, claims.documentId))
    .where(
      and(
        eq(documents.collectionId, collectionId),
        inArray(claims.status, ['accepted', 'needs_review']),
      ),
    );

  if (rows.length === 0) return [];

  const evidence = await db
    .select({ claimId: claimEvidence.claimId, sourceBlockId: claimEvidence.sourceBlockId })
    .from(claimEvidence)
    .where(inArray(claimEvidence.claimId, rows.map((row) => row.id)));

  const blocksByClaim = new Map<string, string[]>();
  for (const row of evidence) {
    const existing = blocksByClaim.get(row.claimId);
    if (existing === undefined) blocksByClaim.set(row.claimId, [row.sourceBlockId]);
    else existing.push(row.sourceBlockId);
  }

  return rows.map((row) => ({
    ...row,
    periodType: (row.periodType as PeriodType | null) ?? null,
    assertionStatus: (row.assertionStatus as AssertionStatus | null) ?? null,
    qualifiers: (row.qualifiers as Qualifier[] | null) ?? [],
    status: row.status as 'accepted' | 'needs_review',
    sourceBlockIds: blocksByClaim.get(row.id) ?? [],
  }));
}

export interface EmbeddingOutcome {
  readonly available: boolean;
  readonly embedded: number;
  /** Why retrieval fell back to exact matching alone, when it did. */
  readonly reason: string | null;
}

/**
 * Embeds any claim in the set that has no vector under the current model.
 *
 * Keyed on (claim, model) by the unique index, so a re-run embeds nothing and a change of
 * model produces a second vector alongside the first rather than overwriting it. Plan 6.1
 * forbids comparing vectors from different embedding models, which is only enforceable if
 * the old ones are still identifiable.
 */
export async function ensureClaimEmbeddings(
  db: Database,
  provider: EmbeddingProvider,
  toEmbed: readonly ComparableClaim[],
): Promise<EmbeddingOutcome> {
  if (toEmbed.length === 0) return { available: true, embedded: 0, reason: null };

  const existing = await db
    .select({ claimId: claimEmbeddings.claimId })
    .from(claimEmbeddings)
    .where(
      and(
        eq(claimEmbeddings.model, provider.model),
        inArray(claimEmbeddings.claimId, toEmbed.map((claim) => claim.id)),
      ),
    );

  const have = new Set(existing.map((row) => row.claimId));
  const missing = toEmbed.filter((claim) => !have.has(claim.id));
  if (missing.length === 0) return { available: true, embedded: 0, reason: null };

  const texts = missing.map((claim) =>
    describeClaim({
      subject: claim.subject,
      predicate: claim.predicate,
      scope: claim.scope,
      periodLabel: claim.periodLabel,
      unit: claim.unit,
      qualifiers: claim.qualifiers,
    }),
  );

  let vectors: number[][];
  try {
    vectors = await provider.embed(texts);
  } catch (error) {
    // Survivable. Exact matching still runs, and the caller records that semantic
    // retrieval was unavailable rather than reporting a recall figure that silently
    // excludes it.
    const reason =
      error instanceof EmbeddingUnavailableError
        ? error.message
        : `embedding failed: ${(error as Error).message}`;
    return { available: false, embedded: 0, reason };
  }

  const values = missing.map((claim, index) => ({
    claimId: claim.id,
    model: provider.model,
    dimensions: provider.dimensions,
    taskType: provider.taskType,
    embeddedText: texts[index]!,
    embedding: vectors[index]!,
  }));

  await db.insert(claimEmbeddings).values(values).onConflictDoNothing();

  return { available: true, embedded: values.length, reason: null };
}

/**
 * Whether two claims name the same thing closely enough to compare on names alone.
 *
 * Entity ids when both are resolved; the normalized subject otherwise. The fallback is
 * what keeps a collection usable when entity resolution has left subjects unmerged, which
 * plan 5.3 makes a normal outcome rather than a failure.
 */
function sameSubject(a: ComparableClaim, b: ComparableClaim): boolean {
  if (a.entityId !== null && b.entityId !== null) return a.entityId === b.entityId;
  return normalizeEntityLabel(a.subject).normalized === normalizeEntityLabel(b.subject).normalized;
}

export interface FindCandidatesOptions {
  readonly collectionId: string;
  /** The document just processed. Its claims are the left side of every pair. */
  readonly documentId: string;
  /** Semantic budget per claim. Plan 6.1 starts at 15. */
  readonly topK?: number;
  readonly provider?: EmbeddingProvider;
}

export interface CandidateResult {
  readonly pairs: readonly CandidatePair[];
  readonly exactPairs: number;
  readonly semanticPairs: number;
  readonly embedding: EmbeddingOutcome;
}

/**
 * Finds the pairs worth classifying for one document.
 *
 * Both channels run; their results are unioned and each pair records which channels found
 * it. That attribution is what plan 8.1's candidate-recall measurement needs: a pair that
 * only the exact channel ever finds is evidence about the embeddings, not about the pair.
 */
export async function findCandidates(
  db: Database,
  options: FindCandidatesOptions,
): Promise<CandidateResult> {
  const topK = options.topK ?? 15;
  const all = await loadComparableClaims(db, options.collectionId);
  const mine = all.filter((claim) => claim.documentId === options.documentId);
  const others = all.filter((claim) => claim.documentId !== options.documentId);

  if (mine.length === 0 || others.length === 0) {
    return {
      pairs: [],
      exactPairs: 0,
      semanticPairs: 0,
      embedding: { available: true, embedded: 0, reason: null },
    };
  }

  const embedding =
    options.provider === undefined
      ? { available: false, embedded: 0, reason: 'no embedding provider was configured' }
      : await ensureClaimEmbeddings(db, options.provider, all);

  const pairs = new Map<string, { pair: CandidatePair; sources: Set<CandidateSource> }>();

  const add = (a: ComparableClaim, b: ComparableClaim, source: CandidateSource, distance: number | null) => {
    // The ordering is the pair's identity, and it has to match the unique index on
    // (claim_a, claim_b, method_version) or a retried comparison inserts a mirror image
    // of a row that already exists.
    const [left, right] = a.id < b.id ? [a, b] : [b, a];
    const key = `${left.id}:${right.id}`;
    const existing = pairs.get(key);

    if (existing !== undefined) {
      existing.sources.add(source);
      return;
    }

    pairs.set(key, {
      pair: { a: left, b: right, sources: [source], distance },
      sources: new Set([source]),
    });
  };

  /**
   * Exact: same subject, and a predicate naming a related measure — regardless of period,
   * scope or rank. This channel is what guarantees the reconciliation cases survive
   * retrieval, since those are exactly the pairs whose contexts differ.
   *
   * It matched on identical predicate names until measurement showed that finds almost
   * nothing. Extraction names predicates freely, as plan 4.2 requires, and the cost is
   * that it names the same measure differently in every document: one collection produced
   * 1,053 distinct predicates from 1,991 claims, with `revenue`, `revenue_amount`,
   * `total_revenues` and `total_revenue_from_customers` all present separately. Requiring
   * identity left two candidate pairs in the whole collection, and corroboration — which
   * needs the same measure found in two documents — could not be reached at all.
   *
   * So the channel now accepts any predicate relation that is not positively ruled out.
   * `related_form` means "both concern revenue but are not the same measure", which is a
   * reason to look rather than a match; `explicitly_distinct` still blocks the pair,
   * because revenue from operations must never be equated with total income. Widening
   * retrieval is safe in a way that widening a verdict would not be: the deterministic
   * gate and the classifier still decide, and this only changes what they are shown.
   *
   * The subject must still match exactly, which is what keeps this bounded — only 29
   * entities in that collection appear in more than one document at all.
   */
  for (const claim of mine) {
    for (const other of others) {
      if (!sameSubject(claim, other)) continue;
      const relation = predicateRelation(claim.predicate, other.predicate).relation;
      if (relation === 'unrelated' || relation === 'explicitly_distinct') continue;
      add(claim, other, 'exact', null);
    }
  }

  const exactPairs = pairs.size;

  if (embedding.available && options.provider !== undefined) {
    const byId = new Map(others.map((claim) => [claim.id, claim]));

    for (const claim of mine) {
      const neighbours = await nearestNeighbours(db, {
        claimId: claim.id,
        collectionId: options.collectionId,
        excludeDocumentId: options.documentId,
        model: options.provider.model,
        topK,
      });

      for (const neighbour of neighbours) {
        const other = byId.get(neighbour.claimId);
        if (other === undefined) continue;
        add(claim, other, 'semantic', neighbour.distance);
      }
    }
  }

  const result = [...pairs.values()].map(({ pair, sources }) => ({
    ...pair,
    sources: [...sources],
  }));

  return {
    pairs: result,
    exactPairs,
    semanticPairs: pairs.size - exactPairs,
    embedding,
  };
}

interface Neighbour {
  readonly claimId: string;
  readonly distance: number;
}

/**
 * Exact nearest-neighbour search in pgvector.
 *
 * Exact rather than approximate, per plan 6.1: three documents do not justify an index,
 * and an approximate one would trade recall for a latency problem this corpus does not
 * have. The subquery reads the query claim's own vector in the database rather than
 * sending it back over the wire, which keeps the comparison inside one statement.
 */
async function nearestNeighbours(
  db: Database,
  options: {
    claimId: string;
    collectionId: string;
    excludeDocumentId: string;
    model: string;
    topK: number;
  },
): Promise<Neighbour[]> {
  const rows = await db.execute<{ claim_id: string; distance: number }>(sql`
    with query as (
      select embedding
      from ${claimEmbeddings}
      where ${claimEmbeddings.claimId} = ${options.claimId}
        and ${claimEmbeddings.model} = ${options.model}
      limit 1
    )
    select
      ${claimEmbeddings.claimId} as claim_id,
      (${claimEmbeddings.embedding} <=> (select embedding from query)) as distance
    from ${claimEmbeddings}
    join ${claims} on ${claims.id} = ${claimEmbeddings.claimId}
    join ${documents} on ${documents.id} = ${claims.documentId}
    where ${documents.collectionId} = ${options.collectionId}
      and ${claims.documentId} <> ${options.excludeDocumentId}
      and ${claims.status} in ('accepted', 'needs_review')
      and ${claimEmbeddings.model} = ${options.model}
      and exists (select 1 from query)
    order by distance
    limit ${options.topK}
  `);

  const list = Array.isArray(rows) ? rows : ((rows as { rows: unknown[] }).rows ?? []);

  return (list as { claim_id: string; distance: number | string }[]).map((row) => ({
    claimId: row.claim_id,
    distance: Number(row.distance),
  }));
}
