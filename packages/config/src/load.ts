import { z } from 'zod';

/**
 * How the system obtains model responses.
 *
 * `live` calls Gemini. `saved-output` replays stored responses so the system can be
 * evaluated without a paid API key, which plan section 11.1 asks for. Derived from
 * whether a key is present rather than set independently, so the two cannot disagree,
 * and surfaced to the interface so saved output is always labelled as such.
 */
export type ModelMode = 'live' | 'saved-output';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Reads an integer with a default, rejecting values outside a stated range.
 *
 * Conversion happens in the transform rather than through `z.coerce`, so a non-numeric
 * value becomes NaN and is rejected by `z.number()` with the variable named, instead of
 * being coerced to something plausible.
 */
const intInRange = (min: number, max: number, fallback: number) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      const trimmed = raw?.trim();
      return trimmed === undefined || trimmed === '' ? fallback : Number(trimmed);
    })
    .pipe(z.number().int().min(min).max(max));

const nonEmpty = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? fallback : raw.trim()));

/**
 * An absent key and a key set to the empty string mean the same thing: no model access.
 * The empty string is the state a `.env` copied from `.env.example` is actually in, and
 * reading it as a live credential fails later with an opaque authentication error.
 */
const optionalSecret = z
  .string()
  .optional()
  .transform((raw) => {
    const trimmed = raw?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  });

const schema = z.object({
  DATABASE_URL: nonEmpty('postgres://superjoin:superjoin@localhost:5432/superjoin'),
  STORAGE_DIR: nonEmpty('./storage'),
  PORT: intInRange(1, 65535, 3000),

  GEMINI_API_KEY: optionalSecret,
  LLM_MODEL: nonEmpty('gemini-2.5-flash'),

  EMBEDDING_MODEL: nonEmpty('gemini-embedding-001'),
  // The plan fixes 768 for gemini-embedding-001 and requires the vector column to match.
  // Changing this invalidates every stored vector, so it is bounded rather than free.
  EMBEDDING_DIMENSIONS: intInRange(1, 3072, 768),

  MAX_UPLOAD_MB: intInRange(1, 500, 50),
  MAX_PDF_PAGES: intInRange(1, 5000, 300),

  LLM_CONCURRENCY: intInRange(1, 32, 2),
  CANDIDATE_TOP_K: intInRange(1, 200, 15),

  // The plan asks for a per-document token budget, an application timeout and a
  // provider retry limit without proposing values. These are starting points to tune
  // once Phase 8 has measured token use and latency.
  DOCUMENT_TOKEN_BUDGET: intInRange(1000, 100_000_000, 1_500_000),
  LLM_TIMEOUT_MS: intInRange(1000, 600_000, 120_000),
  PROVIDER_MAX_RETRIES: intInRange(0, 20, 5),
});

export interface Config {
  readonly databaseUrl: string;
  readonly storageDir: string;
  readonly port: number;

  readonly modelMode: ModelMode;
  readonly geminiApiKey: string | undefined;
  readonly llmModel: string;

  readonly embeddingModel: string;
  readonly embeddingDimensions: number;

  readonly maxUploadMb: number;
  readonly maxPdfPages: number;

  readonly llmConcurrency: number;
  readonly candidateTopK: number;

  readonly documentTokenBudget: number;
  readonly llmTimeoutMs: number;
  readonly providerMaxRetries: number;
}

/**
 * Resolves configuration from an environment, defaulting to `process.env`.
 *
 * Taking the environment as a parameter keeps this testable without mutating global
 * state, which matters because the saved-output branch has to be exercised directly.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`invalid environment: ${problems}`);
  }

  const value = parsed.data;

  return {
    databaseUrl: value.DATABASE_URL,
    storageDir: value.STORAGE_DIR,
    port: value.PORT,

    modelMode: value.GEMINI_API_KEY === undefined ? 'saved-output' : 'live',
    geminiApiKey: value.GEMINI_API_KEY,
    llmModel: value.LLM_MODEL,

    embeddingModel: value.EMBEDDING_MODEL,
    embeddingDimensions: value.EMBEDDING_DIMENSIONS,

    maxUploadMb: value.MAX_UPLOAD_MB,
    maxPdfPages: value.MAX_PDF_PAGES,

    llmConcurrency: value.LLM_CONCURRENCY,
    candidateTopK: value.CANDIDATE_TOP_K,

    documentTokenBudget: value.DOCUMENT_TOKEN_BUDGET,
    llmTimeoutMs: value.LLM_TIMEOUT_MS,
    providerMaxRetries: value.PROVIDER_MAX_RETRIES,
  };
}
