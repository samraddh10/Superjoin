import { z } from 'zod';

/**
 * How the system obtains model responses.
 *
 * `live` calls OpenRouter. `saved-output` replays stored responses so the system can be
 * evaluated without an API key, which plan section 11.1 asks for. Derived from whether a
 * key is present rather than set independently, so the two cannot disagree, and surfaced
 * to the interface so saved output is always labelled as such.
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
  DATABASE_URL: nonEmpty('postgres://superjoin:superjoin@localhost:55432/superjoin'),
  STORAGE_DIR: nonEmpty('./storage'),
  PORT: intInRange(1, 65535, 3000),

  OPENROUTER_API_KEY: optionalSecret,
  OPENROUTER_BASE_URL: nonEmpty('https://openrouter.ai/api/v1'),
  /**
   * The `:free` suffix is part of the model identity, not decoration. The paid and free
   * routes are different deployments and need not behave identically, so the exact
   * string is recorded on every run.
   */
  LLM_MODEL: nonEmpty('google/gemma-4-31b-it:free'),

  /**
   * Embeddings run locally. OpenRouter's catalogue is chat completions only and contains
   * no embedding models, so the retrieval side of plan 6.1 cannot use the same provider.
   */
  EMBEDDING_MODEL: nonEmpty('Xenova/all-mpnet-base-v2'),
  // 768 keeps the existing vector(768) column valid. Changing this invalidates every
  // stored vector, so it is bounded rather than free.
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
  readonly openRouterApiKey: string | undefined;
  readonly openRouterBaseUrl: string;
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

    modelMode: value.OPENROUTER_API_KEY === undefined ? 'saved-output' : 'live',
    openRouterApiKey: value.OPENROUTER_API_KEY,
    openRouterBaseUrl: value.OPENROUTER_BASE_URL,
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
