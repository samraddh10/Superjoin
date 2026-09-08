/**
 * Exports a processed collection as reviewable sample output.
 *
 * Plan 11.1 asks for enough sample output that the work can be evaluated without API
 * access. A reviewer without a key cannot run the pipeline, and a screenshot proves
 * nothing they can check — so what is written here is the real stored rows: claims with
 * the passage each one cites, and relationships with both claims, the rationale, and the
 * deterministic checks the classifier was given.
 *
 * Read-only. Nothing here writes to the pipeline's tables.
 *
 *   npx tsx --conditions development evaluation/src/export.ts "<collection>" --out sample-output
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadConfig, loadDotEnvFile } from '@superjoin/config';
import {
  claimEvidence,
  claims,
  closeDatabase,
  createDatabase,
  documents,
  predicateRegistry,
  relationships,
  sourceBlocks,
} from '@superjoin/db';
import { desc, eq, inArray } from 'drizzle-orm';

import { resolveCollection } from './load.ts';

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const target = process.argv[2];
if (target === undefined || target.startsWith('--')) {
  console.error('usage: export.ts <collection name or id> [--out <dir>] [--claims <n>]');
  process.exit(2);
}

loadDotEnvFile();
const config = loadConfig();
const outDir = resolve(argument('out', 'sample-output'));
const claimLimit = Number(argument('claims', '40'));

const handle = createDatabase(config.databaseUrl);

try {
  const { id, name } = await resolveCollection(handle.db, target);
  const db = handle.db;
  await mkdir(outDir, { recursive: true });

  const documentRows = await db.select().from(documents).where(eq(documents.collectionId, id));
  const documentIds = documentRows.map((row) => row.id);
  const filenames = new Map(documentRows.map((row) => [row.id, row.filename]));

  /**
   * Accepted claims first, and the ones carrying a figure before the ones that do not.
   *
   * A sample is meant to be judged, so it leads with what can be checked against the page:
   * a number, a period and a quote beat a prose assertion for that purpose.
   */
  const claimRows =
    documentIds.length === 0
      ? []
      : await db
          .select()
          .from(claims)
          .where(inArray(claims.documentId, documentIds))
          .orderBy(claims.status, desc(claims.numericValue))
          .limit(claimLimit);

  const evidenceRows =
    claimRows.length === 0
      ? []
      : await db
          .select({ evidence: claimEvidence, block: sourceBlocks })
          .from(claimEvidence)
          .innerJoin(sourceBlocks, eq(sourceBlocks.id, claimEvidence.sourceBlockId))
          .where(inArray(claimEvidence.claimId, claimRows.map((row) => row.id)));

  const evidenceByClaim = new Map<string, unknown[]>();
  for (const row of evidenceRows) {
    const list = evidenceByClaim.get(row.evidence.claimId) ?? [];
    list.push({
      quote: row.evidence.quote,
      // Both reported, never collapsed: plan 4.3 keeps "is the quote there" and "does it
      // support the claim" as separate questions, and a sample that merged them would
      // misrepresent the thing being sampled.
      verification: row.evidence.verification,
      entailment: row.evidence.entailment,
      document: filenames.get(row.block.documentId) ?? null,
      physical_page: row.block.physicalPage,
      printed_page_label: row.block.printedPageLabel,
      extraction_method: row.block.extractionMethod,
    });
    evidenceByClaim.set(row.evidence.claimId, list);
  }

  const sampleClaims = claimRows.map((row) => ({
    subject: row.subject,
    predicate: row.predicate,
    // Decimal strings, as they are everywhere else: a sample that rendered these as JSON
    // numbers would demonstrate the loss plan 4.1 forbids.
    raw_value: row.rawValue,
    numeric_value: row.numericValue,
    currency: row.currency,
    scale: row.scale,
    period_label: row.periodLabel,
    scope: row.scope,
    status: row.status,
    status_reason: row.statusReason,
    document: filenames.get(row.documentId) ?? null,
    original_statement: row.originalStatement,
    evidence: evidenceByClaim.get(row.id) ?? [],
  }));

  const relationshipRows = await db
    .select()
    .from(relationships)
    .where(eq(relationships.collectionId, id));

  const claimById = new Map(
    (
      await db
        .select()
        .from(claims)
        .where(
          inArray(
            claims.id,
            relationshipRows.flatMap((row) => [row.claimAId, row.claimBId]),
          ),
        )
    ).map((row) => [row.id, row]),
  );

  const describe = (claimId: string): unknown => {
    const row = claimById.get(claimId);
    if (row === undefined) return null;
    return {
      subject: row.subject,
      predicate: row.predicate,
      raw_value: row.rawValue,
      period_label: row.periodLabel,
      scope: row.scope,
      status: row.status,
      document: filenames.get(row.documentId) ?? null,
      original_statement: row.originalStatement,
    };
  };

  /**
   * Findings first, then the rest.
   *
   * Two orderings compose here. Model-classified rows come before deterministic ones,
   * because the fallback abstains by design and a sample led by its output would show a
   * system that says "unrelated" seventeen thousand times. And within those, the four
   * labels that assert something come before the two that decline to — a first pass at
   * this sorted only by method and produced a sample that was two thirds `unrelated`,
   * which is accurate about the collection and useless for judging the system.
   *
   * Every finding fits in the slice, so nothing a reviewer would want to check is cut.
   */
  const labelRank: Record<string, number> = {
    contradicts: 0,
    likely_contradiction: 1,
    reconciled_by_context: 2,
    corroborates: 3,
    insufficient_context: 4,
    unrelated: 5,
  };

  const sampleRelationships = relationshipRows
    .sort((a, b) => {
      if (a.method !== b.method) return a.method === 'model' ? -1 : 1;
      return (labelRank[a.label] ?? 9) - (labelRank[b.label] ?? 9);
    })
    .slice(0, 30)
    .map((row) => ({
      label: row.label,
      method: row.method,
      method_version: row.methodVersion,
      model: row.modelName,
      rationale: row.rationale,
      context_differences: row.contextDifferences,
      uncertainty_reasons: row.uncertaintyReasons,
      // Inputs to the label, not proof of it (plan 6.2).
      deterministic_checks: row.deterministicChecks,
      claim_a: describe(row.claimAId),
      claim_b: describe(row.claimBId),
    }));

  const vocabulary = await db
    .select()
    .from(predicateRegistry)
    .where(eq(predicateRegistry.collectionId, id))
    .orderBy(predicateRegistry.canonicalName);

  const payload = {
    collection: name,
    exported_at: new Date().toISOString(),
    note:
      'Real stored rows from a processed collection, so the output can be reviewed without ' +
      'an API key. Claims carry the passage they cite and whether it was found and whether ' +
      'it supports them, which are separate questions.',
    documents: documentRows.map((row) => ({
      filename: row.filename,
      pages: row.pageCount,
      content_hash: row.contentHash,
    })),
    counts: {
      claims_total: claimById.size,
      relationships_total: relationshipRows.length,
      relationships_by_method: Object.fromEntries(
        relationshipRows.reduce((map, row) => {
          map.set(row.method, (map.get(row.method) ?? 0) + 1);
          return map;
        }, new Map<string, number>()),
      ),
      predicate_vocabulary: vocabulary.length,
    },
    claims: sampleClaims,
    relationships: sampleRelationships,
  };

  const path = join(outDir, 'sample.json');
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`wrote ${path}`);
  console.log(
    `  ${sampleClaims.length} claims, ${sampleRelationships.length} relationships, ${vocabulary.length} registered predicates`,
  );
} finally {
  await closeDatabase(handle);
}
