/**
 * The comparison stage.
 *
 * Retrieves candidate pairs for the document just processed, runs the deterministic
 * checks over each, and asks the model about the ones the checks cannot settle on their
 * own. What it writes is an argument, not a verdict: both claims stay untouched, the
 * checks are stored alongside the label, and the rationale points at quoted evidence.
 *
 * Two behaviours are worth stating because the cheaper alternative is wrong.
 *
 * A pair the checks can dismiss — different entities, or measures a rule exists to keep
 * apart — is labelled without a model call. That is not a shortcut around plan 6.2's
 * warning that checks are not proof: the only labels reached this way are `unrelated`,
 * which is a statement that no comparison was made, and a narrow `corroborates` for two
 * independent accepted claims whose contexts match exactly and whose figures agree after
 * a recorded conversion.
 *
 * A pair the model cannot be asked about ends the run. The checks that sent the pair to
 * the model had already failed to settle it, so any label written in the model's absence
 * would be a guess in the shape of a considered answer — which is what plan 6.4 forbids.
 * Transient causes (throttling, timeouts) are raised as transient so the queue retries
 * with backoff; a refused key is permanent and fails at once. `insufficient_context`
 * remains a verdict the model itself may reach, and only it.
 */

import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { claimEvidence, processingRuns, relationships, sourceBlocks } from '@superjoin/db';

import type { EmbeddingProvider } from '../embedding/index.ts';
import { ModelError, type CompletionProvider } from '../model/index.ts';
import { ProcessingError, type ProcessingContext, type StageHandler } from '../processor.ts';
import { recordIssue, recordProgress } from '../run-state.ts';
import { findCandidates, type CandidatePair } from './candidates.ts';
import {
  CHECKS_VERSION,
  deterministicLabel,
  runDeterministicChecks,
  type DeterministicChecks,
} from './checks.ts';
import {
  RELATIONSHIP_PROMPT_VERSION,
  classifyPair,
  type EvidenceHandle,
  type RelationshipLabel,
} from './classify.ts';

/**
 * The version stamped on every relationship this stage writes.
 *
 * Both halves, because a relationship is the product of both: changing the checks or the
 * prompt changes the answer, and the unique index on (claim A, claim B, method version)
 * is what makes a re-run under the same versions collide instead of duplicating.
 */
export const COMPARISON_METHOD_VERSION = `${CHECKS_VERSION}+${RELATIONSHIP_PROMPT_VERSION}`;

export interface ComparisonStageOptions {
  readonly client: CompletionProvider;
  /** Absent means candidate retrieval is exact matching only. */
  readonly embeddings?: EmbeddingProvider;
  /** Semantic candidates per claim. Sourced from CANDIDATE_TOP_K. */
  readonly topK?: number;
  /** Tokens this stage may spend on one document. */
  readonly tokenBudget?: number;
}

const DEFAULTS = {
  topK: 15,
  tokenBudget: 400_000,
} as const;

export interface ComparisonSummary {
  readonly pairsConsidered: number;
  readonly exactPairs: number;
  readonly semanticPairs: number;
  readonly classifiedByModel: number;
  readonly classifiedDeterministically: number;
  readonly relationshipsWritten: number;
  readonly byLabel: Readonly<Record<string, number>>;
  readonly semanticRetrievalAvailable: boolean;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * Loads the quoted evidence for a set of claims, with the block text around each quote.
 *
 * The surrounding text is what lets a classifier see the footnote that defines a figure,
 * which is the difference between `likely_contradiction` and `reconciled_by_context` for
 * most of the pairs in this collection.
 */
async function loadEvidenceHandles(
  db: Database,
  claimIds: readonly string[],
): Promise<Map<string, EvidenceHandle[]>> {
  if (claimIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: claimEvidence.id,
      claimId: claimEvidence.claimId,
      quote: claimEvidence.quote,
      verification: claimEvidence.verification,
      physicalPage: sourceBlocks.physicalPage,
      context: sourceBlocks.content,
    })
    .from(claimEvidence)
    .innerJoin(sourceBlocks, eq(sourceBlocks.id, claimEvidence.sourceBlockId))
    .where(inArray(claimEvidence.claimId, [...claimIds]));

  const byClaim = new Map<string, EvidenceHandle[]>();

  for (const row of rows) {
    const existing = byClaim.get(row.claimId) ?? [];
    existing.push({
      // Replaced with a pair-local handle before the prompt is built; a handle numbered
      // across the whole document would leave gaps the model reads as missing evidence.
      handle: '',
      evidenceId: row.id,
      claimId: row.claimId,
      physicalPage: row.physicalPage,
      quote: row.quote,
      context: row.context,
      verification: row.verification,
    });
    byClaim.set(row.claimId, existing);
  }

