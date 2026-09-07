/**
 * The hand-reviewed evaluation set, loaded and validated.
 *
 * `goldset.json` is a contract, not a fixture: the pipeline never reads it, and nothing
 * in it may reach a prompt. It is parsed with Zod here for the same reason the model's
 * replies are — a field that quietly changed shape would otherwise show up as a metric
 * that silently stopped measuring what it claims to.
 *
 * Every decimal is a string. Plan 4.1 forbids financial values through a JavaScript
 * number, and a scorer that parsed them would be comparing float-drifted figures against
 * exact ones and calling the difference an error.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/** A decimal as written, optionally signed. Never parsed into a number here. */
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a plain decimal string');

/**
 * Absent and explicitly null mean the same thing here, and both become null.
 *
 * Not every claim is a figure: a director's role has a `raw_value` and no number at all,
 * and the set omits the numeric fields on those rather than writing nulls. Treating a
 * missing key as a schema violation would reject the set over a formatting choice.
 */
function nullish<T extends z.ZodType>(inner: T) {
  return inner.nullish().transform((value) => value ?? null);
}

export const goldClaimSchema = z.object({
  id: z.string(),
  document: z.string(),
  /** Zero-based physical page index, the identifier every citation keys off. */
  physical_page: z.number().int().nonnegative(),
  printed_page_label: nullish(z.string()),
  subject: z.string(),
  predicate: z.string(),
  /** Absent on claims that are not figures, such as a board role. */
  numeric_value: nullish(decimalString),
  /** The value as printed, carried where the claim has no numeric form. */
  raw_value: nullish(z.string()),
  currency: nullish(z.string()),
  scale: nullish(z.string()),
  unit: nullish(z.string()),
  period_label: nullish(z.string()),
  period_type: nullish(z.string()),
  as_of: nullish(z.string()),
  scope: nullish(z.string()),
  assertion_status: nullish(z.string()),
  qualifiers: z.array(z.unknown()).optional(),
  notes: z.string().optional(),
  evidence_kind: z.enum(['narrative', 'table', 'chart', 'list']),
  /** Located in the source page by hand during Phase 0.2. */
  quote: z.string().min(1),
});
export type GoldClaim = z.infer<typeof goldClaimSchema>;

export const goldPairSchema = z.object({
  id: z.string(),
  claim_a: z.string(),
  claim_b: z.string(),
  expected_label: z.enum([
    'corroborates',
    'contradicts',
    'likely_contradiction',
    'reconciled_by_context',
    'insufficient_context',
    'unrelated',
  ]),
  context_dimensions: z.array(z.string()),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  rationale: z.string(),
});
export type GoldPair = z.infer<typeof goldPairSchema>;

export const goldDocumentSchema = z.object({
  id: z.string(),
  file: z.string(),
  pages: z.number().int().positive(),
  published: z.string(),
});
export type GoldDocument = z.infer<typeof goldDocumentSchema>;

export const goldsetSchema = z.object({
  version: z.string(),
  created: z.string(),
  collection: z.string(),
  method: z.string(),
  conventions: z.record(z.string(), z.string()),
  documents: z.array(goldDocumentSchema).min(1),
  claims: z.array(goldClaimSchema).min(1),
  pairs: z.array(goldPairSchema),
});
export type Goldset = z.infer<typeof goldsetSchema>;

export class GoldsetError extends Error {}

/**
 * Reads and validates the set, then checks the references inside it.
 *
 * Zod cannot see that a pair names a claim that exists or that a claim names a document
 * that exists, and a dangling reference would silently drop a pair from the denominator
 * — quietly improving every rate computed from it.
 */
export async function loadGoldset(path: string): Promise<Goldset> {
  // Explicit UTF-8. The set contains the rupee sign, and a platform default of cp1252
  // would decode it as three characters and fail every quote match that involves it.
  const raw = await readFile(path, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new GoldsetError(`${path} is not valid JSON: ${(cause as Error).message}`);
  }

  const result = goldsetSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new GoldsetError(
      `${path} does not match the evaluation contract at ${issue?.path.join('.')}: ${issue?.message}`,
    );
  }
  const goldset = result.data;

  const documentIds = new Set(goldset.documents.map((document) => document.id));
  const claimIds = new Set<string>();

  for (const claim of goldset.claims) {
    if (claimIds.has(claim.id)) throw new GoldsetError(`duplicate claim id ${claim.id}`);
    claimIds.add(claim.id);

    if (!documentIds.has(claim.document)) {
      throw new GoldsetError(`claim ${claim.id} names unknown document ${claim.document}`);
    }
    const document = goldset.documents.find((entry) => entry.id === claim.document)!;
    if (claim.physical_page >= document.pages) {
      throw new GoldsetError(
        `claim ${claim.id} cites physical page ${claim.physical_page}, past the end of ${document.id} (${document.pages} pages)`,
      );
    }
  }

  const pairIds = new Set<string>();
  for (const pair of goldset.pairs) {
    if (pairIds.has(pair.id)) throw new GoldsetError(`duplicate pair id ${pair.id}`);
    pairIds.add(pair.id);

    for (const member of [pair.claim_a, pair.claim_b]) {
      if (!claimIds.has(member)) {
        throw new GoldsetError(`pair ${pair.id} names unknown claim ${member}`);
      }
    }
    if (pair.claim_a === pair.claim_b) {
      throw new GoldsetError(`pair ${pair.id} compares a claim with itself`);
    }
  }

  return goldset;
}

/**
 * Maps an uploaded filename to the gold document it is.
 *
 * The gold set names documents by a stable id (`doc-01-prospectus`) and records the path
 * it was read from; the database knows only the name the file was uploaded under. They
 * are joined on the basename, which is what survives both. Matching on the uploaded name
 * alone would also make the whole evaluation depend on the ordinal filename prefixes that
 * plan 0.1 forbids the runtime to depend on — this is scoring rather than runtime, but
 * the join is written explicitly here so it is visible rather than assumed.
 */
export function goldDocumentResolver(
  goldset: Goldset,
  filenameOf: (documentId: string) => string | undefined,
): (documentId: string) => string | undefined {
  const byBasename = new Map<string, string>();
  for (const document of goldset.documents) {
    const basename = document.file.split('/').pop() ?? document.file;
    byBasename.set(basename.toLowerCase(), document.id);
  }

  return (documentId: string) => {
    const filename = filenameOf(documentId);
    if (filename === undefined) return undefined;
    return byBasename.get(filename.toLowerCase());
  };
}

/** Claims that belong to at least one pair. The rest are extraction targets only. */
export function pairedClaimIds(goldset: Goldset): Set<string> {
  const ids = new Set<string>();
  for (const pair of goldset.pairs) {
    ids.add(pair.claim_a);
    ids.add(pair.claim_b);
  }
  return ids;
}
