/**
 * Closed vocabularies.
 *
 * Only values the plan enumerates explicitly are enums here. Everything the plan wants
 * extensible — predicate names, units, scopes, entity types, assertion status — stays
 * `text`, because plan section 1.2 requires a new fact type to be representable as data
 * rather than as a schema change. Adding a value to a Postgres enum needs a migration;
 * adding a predicate must not.
 */

import { pgEnum } from 'drizzle-orm/pg-core';

/** Processing stages from plan section 2.2. Stored so progress survives an API restart. */
export const runStage = pgEnum('run_stage', [
  'queued',
  'parsing',
  'extracting',
  'normalizing',
  'comparing',
  'completed',
  // Distinct from `completed`: the document produced usable output and also recorded
  // issues. Collapsing the two would hide partial failure behind a success.
  'completed_with_issues',
  'failed',
]);

/**
 * Whether a claim is trusted as evidence, from plan section 4.3.
 *
 * `needs_review` is not a lesser form of failure. A claim supported only by a model
 * transcription of a page image lands here by design, because plan 4.3 states that a
 * transcription cannot independently verify a claim extracted by the same model.
 */
export const claimStatus = pgEnum('claim_status', ['accepted', 'needs_review', 'rejected']);

/**
 * Whether the cited passage was found in the stored source.
 *
 * This is citation existence only. Whether the passage actually supports the claim is a
 * separate question, recorded in `evidenceEntailment`, because plan 4.3 requires the two
 * to be distinguishable: a real quote can still fail to support the claim.
 */
export const evidenceVerification = pgEnum('evidence_verification', [
  // Located in the native PDF text, allowing only documented whitespace normalization.
  'verified_native_text',
  // Present only in a model transcription of a page image. Never independent support.
  'visual_only',
  // The claim cited a block, but the quoted passage is not in it.
  'quote_not_found',
  // The cited block does not exist or belongs to another document.
  'block_not_found',
  'unchecked',
]);

/** Whether the located passage supports the claim it is attached to. See plan 4.3. */
export const evidenceEntailment = pgEnum('evidence_entailment', [
  'supported',
  'unsupported',
  'unclear',
  'unchecked',
]);

/** Relationship labels, exactly as plan section 6.3 defines them. */
export const relationshipLabel = pgEnum('relationship_label', [
  'corroborates',
  'contradicts',
  'likely_contradiction',
  'reconciled_by_context',
  'insufficient_context',
  'unrelated',
]);

/** Shape of a source block, recorded per plan section 3.2. */
export const sourceBlockType = pgEnum('source_block_type', [
  'paragraph',
  'heading',
  'list',
  'table',
  'table_cell',
  'chart',
  'figure',
  'caption',
  'other',
]);

/**
 * How a block's content was obtained, per plan section 3.2.
 *
 * The distinction is load-bearing rather than descriptive: a claim whose only support
 * is `model_transcription` cannot be accepted on that evidence alone.
 */
export const extractionMethod = pgEnum('extraction_method', [
  'native_text',
  'model_transcription',
]);

/** Lifecycle of a recorded processing issue, per plan section 2.3. */
export const issueResolution = pgEnum('issue_resolution', [
  'open',
  'retrying',
  'resolved',
  // Kept rather than deleted: an issue the system could not recover from is the
  // evidence for the observed-failure requirement.
  'abandoned',
]);