  return byClaim;
}

/** Numbers the evidence for one pair, A first, so the handles read in a stable order. */
function handlesForPair(
  pair: CandidatePair,
  byClaim: ReadonlyMap<string, EvidenceHandle[]>,
): EvidenceHandle[] {
  const ordered = [...(byClaim.get(pair.a.id) ?? []), ...(byClaim.get(pair.b.id) ?? [])];
  return ordered.slice(0, 8).map((handle, index) => ({ ...handle, handle: `E${index + 1}` }));
}

interface Verdict {
  readonly label: RelationshipLabel;
  readonly rationale: string;
  readonly supportingEvidenceIds: readonly string[];
  readonly differingContext: readonly string[];
  readonly uncertaintyReasons: readonly string[];
  readonly method: 'deterministic' | 'model';
  readonly modelName: string | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** The deterministic answer, in the shape a stored relationship needs. */
function fromChecks(checks: DeterministicChecks, extraUncertainty: readonly string[]): Verdict {
  const decided = deterministicLabel(checks);

  return {
    label: decided.label,
    rationale: decided.rationale,
    supportingEvidenceIds: [],
    differingContext: checks.contextDifferences.map((difference) => difference.dimension),
    uncertaintyReasons: [...decided.uncertaintyReasons, ...extraUncertainty],
    method: 'deterministic',
    modelName: null,
    promptTokens: 0,
    completionTokens: 0,
  };
}

export async function compareDocument(
  context: ProcessingContext,
  options: ComparisonStageOptions,
): Promise<ComparisonSummary> {
  const { db } = context.database;
  const tokenBudget = options.tokenBudget ?? DEFAULTS.tokenBudget;

  const candidates = await findCandidates(db, {
    collectionId: context.job.collectionId,
    documentId: context.job.documentId,
    topK: options.topK ?? DEFAULTS.topK,
    ...(options.embeddings !== undefined ? { provider: options.embeddings } : {}),
  });

  if (candidates.embedding.reason !== null) {
    // Recorded rather than logged. A recall figure measured while semantic retrieval was
    // silently off would be reported as if both channels had run.
    await recordIssue(db, context.job.runId, {
      stage: 'comparing',
      failureKind: 'semantic_retrieval_unavailable',
      failureClass: 'transient',
      message: `candidate retrieval used exact matching only: ${candidates.embedding.reason}`,
    });
  }

  const byLabel: Record<string, number> = {};
  let classifiedByModel = 0;
  let classifiedDeterministically = 0;
  let written = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  if (candidates.pairs.length === 0) {
    return {
      pairsConsidered: 0,
      exactPairs: 0,
      semanticPairs: 0,
      classifiedByModel: 0,
      classifiedDeterministically: 0,
      relationshipsWritten: 0,
      byLabel,
      semanticRetrievalAvailable: candidates.embedding.available,
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  if (options.embeddings !== undefined && candidates.embedding.available) {
    // Recorded on the run, because plan 6.1 forbids comparing vectors from different
    // embedding models and that rule is only checkable if the model is on the record.
    await db
      .update(processingRuns)
      .set({ embeddingModel: options.embeddings.model })
      .where(eq(processingRuns.id, context.job.runId));
  }

  const evidenceByClaim = await loadEvidenceHandles(
    db,
    [...new Set(candidates.pairs.flatMap((pair) => [pair.a.id, pair.b.id]))],
  );

  // The stage's own token spend is added to what extraction already recorded, rather
  // than replacing it. Extraction writes an absolute figure, so a retried run resets the
  // base before this reads it and the sum converges instead of drifting.
  const [before] = await db
    .select({ input: processingRuns.inputTokens, output: processingRuns.outputTokens })
    .from(processingRuns)
    .where(eq(processingRuns.id, context.job.runId))
    .limit(1);

  for (const pair of candidates.pairs) {
    const checks = runDeterministicChecks(pair.a, pair.b);
    let verdict: Verdict;

    if (!checks.worthComparing) {
      // Dismissed by name alone. The only label reachable here is `unrelated`, which
      // asserts that no comparison was made rather than that one failed.
      verdict = fromChecks(checks, []);
    } else if (promptTokens + completionTokens >= tokenBudget) {
      verdict = fromChecks(checks, ['the classification budget for this document was exhausted']);
    } else {
      try {
        const classified = await classifyPair(
          pair.a,
          pair.b,
          checks,
          handlesForPair(pair, evidenceByClaim),
          { client: options.client },
        );

        verdict = {
          label: classified.label,
          rationale: classified.rationale,
          supportingEvidenceIds: classified.supportingEvidenceIds,
          differingContext: classified.differingContext,
          uncertaintyReasons: classified.uncertaintyReasons,
          method: 'model',
          modelName: classified.servedByModel,
          promptTokens: classified.promptTokens,
          completionTokens: classified.completionTokens,
        };

        promptTokens += classified.promptTokens;
        completionTokens += classified.completionTokens;
      } catch (error) {
        // A pair the classifier could not answer is not labelled from the checks alone.
        // The checks were never sufficient — that is why the pair reached the model — so
        // a verdict written here would be a guess wearing the same shape as a considered
        // answer. The run fails instead, and says why.
        const modelError = error instanceof ModelError ? error : null;
        const retryable = modelError?.retryable ?? true;

        await recordIssue(db, context.job.runId, {
          stage: 'comparing',
          failureKind: modelError?.kind ?? 'classification_failed',
          failureClass: retryable ? 'transient' : 'permanent',
          message: `pair ${pair.a.id} / ${pair.b.id}: ${(error as Error).message.slice(0, 300)}`,
        });

        throw new ProcessingError(
          `classifier unavailable for pair ${pair.a.id} / ${pair.b.id}: ${(error as Error).message}`,
          modelError?.kind ?? 'classification_failed',
          retryable ? 'transient' : 'permanent',
          'comparing',
        );
      }
    }

    if (verdict.method === 'model') classifiedByModel += 1;
    else classifiedDeterministically += 1;

    const inserted = await writeRelationship(db, context.job.collectionId, pair, checks, verdict);
    if (inserted) written += 1;

    byLabel[verdict.label] = (byLabel[verdict.label] ?? 0) + 1;
  }

  await db
    .update(processingRuns)
    .set({
      inputTokens: (before?.input ?? 0) + promptTokens,
      outputTokens: (before?.output ?? 0) + completionTokens,
    })
    .where(eq(processingRuns.id, context.job.runId));

  // Absolute, like every other counter: one relationship row exists per candidate pair
  // whether this attempt inserted it or found it already there, so a replay converges on
  // the same figure instead of reporting zero the second time through.
  await recordProgress(db, context.job.runId, {
    relationshipsCreated: candidates.pairs.length,
  });

  return {
    pairsConsidered: candidates.pairs.length,
    exactPairs: candidates.exactPairs,
    semanticPairs: candidates.semanticPairs,
    classifiedByModel,
    classifiedDeterministically,
    relationshipsWritten: written,
    byLabel,
    semanticRetrievalAvailable: candidates.embedding.available,
    promptTokens,
    completionTokens,
  };
}

/**
 * Writes one relationship.
 *
 * Insert-or-upgrade rather than a plain insert. A retried run that previously fell back
 * to the deterministic answer, and this time reached the classifier, must be allowed to
 * replace it; the reverse must not happen, or a throttled retry would quietly erase a
 * considered label. The unique index makes both cases a collision, and the `method`
 * predicate on the update is what distinguishes them.
 */
async function writeRelationship(
  db: Database,
  collectionId: string,
  pair: CandidatePair,
  checks: DeterministicChecks,
  verdict: Verdict,
): Promise<boolean> {
  const values = {
    collectionId,
    claimAId: pair.a.id,
    claimBId: pair.b.id,
    label: verdict.label,
    rationale: verdict.rationale,
    contextDifferences: verdict.differingContext,
    uncertaintyReasons: verdict.uncertaintyReasons,
    deterministicChecks: {
      ...checks,
      retrievedBy: pair.sources,
      semanticDistance: pair.distance,
    },
    supportingEvidenceIds: verdict.supportingEvidenceIds,
    method: verdict.method,
    methodVersion: COMPARISON_METHOD_VERSION,
    modelName: verdict.modelName,
    promptVersion: verdict.method === 'model' ? RELATIONSHIP_PROMPT_VERSION : null,
  };

  const inserted = await db
    .insert(relationships)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: relationships.id });

  if (inserted.length > 0) return true;

  if (verdict.method === 'model') {
    await db
      .update(relationships)
      .set(values)
      .where(
        and(
          eq(relationships.claimAId, pair.a.id),
          eq(relationships.claimBId, pair.b.id),
          eq(relationships.methodVersion, COMPARISON_METHOD_VERSION),
          eq(relationships.method, 'deterministic'),
        ),
      );
  }

  return false;
}

export function createComparisonStage(options: ComparisonStageOptions): StageHandler {
  return {
    stage: 'comparing',
    async run(context) {
      await compareDocument(context, options);
    },
  };
}
