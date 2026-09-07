/**
 * Relationship endpoints: the filtered list and one relationship in full.
 *
 * A relationship is returned with both claims attached rather than as a pair of ids. Plan
 * 6.4 requires the original claims to survive comparison untouched and forbids replacing
 * conflicting values with a single resolved truth, so the two claims are the answer, not
 * a lookup the caller performs afterwards.
 *
 * No confidence figure is returned, because none is stored. Plan 6.4 forbids presenting a
 * model-generated score as a calibrated probability, and a number on the screen would be
 * read as one no matter how it were labelled. What is returned instead is the rationale,
 * the differing context dimensions, the reasons for any remaining uncertainty, and the
 * deterministic checks the classifier was given.
 */

import {
  relationshipLabelSchema,
  relationshipQuerySchema,
  type ContextDifferenceContract,
  type RelationshipDetail,
  type RelationshipLabelContract,
  type RelationshipList,
  type RelationshipSummary,
} from '@superjoin/contracts';
import { collections, relationships } from '@superjoin/db';
import type { IngestionContext } from '@superjoin/pipeline';
import { and, count, desc, eq, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { loadFactDetails } from './facts-read.ts';

export interface RelationshipRouteDependencies {
  readonly ingestion: IngestionContext;
}

/** The six labels of plan 6.3, taken from the contract so the two cannot drift apart. */
const relationshipLabelValues = relationshipLabelSchema.options;

/** Stored as JSONB, so re-checked here rather than trusted by shape. */
function readContextDifferences(value: unknown): ContextDifferenceContract[] {
  if (!Array.isArray(value)) return [];
  const dimensions = new Set([
    'period',
    'period_type',
    'scope',
    'assertion_status',
    'unit',
    'currency',
    'qualifier',
  ]);

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record['dimension'] !== 'string' || !dimensions.has(record['dimension'])) return [];
    return [
      {
        dimension: record['dimension'] as ContextDifferenceContract['dimension'],
        a: typeof record['a'] === 'string' ? record['a'] : null,
        b: typeof record['b'] === 'string' ? record['b'] : null,
        couldExplainGap: record['couldExplainGap'] === true,
      },
    ];
  });
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export async function registerRelationshipRoutes(
  app: FastifyInstance,
  deps: RelationshipRouteDependencies,
): Promise<void> {
  const { db } = deps.ingestion.database;

  app.get('/collections/:id/relationships', async (request, reply) => {
    const collectionId = (request.params as { id: string }).id;

    const parsed = relationshipQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'invalid_query',
        message: parsed.error.issues[0]?.message ?? 'invalid query parameters',
      };
    }

    const [collection] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.id, collectionId))
      .limit(1);

    if (collection === undefined) {
      reply.code(404);
      return { error: 'collection_not_found', message: `no collection with id ${collectionId}` };
    }

    const { label, claimId, limit, offset } = parsed.data;

    const conditions: SQL[] = [eq(relationships.collectionId, collectionId)];
    if (label !== undefined) conditions.push(eq(relationships.label, label));
    if (claimId !== undefined) {
      // Either side: a claim is not "the first one" in any meaningful sense, and a filter
      // that only matched claim_a would hide half of a claim's own comparisons.
      conditions.push(
        or(eq(relationships.claimAId, claimId), eq(relationships.claimBId, claimId))!,
      );
    }
    const where = and(...conditions);

    const [rows, totalRow, labelRows] = await Promise.all([
      db
        .select()
        .from(relationships)
        .where(where)
        .orderBy(desc(relationships.createdAt), relationships.id)
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(relationships).where(where),
      // Counted across the collection rather than the filtered set, so the label chips
      // still show what else is there after one of them has been chosen.
      db
        .select({ label: relationships.label, total: count() })
        .from(relationships)
        .where(eq(relationships.collectionId, collectionId))
        .groupBy(relationships.label),
    ]);

    const claimIds = [...new Set(rows.flatMap((row) => [row.claimAId, row.claimBId]))];
    const details = await loadFactDetails(db, claimIds);

    const items: RelationshipSummary[] = rows.flatMap((row) => {
      const claimA = details.get(row.claimAId);
      const claimB = details.get(row.claimBId);
      // Both claims cascade-delete with their document, so a relationship without them is
      // a row mid-deletion rather than something to render half of.
      if (claimA === undefined || claimB === undefined) return [];

      return [
        {
          id: row.id,
          collectionId: row.collectionId,
          label: row.label,
          rationale: row.rationale,
          contextDifferences: readContextDifferences(row.contextDifferences),
          uncertaintyReasons: readStringArray(row.uncertaintyReasons),
          method: row.method,
          methodVersion: row.methodVersion,
          modelName: row.modelName,
          promptVersion: row.promptVersion,
          claimA,
          claimB,
          createdAt: row.createdAt.toISOString(),
        },
      ];
    });

    // Every label, including the ones with no rows. A label absent from the map and a
    // label with zero rows mean the same thing to a reader, and returning all six keeps
    // the wire shape complete: the chips can show "contradicts 0", which is a real answer
    // about this collection rather than a gap the interface has to paper over.
    const counts = Object.fromEntries(
      relationshipLabelValues.map((name) => [name, 0]),
    ) as RelationshipList['counts'];
    for (const row of labelRows) counts[row.label] = row.total;

    return {
      items,
      total: totalRow[0]?.total ?? 0,
      limit,
      offset,
      counts,
    } satisfies RelationshipList;
  });

  app.get('/relationships/:id', async (request, reply) => {
    const relationshipId = (request.params as { id: string }).id;

    const [row] = await db
      .select()
      .from(relationships)
      .where(eq(relationships.id, relationshipId))
      .limit(1);

    if (row === undefined) {
      reply.code(404);
      return {
        error: 'relationship_not_found',
        message: `no relationship with id ${relationshipId}`,
      };
    }

    const details = await loadFactDetails(db, [row.claimAId, row.claimBId]);
    const claimA = details.get(row.claimAId);
    const claimB = details.get(row.claimBId);

    if (claimA === undefined || claimB === undefined) {
      reply.code(404);
      return {
        error: 'relationship_claims_missing',
        message: `relationship ${relationshipId} refers to a claim that no longer exists`,
      };
    }

    const detail: RelationshipDetail = {
      id: row.id,
      collectionId: row.collectionId,
      label: row.label as RelationshipLabelContract,
      rationale: row.rationale,
      contextDifferences: readContextDifferences(row.contextDifferences),
      uncertaintyReasons: readStringArray(row.uncertaintyReasons),
      method: row.method,
      methodVersion: row.methodVersion,
      modelName: row.modelName,
      promptVersion: row.promptVersion,
      claimA,
      claimB,
      // Inputs to classification, not proof of the label (plan 6.2). Returned so a
      // reviewer can see what the classifier was working from.
      deterministicChecks: row.deterministicChecks ?? null,
      supportingEvidenceIds: readStringArray(row.supportingEvidenceIds),
      createdAt: row.createdAt.toISOString(),
    };

    return detail;
  });
}
