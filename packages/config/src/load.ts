import { z } from 'zod';

/**
 * How the system obtains model responses.
 *
 * `live` calls Bedrock. `saved-output` replays stored responses so the system can be
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
 * An absent value and one set to the empty string mean the same thing.
 *
 * The empty string is the state a `.env` copied from `.env.example` is actually in, and
 * it is also what Compose substitutes for an unset variable written `${VAR:-}` — so a
 * schema that rejects blanks refuses to start the worker rather than falling back to
 * saved-output, which is what the blank was meant to select.
 */
const optionalValue = z
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

  /**
   * The switch between live inference and replayed output.
   *
   * A region is not a redundant flag: Bedrock is regional, model access is granted per
   * region, and no live call can be made without one. Deriving the mode from it keeps the
   * property the previous key-based rule had — a service that was not given model access
   * cannot claim to have used it — while still allowing credentials to arrive from a task
   * role or SSO profile rather than the environment. Compose gives this to the worker and
   * withholds it from the API.
   */
  AWS_REGION: optionalValue,

  /**
   * A Bedrock long-term API key: a bearer token, not an access-key pair.
   *
   * This is what the Bedrock console hands out as an "API key", and it authenticates
   * with an `Authorization: Bearer` header under a different auth scheme than SigV4 —
   * so it cannot be split into an id and a secret, and supplying it as one fails
   * signing. Takes precedence over the pair below when both are present.
   */
  AWS_BEARER_TOKEN_BEDROCK: optionalValue,

  /**
   * SigV4 credentials, when they are not coming from the SDK's default chain.
   *
   * Left unset on anything with an instance or task role, which is the deployment the
   * plan's "keep secrets in server-only packages" note actually wants.
   */
  AWS_ACCESS_KEY_ID: optionalValue,
  AWS_SECRET_ACCESS_KEY: optionalValue,
  AWS_SESSION_TOKEN: optionalValue,

  /**
   * Model id or inference profile ARN. Recorded on every run: Bedrock versions its model
   * ids, and two runs of `:0` and `:1` are not the same experiment.
   *
   * Kept even when no region is set, because the saved-output client fingerprints
   * requests by model name and a replay has to key against what recorded it.
   */
  BEDROCK_MODEL_ID: nonEmpty('moonshotai.kimi-k2.5'),

  /**
   * Groq, the second provider.
   *
   * Present so a run is not blocked by one provider's account state — Bedrock inference
   * was gated behind account verification while the pipeline was otherwise ready, and a
   * second OpenAI-compatible endpoint is a few minutes of configuration rather than a
   * rewrite. Which one is used is a runtime setting, not an environment variable; see
   * `app_settings`.
   */
  GROQ_API_KEY: optionalValue,
  GROQ_BASE_URL: nonEmpty('https://api.groq.com/openai/v1'),
  GROQ_MODEL: nonEmpty('openai/gpt-oss-120b'),

  /**
   * Embeddings run locally. Bedrock does serve embedding models, but moving them there
   * would put every chunk of every document through a billed network call for a vector
   * that a 768-dimension local model produces in milliseconds.
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
  readonly awsRegion: string | undefined;
  readonly awsBearerToken: string | undefined;
  readonly awsAccessKeyId: string | undefined;
  readonly awsSecretAccessKey: string | undefined;
  readonly awsSessionToken: string | undefined;
  readonly bedrockModelId: string;
  readonly groqApiKey: string | undefined;
  readonly groqBaseUrl: string;
  readonly groqModel: string;

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

    /**
     * Live when any provider is reachable, not only Bedrock.
     *
     * The mode says whether this process can call a model at all, so tying it to one
     * provider would report saved-output on a machine that has a working Groq key.
     */
    modelMode:
      value.AWS_REGION === undefined && value.GROQ_API_KEY === undefined ? 'saved-output' : 'live',
    awsRegion: value.AWS_REGION,
    awsBearerToken: value.AWS_BEARER_TOKEN_BEDROCK,
    awsAccessKeyId: value.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: value.AWS_SECRET_ACCESS_KEY,
    awsSessionToken: value.AWS_SESSION_TOKEN,
    bedrockModelId: value.BEDROCK_MODEL_ID,
    groqApiKey: value.GROQ_API_KEY,
    groqBaseUrl: value.GROQ_BASE_URL,
    groqModel: value.GROQ_MODEL,

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
