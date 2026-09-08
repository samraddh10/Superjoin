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
  /**
   * How long to wait out a rate limit, and how many times. Overridable so the throttle
   * path can be tested without the test spending a minute and a half asleep.
   */
  readonly cooldownMs?: number;
  readonly cooldownAttempts?: number;
}

const DEFAULTS = {
  topK: 15,
  tokenBudget: 400_000,
} as const;

/**
 * How long to wait out a rate limit, and how many times.
 *
 * Sized for a per-minute quota, which is the shape free tiers use. Two pauses is enough to
 * cross a minute boundary twice; a third would mean the limit is per day, and waiting for
 * tomorrow inside a job is a stalled worker rather than patience.
 */
const COOLDOWN_MS = 45_000;
const COOLDOWN_ATTEMPTS = 2;



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

/**
 * How likely a pair is to be one of the four cases worth reporting.
 *
 * Read off the deterministic checks, which are already computed and cost nothing. Higher
 * is asked first. The weights are ordinal rather than calibrated: what matters is that a
 * pair which could be a corroboration outranks one that could only ever be `unrelated`,
 * not the precise gap between them.
 */
export function promiseOf(checks: DeterministicChecks): number {
  // A pair the gate refuses never reaches the classifier, so its order is irrelevant; it
  // sorts last so it cannot displace a pair that would have been asked.
  if (!checks.worthComparing) return -1;

  let score = 0;

  // Two documents saying the same thing is the entire point. One document disagreeing
  // with itself is a real finding but not the comparison this system is asked to make.
  if (!checks.sameDocument) score += 8;

  // Naming the same entity and the same measure is what makes a pair comparable at all.
  if (checks.entityMatch === 'same') score += 6;
  if (checks.predicate.relation === 'same') score += 5;
  else if (checks.predicate.relation === 'modifier_variant') score += 2;

  // A conclusion drawn from a claim held for review is provisional, so those pairs are
  // worth asking about only once the confident ones have been.
  if (checks.bothAccepted) score += 4;

  // Both sides carrying a figure is what lets agreement or conflict be established rather
  // than discussed. A pair with no numbers can still be corroborated, so this ranks it
  // lower rather than excluding it.
  if (checks.value !== null) {
    score += 3;
    // Agreement is a corroboration; disagreement is a conflict or a reconciliation. Either
    // is one of the four cases, and both beat a pair whose figures cannot be compared.
    if (checks.value.agreement === 'agree' || checks.value.agreement === 'disagree') score += 3;
  }

  // Evidence read twice is not two sources, and a corroboration resting on it is
  // downgraded later anyway — so it is a poor use of a call while others are unasked.
  if (checks.sharedSourceBlocks.length > 0) score -= 5;

  // A clean power-of-ten gap usually means a scale word was misread, which is worth the
  // classifier's attention rather than a silent deterministic pass.
  if (checks.scaleRatio !== null) score += 2;

  return score;
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
  const cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
  /** Pauses left to spend on a provider that is throttling rather than refusing. */
  let cooldownsLeft = options.cooldownAttempts ?? COOLDOWN_ATTEMPTS;
  let considered = 0;

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

  /**
   * Decide the order before spending anything, most promising pair first.
   *
   * The classifier is the scarcest resource in this system: on a metered model the budget
   * runs out long before the candidates do, and whatever is left over falls back to the
   * deterministic answer, which abstains by design. So the order the pairs are visited in
   * decides which of the four cases the run is able to find at all.
   *
   * Retrieval order is not that order. It is the order pgvector returned neighbours in,
   * which ranks by how a claim *reads*, and a run that took the first fifty of those spent
   * its entire budget on pairs that mostly turned out to be unrelated.
   *
   * `promise` therefore scores what the deterministic checks already know. A pair of
   * accepted claims about one entity, one measure and two documents, each carrying a
   * figure, is the shape every one of corroborates, contradicts and reconciled_by_context
   * takes; a pair missing any of those cannot be any of them. Scoring is not deciding —
   * the classifier still reaches its own verdict, and this only changes which questions it
   * is asked while it can still be asked any.
   */
  const scored = candidates.pairs
    .map((pair) => {
      const checks = runDeterministicChecks(pair.a, pair.b);
      return { pair, checks, promise: promiseOf(checks) };
    })
    .sort((a, b) => b.promise - a.promise);

  for (const { pair, checks } of scored) {
    considered += 1;
    let verdict: Verdict;

    if (!checks.worthComparing) {
      // Dismissed by name alone. The only label reachable here is `unrelated`, which
      // asserts that no comparison was made rather than that one failed.
      verdict = fromChecks(checks, []);
    } else if (promptTokens + completionTokens >= tokenBudget) {
      verdict = fromChecks(checks, ['the classification budget for this document was exhausted']);
    } else {
      /**
       * Asked until answered, paused, or failed. Never abandoned in favour of the checks.
       *
       * A pair reaches the model precisely because the deterministic checks could not
       * settle it, so a verdict written from those checks after a failed call would be a
       * guess wearing the shape of a considered answer. The loop exists for the one
       * failure that is neither an answer nor a dead end: being rate-limited.
       *
       * A provider that is down stays down, and failing the run is right. A free tier
       * that refuses this minute will accept the next one, and failing there throws away
       * the rest of the collection over a wait — which is what happened: four quick 429s
       * ended a stage with sixteen hundred pairs still unasked. So a throttle buys a
       * cooldown and another attempt at the same pair, twice. Bounded, because a third
       * pause on a quota that resets tomorrow is a stalled worker rather than patience,
       * and every attempt has already been through the client's own retries and their
       * backoff before reaching here.
       */
      for (;;) {
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
          break;
        } catch (error) {
          const modelError = error instanceof ModelError ? error : null;
          const retryable = modelError?.retryable ?? true;

          await recordIssue(db, context.job.runId, {
            stage: 'comparing',
            failureKind: modelError?.kind ?? 'classification_failed',
            failureClass: retryable ? 'transient' : 'permanent',
            message: `pair ${pair.a.id} / ${pair.b.id}: ${(error as Error).message.slice(0, 300)}`,
          });

          if (modelError?.kind === 'provider_rate_limited' && cooldownsLeft > 0) {
            cooldownsLeft -= 1;
            await recordIssue(db, context.job.runId, {
              stage: 'comparing',
              failureKind: 'classification_cooldown',
              failureClass: 'transient',
              message: `throttled on pair ${pair.a.id} / ${pair.b.id}; pausing ${Math.round(cooldownMs / 1000)}s before asking again rather than failing with ${scored.length - considered} pairs still to compare`,
            });
            await new Promise((resolve) => setTimeout(resolve, cooldownMs));
            continue;
          }

          throw new ProcessingError(
            `classifier unavailable for pair ${pair.a.id} / ${pair.b.id}: ${(error as Error).message}`,
            modelError?.kind ?? 'classification_failed',
            retryable ? 'transient' : 'permanent',
            'comparing',
          );
        }
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
