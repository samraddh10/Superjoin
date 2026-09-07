/**
 * Writing extracted claims and their evidence.
 *
 * Two plan requirements meet here and pull in opposite directions. Plan 4.4 asks for
 * repeated extraction of the same source assertion to be deduplicated *while keeping all
 * evidence links*, and plan 2.3 asks for inserts to be idempotent under a retried job.
 * Both are served by the same mechanism: a fingerprint that identifies the assertion
 * rather than the sentence, a unique index on (document, fingerprint) that turns a
 * duplicate into a collision, and evidence rows that accumulate against whichever claim
 * won the race.
 *
 * Status is then recomputed from everything stored against the claim, never from the
 * attempt that happened to run last. That is what lets a second pass improve a claim — a
 * cross-check found on a re-run lifts it out of review — without a replay being able to
 * quietly undo an earlier verification.
 */

import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { claimEvidence, claims } from '@superjoin/db';

import type { ExtractedClaim } from './contract.ts';
import { decideClaimStatus, type EvidenceVerdict, type VerifiedEvidence } from './verify.ts';

/**
 * A stable identity for one assertion inside one document.
 *
 * Deliberately excludes the quote and the original statement. The same fact stated in a
 * table and repeated in the narrative above it is one assertion with two pieces of
 * evidence, and folding the wording into the identity would store it as two claims that
 * then appear to corroborate each other — the "repeated wording is not independent
 * evidence" trap plan 6.4 names, manufactured by our own writer.
 *
 * Scoped to the document by the unique index rather than by hashing the document id in,
 * so the same fingerprint across two documents is visibly the same assertion from two
 * sources, which is exactly what Phase 6 compares.
 */
export function assertionFingerprint(claim: ExtractedClaim): string {
  const normalize = (value: string | null): string =>
    (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

  const qualifiers = [...claim.qualifiers]
    .map((entry) => `${normalize(entry.name)}=${normalize(entry.value)}`)
    .sort()
    .join('|');

  const parts = [
    normalize(claim.subject),
    claim.predicate,
    normalize(claim.numeric_value ?? claim.raw_value),
    normalize(claim.currency),
    normalize(claim.scale),
    normalize(claim.unit),
    normalize(claim.period_label),
    claim.period_type ?? '',
    normalize(claim.scope),
    claim.assertion_status ?? '',
    qualifiers,
  ];

  return createHash('sha256').update(parts.join(' ')).digest('hex');
}

export interface PersistClaimOptions {
  readonly documentId: string;
  readonly runId: string;
}

export interface PersistedClaim {
  readonly claimId: string;
  /** False when the assertion was already stored and this pass only added evidence. */
  readonly inserted: boolean;
  readonly status: 'accepted' | 'needs_review' | 'rejected';
  readonly evidenceWritten: number;
}

/**
 * Writes one claim and its evidence, then settles its status.
 *
 * Rejected claims are stored rather than discarded. A claim whose quote is nowhere in the
 * document is the most interesting output the extractor produces: it is the evidence for
 * the grounding measurement in plan 8.1 and for the observed failure the acceptance
 * criteria require, and throwing it away would leave only the successes to look at.
 */
export async function persistClaim(
  db: Database,
  claim: ExtractedClaim,
  evidence: readonly VerifiedEvidence[],
  options: PersistClaimOptions,
): Promise<PersistedClaim> {
  const fingerprint = assertionFingerprint(claim);

  const inserted = await db
    .insert(claims)
    .values({
      documentId: options.documentId,
      runId: options.runId,
      subject: claim.subject,
      predicate: claim.predicate,
      originalStatement: claim.original_statement,
      rawValue: claim.raw_value,
      // NUMERIC takes the decimal string as written. Nothing here converts it through a
      // JavaScript number, which plan 4.1 forbids for exactly these values.
      numericValue: claim.numeric_value,
      currency: claim.currency,
      scale: claim.scale,
      unit: claim.unit,
      periodLabel: claim.period_label,
      periodType: claim.period_type,
      scope: claim.scope,
      assertionStatus: claim.assertion_status,
      qualifiers: claim.qualifiers,
      status: 'needs_review',
      assertionFingerprint: fingerprint,
    })
    .onConflictDoNothing()
    .returning({ id: claims.id });

  const existingId = inserted[0]?.id ?? (await findClaimId(db, options.documentId, fingerprint));

  if (existingId === null) {
    // The insert was refused and the row is not there either, which means the document
    // was deleted underneath this job. Nothing to attach evidence to.
    throw new Error(`claim could not be stored for document ${options.documentId}`);
  }

  let evidenceWritten = 0;
  for (const row of evidence) {
    // A citation that resolved to nothing has no block to point at. The verdict survives
    // in the claim's status and its reason; a foreign key to a block that does not exist
    // is not a way to record it.
    if (row.sourceBlockId === null) continue;

    const written = await db
      .insert(claimEvidence)
      .values({
        claimId: existingId,
        sourceBlockId: row.sourceBlockId,
        quote: row.quote,
        quoteStart: row.quoteStart,
        quoteEnd: row.quoteEnd,
        verification: row.verification,
        entailment: row.entailment,
        verificationNote: row.verificationNote,
        supportRole: row.supportRole,
      })
      .onConflictDoNothing()
      .returning({ id: claimEvidence.id });

    evidenceWritten += written.length;
  }

  const status = await settleClaimStatus(db, existingId, claim, evidence);

  return {
    claimId: existingId,
    inserted: inserted.length > 0,
    status,
    evidenceWritten,
  };
}

async function findClaimId(
  db: Database,
  documentId: string,
  fingerprint: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: claims.id })
    .from(claims)
    .where(and(eq(claims.documentId, documentId), eq(claims.assertionFingerprint, fingerprint)))
    .limit(1);

  return row?.id ?? null;
}

/**
 * Recomputes a claim's status from every evidence row stored against it.
 *
 * The unresolved citations are folded back in, because a claim that cited three blocks
 * and stored none of them must still be rejected: reading only what was written would
 * make an entirely invented citation look like a claim with no opinion rather than one
 * with a bad one.
 */
async function settleClaimStatus(
  db: Database,
  claimId: string,
  claim: ExtractedClaim,
  attempted: readonly VerifiedEvidence[],
): Promise<'accepted' | 'needs_review' | 'rejected'> {
  const stored = await db
    .select({
      verification: claimEvidence.verification,
      entailment: claimEvidence.entailment,
    })
    .from(claimEvidence)
    .where(eq(claimEvidence.claimId, claimId));

  const unresolved: EvidenceVerdict[] = attempted
    .filter((row) => row.sourceBlockId === null)
    .map((row) => ({ verification: row.verification, entailment: row.entailment }));

  const { status, statusReason } = decideClaimStatus(
    [...stored, ...unresolved],
    claim.raw_value ?? claim.numeric_value ?? 'the reported value',
  );

  await db.update(claims).set({ status, statusReason }).where(eq(claims.id, claimId));

  return status;
}
