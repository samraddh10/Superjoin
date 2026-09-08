/**
 * Entity resolution.
 *
 * Plan section 5.3 sets the order and the stopping rule: exact normalization and
 * source-backed aliases first, embeddings only to *suggest* candidates, the model only
 * for ambiguous matches with evidence attached, and anything still uncertain left
 * unmerged. Similar names and vector scores alone are never sufficient.
 *
 * "Left unmerged" is implemented as a new entity rather than a null. An unresolved
 * subject that is stored as its own entity keeps its claims queryable and keeps them out
 * of comparisons they do not belong in; a null would drop them from the entity view
 * entirely and make the failure invisible.
 *
 * The one case worth naming is the parent and the subsidiary. "Delhivery Limited" and
 * "Delhivery Express Parcel Private Limited" share a prefix, and the second is not a
 * longer way of writing the first. Legal-form suffixes are stripped because they are
 * spelling; a distinguishing word in the middle of a name is not, so it produces a
 * candidate for the model to rule on rather than a merge.
 */

import { and, eq } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { entities, entityAliases } from '@superjoin/db';

import { ModelError, extractJson, type CompletionProvider } from '../model/index.ts';

/** Bumped when the adjudication prompt changes what the model is asked. */
export const ENTITY_MATCH_PROMPT_VERSION = 'entity-match@1';

/**
 * Legal-form words, which are how the same company is written in two places.
 *
 * Stripping these is a spelling normalization: "Delhivery Limited" and "Delhivery Ltd"
 * are one name. Nothing else is stripped, because every other word in a company name is
 * potentially the thing that distinguishes it from a related company.
 */
const LEGAL_SUFFIXES = new Set([
  'limited',
  'ltd',
  'private',
  'pvt',
  'plc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'llp',
  'llc',
  'gmbh',
  'sa',
  'nv',
  'bv',
  'co',
  'company',
]);

export interface NormalizedEntityLabel {
  readonly normalized: string;
  /** What was removed, so the transformation is auditable rather than assumed. */
  readonly strippedSuffixes: readonly string[];
}

/**
 * Reduces a name to a comparable form.
 *
 * Suffixes are removed only from the end, one after another, because a legal form appears
 * there and a meaningful word does not. "Delhivery Private Limited" loses two; "Delhivery
 * Express Parcel Private Limited" also loses two and keeps "express parcel", which is
 * exactly the distinction that stops it merging with the parent.
 */
export function normalizeEntityLabel(raw: string): NormalizedEntityLabel {
  const tokens = raw
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/[^a-z0-9&\s-]/g, '')
    .split(/\s+/)
    .filter((token) => token !== '');

  const stripped: string[] = [];
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    if (!LEGAL_SUFFIXES.has(last)) break;
    stripped.unshift(tokens.pop()!);
  }

  return { normalized: tokens.join(' '), strippedSuffixes: stripped };
}

export type EntityResolutionMethod =
  /** The normalized label already exists in this collection. */
  | 'exact'
  /** A source-backed alias points at an existing entity. */
  | 'alias'
  /** The model was asked about an ambiguous pair, with evidence, and said they match. */
  | 'model'
  /** Nothing matched with enough confidence, so a new entity was created. */
  | 'created';

export interface EntityResolution {
  readonly entityId: string;
  readonly method: EntityResolutionMethod;
  readonly canonicalLabel: string;
  /** Why this outcome, for the normalization record on the claim. */
  readonly reason: string;
  /** Candidates that were considered and rejected, kept so a miss is reviewable. */
  readonly rejectedCandidates: readonly string[];
  /** Model calls this resolution actually spent, so a caller can budget them. */
  readonly adjudications: number;
  /**
   * An adjudication failed rather than answered.
   *
   * Reported so a stage can stop asking a provider that is down. Retrying a quota
   * exhaustion is not recovery, it is the same wait paid again for every later subject.
   */
  readonly adjudicationFailed: boolean;
}

export interface EntityCandidate {
  readonly id: string;
  readonly canonicalLabel: string;
  readonly normalizedLabel: string;
}

