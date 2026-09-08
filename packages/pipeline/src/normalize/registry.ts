/**
 * Reading and growing a collection's predicate registry.
 *
 * The registry is memory. Extraction is shown what this collection already calls things,
 * and asked to reuse a name rather than coin one; whatever it does coin is recorded so the
 * next document sees it too. The first document in a collection therefore teaches the
 * vocabulary and the rest of them speak it.
 *
 * This is the fix for a measured failure, not a tidiness exercise. Left to itself,
 * extraction produced 1,053 distinct predicates from 1,991 claims — `revenue`,
 * `revenue_amount`, `total_revenues` and `total_revenue_from_customers` all separate — and
 * only two (entity, predicate) combinations appeared in more than one document. Retrieval
 * had nothing to match on, so corroboration, which needs the same measure found twice in
 * different documents, could not be reached at all.
 */

import { predicateRegistry, type Database } from '@superjoin/db';
import { eq } from 'drizzle-orm';

import { normalizePredicate } from './predicates.ts';

/** A registered measure, as extraction is shown it. */
export interface RegisteredPredicate {
  readonly canonicalName: string;
  readonly description: string | null;
  readonly aliases: readonly string[];
  readonly unitHint: string | null;
}

function readAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export async function loadRegistry(
  db: Database,
  collectionId: string,
): Promise<RegisteredPredicate[]> {
  const rows = await db
    .select()
    .from(predicateRegistry)
    .where(eq(predicateRegistry.collectionId, collectionId))
    .orderBy(predicateRegistry.canonicalName);

  return rows.map((row) => ({
    canonicalName: row.canonicalName,
    description: row.description,
    aliases: readAliases(row.aliases),
    unitHint: row.unitHint,
  }));
}

/**
 * The registry as a line-per-measure list for a prompt.
 *
 * Capped, because this is prepended to every extraction call and an unbounded vocabulary
 * would cost more tokens per chunk than the chunk. The cap is a budget, not a claim that
 * the rest do not matter: the ones left out are simply the ones a document is least likely
 * to need, since the list is ordered by how often the collection has used them.
 */
export function renderRegistry(entries: readonly RegisteredPredicate[], limit = 60): string {
  if (entries.length === 0) return '';

  const lines = entries.slice(0, limit).map((entry) => {
    const parts = [entry.canonicalName];
    if (entry.description !== null && entry.description !== '') parts.push(`— ${entry.description}`);
    if (entry.unitHint !== null && entry.unitHint !== '') parts.push(`(usually ${entry.unitHint})`);
    return `- ${parts.join(' ')}`;
  });

  return lines.join('\n');
}

/**
 * Chooses the registered name for a predicate, if the collection already has one.
 *
 * Exact and alias matching only. A near match is deliberately not resolved here: merging
 * `revenue` into `revenue_from_operations` because they share a word is exactly the
 * conflation plan 5.3 forbids, and retrieval already widens across related names without
 * having to rewrite what the document said.
 */
export function canonicalFor(
  predicate: string,
  entries: readonly RegisteredPredicate[],
): string | null {
  const normalized = normalizePredicate(predicate);

  for (const entry of entries) {
    // Both sides normalized: an entry may have been written before a folding rule changed,
    // and `revenue_from_operations` folds to `revenue_from_operation`.
    if (normalizePredicate(entry.canonicalName) === normalized) return entry.canonicalName;
    if (entry.aliases.some((alias) => normalizePredicate(alias) === normalized)) {
      return entry.canonicalName;
    }
  }
  return null;
}

export interface RegistrationResult {
  /** Names newly added to the collection's vocabulary. */
  readonly added: readonly string[];
  /** Names recorded as aliases of an entry that already existed. */
  readonly aliased: readonly string[];
}

/**
 * Records the predicates a document used.
 *
 * A name already known, by canonical name or by a recorded alias, is left alone. Anything
 * else is added, because plan 1.2 requires a new fact type to be representable as data
 * rather than as a migration. Nothing is merged automatically; see the note in the body.
 */
export async function registerPredicates(
  db: Database,
  collectionId: string,
  predicates: readonly { name: string; unit?: string | null }[],
): Promise<RegistrationResult> {
  const entries = await loadRegistry(db, collectionId);
  const known = new Set(entries.map((entry) => normalizePredicate(entry.canonicalName)));
  const aliasOf = new Map<string, string>();
  for (const entry of entries) {
    for (const alias of entry.aliases) aliasOf.set(normalizePredicate(alias), entry.canonicalName);
  }

  const added: string[] = [];
  const aliased: string[] = [];
  const seen = new Set<string>();

  for (const { name, unit } of predicates) {
    const normalized = normalizePredicate(name);
    if (normalized === '' || seen.has(normalized)) continue;
    seen.add(normalized);

    if (known.has(normalized) || aliasOf.has(normalized)) continue;

    /**
     * Every unseen name is added, and none is merged automatically.
     *
     * Head-term aliasing was tried and removed: `revenue` and `revenue_growth` share a
     * head and are a level and a rate, so folding them would have manufactured agreement
     * between two different measures — a worse failure than the sprawl it was meant to
     * cure, and exactly the conflation plan 5.3 forbids.
     *
     * Proliferation is prevented where it starts instead. The vocabulary goes into the
     * extraction prompt, so the second document reuses the first document's name rather
     * than coining its own, and retrieval widens across related names without needing the
     * stored claim rewritten. `aliases` remains for names a reviewer confirms are the same
     * measure, which is a judgement worth having and not one to guess.
     */
    await db
      .insert(predicateRegistry)
      .values({
        collectionId,
        canonicalName: normalized,
        ...(unit !== undefined && unit !== null && unit !== '' ? { unitHint: unit } : {}),
      })
      .onConflictDoNothing();

    known.add(normalized);
    added.push(normalized);
  }

  return { added, aliased };
}
