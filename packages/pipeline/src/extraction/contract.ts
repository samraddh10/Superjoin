/**
 * The extraction contract.
 *
 * Plan section 4.1: one Zod schema, a JSON Schema compatible with it sent as a Bedrock
 * tool input schema, and the reply parsed with Zod before anything is believed. The two
 * definitions sit in this file next to each other on purpose — they are one contract in
 * two encodings, and letting them drift apart would mean the model is constrained by one
 * shape and validated against another.
 *
 * A schema violation is a normal outcome here, not an exception. Structured output
 * constrains shape, not truth, and a free endpoint under load may ignore it entirely, so
 * `parseExtraction` returns a result rather than throwing and the caller repairs.
 *
 * Two decisions that the field list makes explicit:
 *
 *   - Numbers cross this boundary as strings. `numeric_value` is a decimal string,
 *     never a JSON number, because JSON.parse would put a financial figure through a
 *     double before any of our code saw it.
 *   - Unknown context is `null`, never a guess. Plan 4.1 is explicit, and the
 *     alternative is worse than an absence: a plausible period invented for a claim
 *     that had none is indistinguishable from one the document stated.
 */

import { z } from 'zod';

/** Bumped whenever the prompt or this schema changes what the model returns. */
export const EXTRACTION_PROMPT_VERSION = 'claim-extract@3';

/**
 * How a claim's period is expressed.
 *
 * Open enough to hold what the collections actually contain and closed enough to be
 * comparable. `unknown` is a real member: a figure with no stated period is a fact the
 * document asserts, and dropping it would lose it.
 */
export const periodTypeSchema = z.enum([
  'fiscal_year',
  'calendar_year',
  'quarter',
  'half_year',
  'month',
  'as_of_date',
  'range',
  'unknown',
]);
export type PeriodType = z.infer<typeof periodTypeSchema>;

/**
 * What kind of assertion the document is making.
 *
 * Kept separate from the value because plan 5.2 forbids equating an actual with an
 * estimate, and a comparison cannot honour that distinction if it was never recorded.
 */
export const assertionStatusSchema = z.enum([
  'reported',
  'restated',
  'estimate',
  'forecast',
  'pro_forma',
  'target',
  'unknown',
]);
export type AssertionStatus = z.infer<typeof assertionStatusSchema>;

/**
 * A qualifier: any dimension that narrows the claim but is not one of the named fields.
 *
 * Segment, geography, methodology, revision marker, counterparty. Free-form by
 * requirement rather than by omission — plan 1.2 asks for a new fact type to arrive as
 * data, and a fixed qualifier list would make the next collection a migration.
 */
export const qualifierSchema = z.object({
  name: z.string().min(1).max(80),
  value: z.string().min(1).max(400),
});
export type Qualifier = z.infer<typeof qualifierSchema>;

/**
 * One extracted claim, as the model returns it.
 *
 * Field names are snake_case because that is the form plan 4.1 documents and the form
 * the prompt shows the model. They are mapped to the database's camelCase on the way in,
 * in one place, rather than being renamed here where the mapping would be invisible.
 */