/**
 * Subjects that name no particular thing.
 *
 * Extraction sometimes returns the document's own self-reference as the subject — "this
 * presentation", "the company", "document". Those are not entities: "document" in the
 * prospectus and "document" in the earnings deck are different documents, and merging
 * them produced the system's first false contradiction, two filing dates read as one
 * thing holding two values.
 *
 * They are not dropped, because the claim is often still real. They are scoped to their
 * document instead, so a placeholder can never be the reason two files are compared.
 */
const GENERIC_SUBJECTS = new Set([
  'document',
  'documents',
  'this document',
  'presentation',
  'this presentation',
  'the presentation',
  'report',
  'this report',
  'the report',
  'company',
  'the company',
  'issuer',
  'the issuer',
  'it',
  'they',
  'we',
  'us',
  'our company',
  'the group',
  'group',
]);

/** Whether a subject names no particular entity and must not merge across documents. */
export function isGenericSubject(subject: string): boolean {
  const folded = subject.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,]$/, '');
  return folded === '' || GENERIC_SUBJECTS.has(folded);
}

export interface ResolveEntityOptions {
  readonly collectionId: string;
  /** The subject exactly as the document named it. */
  readonly subject: string;
  /** Open vocabulary. Recorded, never used to gate a match. */
  readonly entityType?: string;
  /**
   * Extra candidates from embedding retrieval.
   *
   * Suggestions only, per plan 5.3: a vector score never merges anything on its own, it
   * only puts a pair in front of the adjudicator.
   */
  readonly suggested?: readonly EntityCandidate[];
  /** Present only when the worker has model access. Absent means uncertain stays unmerged. */
  readonly client?: CompletionProvider;
  /** Evidence to attach to an adjudication, per plan 5.3. */
  readonly evidence?: readonly string[];
  /** The block that states the alias, so an accepted match is source-backed. */
  readonly sourceBlockId?: string;
  /**
   * How many candidates this subject may put to the adjudicator. Default one.
   *
   * Each is a sequential model call, and on a rate-limited free tier each can sit in
   * retry backoff for tens of seconds. Asking about three candidates tripled that for a
   * subject where the first answer is almost always the informative one: candidates are
   * already ordered by lexical closeness, so the second and third are the ones least
   * likely to be the same entity.
   */
  readonly maxAdjudications?: number;
  /**
   * Confines matching to one scope, used for subjects that name no particular thing.
   *
   * Mixed into the stored normalized label only, so the canonical label a reviewer sees
   * stays the words the document used while the identity stays local to it.
   */
  readonly scopeKey?: string;
}

/**
 * Resolves a subject to an entity within one collection.
 *
 * Idempotent under a retried job: every write is an upsert keyed on the collection and
 * the normalized label, so two workers reaching the same new subject at once produce one
 * entity rather than a unique-constraint failure.
 */
