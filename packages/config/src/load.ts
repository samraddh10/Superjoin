import { z } from 'zod';

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
 * it is also what Compose substitutes for an unset variable written `${VAR:-}`. Both
 * resolve to `undefined` so that one check covers them, and so that a blank reads as an
 * absent provider rather than as a credential that will fail opaquely at the first call.
 *
 * Provider access is demanded where it is used rather than by this schema: the API
 * reaches `loadConfig` and holds no model credential by design, so rejecting here would
 * stop a service that never calls a model. See `requireModelAccess`.
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
   * The region Bedrock is called in.
   *
   * Not a redundant flag: Bedrock is regional, model access is granted per region, and no
   * call can be made without one. Its presence is what makes Bedrock available, while
   * still allowing credentials to arrive from a task role or SSO profile rather than the
   * environment. Compose gives this to the worker and withholds it from the API.
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
  /**
   * Must be a multimodal model.
   *
   * One client serves every stage, and the visual route hands it a rendered page. A
   * text-only model — `openai/gpt-oss-120b`, which this defaulted to — rejects the image
   * part outright with `content must be a string`, and since a page that cannot be
   * transcribed fails its run, the default made every document fail on its first
   * difficult page.
   */
  GROQ_MODEL: nonEmpty('qwen/qwen3.8-27b'),

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

  /**
   * How much extraction may pack into one request.
   *
   * Chunking flushes at every heading and page, which citations depend on and which leaves
   * a tail of very small chunks. Each one paid the full fixed cost of a request to ask
   * about a few dozen words. These bound how many of them travel together: the token
   * ceiling is well under any model's limit, because the point is the saving rather than
   * the capacity, and a batch large enough for the model to lose track of a passage has
   * spent that saving on a worse answer.
   *
   * A chunk ceiling of 1 restores one request per chunk.
   */
  EXTRACTION_BATCH_TOKENS: intInRange(0, 100_000, 3000),
  EXTRACTION_BATCH_CHUNKS: intInRange(1, 20, 4),

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

  /** Input tokens one extraction request may carry across its passages. */
  readonly extractionBatchTokens: number;
  /** Passages one extraction request may carry. */
  readonly extractionBatchChunks: number;

  readonly documentTokenBudget: number;
  readonly llmTimeoutMs: number;
  readonly providerMaxRetries: number;
}

/**
 * Resolves configuration from an environment, defaulting to `process.env`.
 *
 * Taking the environment as a parameter keeps this testable without mutating global
 * state.
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

    extractionBatchTokens: value.EXTRACTION_BATCH_TOKENS,
    extractionBatchChunks: value.EXTRACTION_BATCH_CHUNKS,

    documentTokenBudget: value.DOCUMENT_TOKEN_BUDGET,
    llmTimeoutMs: value.LLM_TIMEOUT_MS,
    providerMaxRetries: value.PROVIDER_MAX_RETRIES,
  };
}

/**
 * A refusal to continue without a provider to call.
 *
 * Called by the process that actually reaches a provider, at startup rather than at the
 * first completion: a worker that begins consuming jobs and only then discovers it has no
 * credential has already claimed work it cannot do, and every one of those jobs pays a
 * full retry ladder to learn the same thing.
 *
 * Either provider satisfies it. Which one a run uses is a runtime setting, so demanding
 * both here would refuse to start a machine that is configured to use the one it has.
 */
export function requireModelAccess(config: Config): void {
  if (config.awsRegion === undefined && config.groqApiKey === undefined) {
    throw new ConfigError(
      'no model provider is configured: set AWS_REGION for Bedrock or GROQ_API_KEY for Groq. This service calls a model on every document, and there is no offline mode to fall back to',
    );
  }
}
