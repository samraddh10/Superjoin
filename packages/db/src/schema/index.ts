/**
 * The full schema, re-exported for Drizzle Kit and for query code.
 *
 * Nine tables from plan section 1.2, plus three the plan's own prose requires:
 * `entity_aliases` and `fact_groups` (section 1.2 states that multiple source claims may
 * belong to a shared canonical fact group, and section 5.3 requires source-backed
 * aliases), and `claim_embeddings` (section 6.1 requires model, dimensions and task type
 * to be recorded per vector).
 */

export * from './enums.ts';
export * from './collections.ts';
export * from './processing.ts';
export * from './sources.ts';
export * from './entities.ts';
export * from './predicates.ts';
export * from './claims.ts';
export * from './relationships.ts';
export * from './issues.ts';
export * from './settings.ts';
export * from './checkpoints.ts';