export async function resolveEntity(
  db: Database,
  options: ResolveEntityOptions,
): Promise<EntityResolution> {
  const { normalized, strippedSuffixes } = normalizeEntityLabel(options.subject);
  const base = normalized === '' ? options.subject.trim().toLowerCase() : normalized;
  const label = options.scopeKey === undefined ? base : `${base}#${options.scopeKey}`;

  const [exact] = await db
    .select({ id: entities.id, canonicalLabel: entities.canonicalLabel })
    .from(entities)
    .where(
      and(eq(entities.collectionId, options.collectionId), eq(entities.normalizedLabel, label)),
    )
    .limit(1);

  if (exact !== undefined) {
    return {
      entityId: exact.id,
      method: 'exact',
      canonicalLabel: exact.canonicalLabel,
      reason:
        strippedSuffixes.length > 0
          ? `matched after removing the legal form (${strippedSuffixes.join(' ')})`
          : 'the normalized name already exists in this collection',
      rejectedCandidates: [],
      adjudications: 0,
      adjudicationFailed: false,
    };
  }

  const [alias] = await db
    .select({ id: entities.id, canonicalLabel: entities.canonicalLabel })
    .from(entityAliases)
    .innerJoin(entities, eq(entityAliases.entityId, entities.id))
    .where(
      and(
        eq(entities.collectionId, options.collectionId),
        eq(entityAliases.normalizedAlias, label),
      ),
    )
    .limit(1);

  if (alias !== undefined) {
    return {
      entityId: alias.id,
      method: 'alias',
      canonicalLabel: alias.canonicalLabel,
      reason: 'a recorded alias points at this entity',
      rejectedCandidates: [],
      adjudications: 0,
      adjudicationFailed: false,
    };
  }

  // Nothing matched by name. Candidates come from the caller's embedding search and from
  // the collection's own labels; both are suggestions, and neither decides anything.
  const candidates = await gatherCandidates(db, options, label);
  const rejected: string[] = [];
  const budget = options.maxAdjudications ?? 1;
  let adjudications = 0;
  let adjudicationFailed = false;

  if (candidates.length > 0 && options.client !== undefined && budget > 0) {
    for (const candidate of candidates.slice(0, budget)) {
      adjudications += 1;
      const verdict = await adjudicate(options.client, options.subject, candidate, options.evidence ?? []);
      if (verdict.failed === true) adjudicationFailed = true;

      if (verdict.same) {
        await recordAlias(db, candidate.id, options.subject, label, options.sourceBlockId);
        return {
          entityId: candidate.id,
          method: 'model',
          canonicalLabel: candidate.canonicalLabel,
          reason: verdict.reason,
          rejectedCandidates: rejected,
          adjudications,
          adjudicationFailed,
        };
      }

      rejected.push(`${candidate.canonicalLabel}: ${verdict.reason}`);
    }
  } else {
    for (const candidate of candidates.slice(0, 3)) {
      rejected.push(
        `${candidate.canonicalLabel}: a similar name, left unmerged because no adjudication was available`,
      );
    }
  }

  const created = await createEntity(db, options.collectionId, options.subject, label, options.entityType);

  return {
    entityId: created.id,
    method: 'created',
    canonicalLabel: created.canonicalLabel,
    reason:
      rejected.length > 0
        ? 'similar names were found and none was confirmed, so this subject stays separate'
        : 'no existing entity matched this subject',
    rejectedCandidates: rejected,
    adjudications,
    adjudicationFailed,
  };
}

/**
 * Assembles the candidates worth adjudicating.
 *
 * Lexical containment on top of whatever the caller retrieved. A name that shares a token
 * with an existing entity is worth a question; a name that shares none is not, and asking
 * the model about every pair would spend the free-tier budget on obvious negatives.
 */
async function gatherCandidates(
  db: Database,
  options: ResolveEntityOptions,
  label: string,
): Promise<EntityCandidate[]> {
  const existing = await db
    .select({
      id: entities.id,
      canonicalLabel: entities.canonicalLabel,
      normalizedLabel: entities.normalizedLabel,
    })
    .from(entities)
    .where(eq(entities.collectionId, options.collectionId));

  const tokens = new Set(label.split(' ').filter((token) => token.length > 2));
  const byId = new Map<string, EntityCandidate>();

  for (const candidate of [...(options.suggested ?? []), ...existing]) {
    if (byId.has(candidate.id)) continue;

    const candidateTokens = candidate.normalizedLabel.split(' ');
    const shares = candidateTokens.some((token) => tokens.has(token));
    if (shares) byId.set(candidate.id, candidate);
  }

  return [...byId.values()];
}

interface Adjudication {
  readonly same: boolean;
  readonly reason: string;
  /** The call itself failed, as opposed to answering "different". See the catch below. */
  readonly failed?: boolean;
}

/**
 * Asks the model whether two names denote the same entity.
 *
 * The prompt names the trap it is there to avoid. A parent and its subsidiary share a
 * name by design, and a model told only "are these the same company?" will merge them
 * more often than not.
 *
 * An unparsable answer is a "no". Refusing to merge on a reply that cannot be read keeps
 * the two entities separate, which is the recoverable outcome; merging on one would be
 * invisible afterwards.
 */
