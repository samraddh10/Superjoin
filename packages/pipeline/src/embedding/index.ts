/**
 * Claim embeddings, computed locally.
 *
 * Bedrock does serve embedding models, but routing every chunk of every document
 * all, so the retrieval side of plan 6.1 cannot use the same provider. It runs here
 * instead, through `@huggingface/transformers`, with a symmetric sentence-similarity
 * model at 768 dimensions so the existing `vector(768)` column is unchanged.
 *
 * Two properties of the text being embedded matter more than the model choice.
 *
 * The description carries the subject, the predicate and the qualifiers, and never the
 * value. Plan 6.1 asks for exactly this: an embedding of "revenue from services was
 * 8,142 crore" is dominated by its digits, and retrieval then ranks by numeric
 * coincidence rather than by what the claim is about — which is the opposite of what
 * candidate generation is for, since the pairs worth comparing are precisely the ones
 * whose numbers differ.
 *
 * The vectors are normalized, so cosine distance and inner product agree and pgvector's
 * `<=>` means what the retrieval code assumes it means.
 *
 * Loading is lazy and failure is survivable. The model is a download on first use, and a
 * worker that cannot fetch it must still produce relationships: candidate generation
 * falls back to the exact entity and predicate matching that plan 6.1 requires be kept
 * regardless, and the run records that semantic retrieval was unavailable.
 */

/** What the vectors were made for. Recorded per row, because it changes what they mean. */
export const EMBEDDING_TASK_TYPE = 'SEMANTIC_SIMILARITY';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly taskType: string;
  /** One vector per input, in the same order. Normalized to unit length. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** A model that could not be loaded. Never fatal: retrieval degrades rather than stops. */
export class EmbeddingUnavailableError extends Error {
  override readonly name = 'EmbeddingUnavailableError';

  constructor(
    message: string,
    readonly cause_: unknown,
  ) {
    super(message);
  }
}

export interface LocalEmbeddingOptions {
  readonly model: string;
  readonly dimensions: number;
  /** Inputs per forward pass. Larger batches are faster and cost more memory. */
  readonly batchSize?: number;
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * The local model, loaded on first use.
 *
 * The import is dynamic because the package pulls an ONNX runtime and a model download
 * behind it. A build that never embeds anything should not pay for either, and a worker
 * without network access on first run should fail at the point it tries to embed rather
 * than at startup.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly taskType = EMBEDDING_TASK_TYPE;

  private extractor: FeatureExtractor | null = null;
  private loading: Promise<FeatureExtractor> | null = null;

  constructor(private readonly options: LocalEmbeddingOptions) {}

  get model(): string {
    return this.options.model;
  }

  get dimensions(): number {
    return this.options.dimensions;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const extractor = await this.load();
    const batchSize = this.options.batchSize ?? 16;
    const vectors: number[][] = [];

    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize).map(truncate);
      const output = await extractor(batch, { pooling: 'mean', normalize: true });

      for (const vector of output.tolist()) {
        if (vector.length !== this.options.dimensions) {
          // A width mismatch is a configuration error, not a bad input. Storing it would
          // corrupt the column; comparing across widths is meaningless either way.
          throw new EmbeddingUnavailableError(
            `${this.options.model} returned ${vector.length} dimensions, but EMBEDDING_DIMENSIONS is ${this.options.dimensions}`,
            null,
          );
        }
        vectors.push(vector);
      }
    }

    return vectors;
  }

  private async load(): Promise<FeatureExtractor> {
    if (this.extractor !== null) return this.extractor;
    if (this.loading !== null) return this.loading;

    this.loading = (async () => {
      try {
        const transformers = await import('@huggingface/transformers');
        const extractor = (await transformers.pipeline(
          'feature-extraction',
          this.options.model,
        )) as unknown as FeatureExtractor;

        this.extractor = extractor;
        return extractor;
      } catch (error) {
        this.loading = null;
        throw new EmbeddingUnavailableError(
          `the embedding model ${this.options.model} could not be loaded: ${(error as Error).message}`,
          error,
        );
      }
    })();

    return this.loading;
  }
}

export interface EmbeddingConfig {
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
}

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  return new LocalEmbeddingProvider({
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
  });
}

/** The parts of a claim that describe what it is about, rather than what it says. */
export interface ClaimDescription {
  readonly subject: string;
  readonly predicate: string;
  readonly scope?: string | null;
  readonly periodLabel?: string | null;
  readonly unit?: string | null;
  readonly qualifiers?: readonly { readonly name: string; readonly value: string }[];
}

/**
 * Builds the text a claim is embedded as.
 *
 * The value is left out on purpose; see the file header. The period and scope are kept,
 * because they describe the claim without dominating it, and because a retrieval that
 * cannot see them ranks a FY24 figure and a FY21 figure identically — which is fine for
 * recall and useless for reading the results.
 */
export function describeClaim(claim: ClaimDescription): string {
  const parts = [claim.subject, claim.predicate.replace(/_/g, ' ')];

  if (claim.scope !== null && claim.scope !== undefined && claim.scope !== '') {
    parts.push(claim.scope);
  }
  if (claim.periodLabel !== null && claim.periodLabel !== undefined && claim.periodLabel !== '') {
    parts.push(claim.periodLabel);
  }
  if (claim.unit !== null && claim.unit !== undefined && claim.unit !== '') {
    parts.push(`measured in ${claim.unit}`);
  }
  for (const qualifier of claim.qualifiers ?? []) {
    parts.push(`${qualifier.name} ${qualifier.value}`);
  }

  return parts.join(', ');
}

/** Keeps an input inside the model's window without a tokenizer round trip. */
function truncate(text: string): string {
  return text.length > 1200 ? text.slice(0, 1200) : text;
}