export const extractedClaimSchema = z.object({
  /** The subject exactly as this passage names it. Not resolved, not canonicalised. */
  subject: z.string().min(1).max(300),
  /**
   * Open predicate name in snake_case. Plan 4.2 requires new predicates rather than a
   * fixed revenue/address/director schema, so nothing validates this against a list.
   */
  predicate: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, 'predicate must be lower_snake_case'),
  /** The sentence or cell as it stands in the source, so a reviewer sees what was read. */
  original_statement: z.string().min(1).max(2000),

  /** The value as written, including symbols and separators: "₹8,142 Cr", "(1,229)". */
  raw_value: z.string().max(200).nullable(),
  /**
   * The same value as a plain decimal string at source precision, sign included.
   *
   * A string, not a number: see the file header. Losses print in parentheses and are
   * recorded negative, which is the convention `evaluation/goldset.json` also uses.
   */
  numeric_value: z
    .string()
    .regex(/^-?\d+(?:\.\d+)?$/, 'numeric_value must be a plain decimal string')
    .nullable(),
  currency: z.string().max(20).nullable(),
  /** The multiplier word as printed: crore, lakh, million, billion, thousand. */
  scale: z.string().max(40).nullable(),
  /** percent, percentage_point, shipments, days, sq_ft, and whatever else appears. */
  unit: z.string().max(60).nullable(),

  period_label: z.string().max(80).nullable(),
  period_type: periodTypeSchema.nullable(),
  /** consolidated, standalone, a segment or a geography, as the document states it. */
  scope: z.string().max(120).nullable(),
  assertion_status: assertionStatusSchema.nullable(),

  qualifiers: z.array(qualifierSchema).max(12),

  /**
   * The `B1`-style handles from the supplied material that this claim rests on.
   *
   * At least one. A claim with no citation cannot be grounded, and accepting one would
   * defeat the purpose of the exercise.
   */
  evidence_block_ids: z.array(z.string().min(1).max(20)).min(1).max(8),
  /**
   * The passage the claim was read from, copied exactly.
   *
   * Verified against the stored block afterwards, allowing only whitespace
   * normalization. A paraphrase fails that check and the claim is not accepted on it.
   */
  quote: z.string().min(1).max(1200),
});
export type ExtractedClaim = z.infer<typeof extractedClaimSchema>;

export const extractionResponseSchema = z.object({
  claims: z.array(extractedClaimSchema).max(60),
});
export type ExtractionResponse = z.infer<typeof extractionResponseSchema>;

/**
 * The JSON Schema sent as `response_format`.
 *
 * Written out rather than generated, so what the provider receives is reviewable in one
 * place. Strict tool schemas require every property to be listed in `required` and
 * `additionalProperties: false` throughout; optionality is expressed by allowing null,
 * which is also what plan 4.1 asks for semantically.
 */
export const EXTRACTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          predicate: { type: 'string' },
          original_statement: { type: 'string' },
          raw_value: { type: ['string', 'null'] },
          numeric_value: { type: ['string', 'null'] },
          currency: { type: ['string', 'null'] },
          scale: { type: ['string', 'null'] },
          unit: { type: ['string', 'null'] },
          period_label: { type: ['string', 'null'] },
          period_type: {
            type: ['string', 'null'],
            enum: [...periodTypeSchema.options, null],
          },
          scope: { type: ['string', 'null'] },
          assertion_status: {
            type: ['string', 'null'],
            enum: [...assertionStatusSchema.options, null],
          },
          qualifiers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['name', 'value'],
              additionalProperties: false,
            },
          },
          evidence_block_ids: { type: 'array', items: { type: 'string' } },
          quote: { type: 'string' },
        },
        required: [
          'subject',
          'predicate',
          'original_statement',
          'raw_value',
          'numeric_value',
          'currency',
          'scale',
          'unit',
          'period_label',
          'period_type',
          'scope',
          'assertion_status',
          'qualifiers',
          'evidence_block_ids',
          'quote',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
} as const;

/** A parse that either produced claims or produced feedback specific enough to repair. */
export type ExtractionParse =
  | { readonly ok: true; readonly claims: readonly ExtractedClaim[] }
  | { readonly ok: false; readonly feedback: string };

/**
 * Validates a model reply against the contract.
 *
 * Returns rather than throws, because plan 4.1 treats a schema violation as an outcome
 * to repair. The feedback names the offending path and what was wrong with it, which is
 * what the repair attempt sends back; a bare "invalid response" gives the model nothing
 * to correct.
 */
export function parseExtraction(value: unknown): ExtractionParse {
  const parsed = extractionResponseSchema.safeParse(value);
  if (parsed.success) return { ok: true, claims: parsed.data.claims };

  const issues = parsed.error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');

  return { ok: false, feedback: issues };
}