async function adjudicate(
  client: CompletionProvider,
  subject: string,
  candidate: EntityCandidate,
  evidence: readonly string[],
): Promise<Adjudication> {
  try {
    const result = await client.complete({
      messages: [
        {
          role: 'system',
          content: [
            'You decide whether two names taken from financial documents refer to the same legal entity.',
            'A parent company and its subsidiary are NOT the same entity, even when one name contains the other.',
            'A company and one of its business segments, brands or divisions are NOT the same entity.',
            'Differences of legal form alone (Limited, Ltd, Private Limited) do not make two names different.',
            'Answer no unless the passages make the identity clear.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            `Name A: ${subject}`,
            `Name B: ${candidate.canonicalLabel}`,
            '',
            evidence.length > 0
              ? `Passages mentioning them:\n${evidence.slice(0, 4).map((line) => `- ${line.slice(0, 400)}`).join('\n')}`
              : 'No passages are available.',
            '',
            'Reply as JSON: {"same_entity": true|false, "reason": "one sentence"}',
          ].join('\n'),
        },
      ],
      schema: {
        name: 'entity_match',
        schema: {
          type: 'object',
          properties: {
            same_entity: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['same_entity', 'reason'],
          additionalProperties: false,
        },
      },
      maxTokens: 300,
    });

    const parsed = extractJson(result.text) as { same_entity?: unknown; reason?: unknown };
    const same = parsed.same_entity === true;

    return {
      same,
      reason:
        typeof parsed.reason === 'string' && parsed.reason.trim() !== ''
          ? parsed.reason.trim()
          : same
            ? 'the model judged these to be one entity'
            : 'the model judged these to be different entities',
    };
  } catch (error) {
    // A provider that did not answer is not an answer. Leaving the subject unmerged
    // would decide entity identity by outage, and every claim downstream would carry
    // that decision with no sign of where it came from, so the error travels instead.
    if (error instanceof ModelError) throw error;

    // An answer that arrived but could not be read is a "no". Refusing to merge on a
    // malformed reply keeps the two entities separate, which is the recoverable outcome;
    // merging on one would not be.
    return {
      same: false,
      failed: true,
      reason: 'left unmerged: the adjudication could not be read',
    };
  }
}

async function recordAlias(
  db: Database,
  entityId: string,
  alias: string,
  normalizedAlias: string,
  sourceBlockId: string | undefined,
): Promise<void> {
  await db
    .insert(entityAliases)
    .values({
      entityId,
      alias,
      normalizedAlias,
      // The distinction plan 5.3 asks for: an alias the model proposed is not an alias
      // the document states, and a reviewer must be able to tell them apart.
      establishedBy: 'model_suggested',
      ...(sourceBlockId !== undefined ? { sourceBlockId } : {}),
    })
    .onConflictDoNothing();
}

async function createEntity(
  db: Database,
  collectionId: string,
  canonicalLabel: string,
  normalizedLabel: string,
  entityType: string | undefined,
): Promise<{ id: string; canonicalLabel: string }> {
  const inserted = await db
    .insert(entities)
    .values({
      collectionId,
      canonicalLabel: canonicalLabel.trim(),
      normalizedLabel,
      entityType: entityType ?? 'unknown',
    })
    .onConflictDoNothing()
    .returning({ id: entities.id, canonicalLabel: entities.canonicalLabel });

  if (inserted[0] !== undefined) return inserted[0];

  // Another worker created it between the lookup and the insert. Reading it back is the
  // correct resolution of that race, not an error to retry.
  const [existing] = await db
    .select({ id: entities.id, canonicalLabel: entities.canonicalLabel })
    .from(entities)
    .where(and(eq(entities.collectionId, collectionId), eq(entities.normalizedLabel, normalizedLabel)))
    .limit(1);

  if (existing === undefined) {
    throw new Error(`entity ${normalizedLabel} could not be created or found`);
  }

  return existing;
}
