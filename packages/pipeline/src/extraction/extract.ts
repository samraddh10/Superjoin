/**
 * Extracting claims from one chunk.
 *
 * One model call, one Zod parse, and at most one repair. Everything about the failure
 * handling follows from the same measured fact that shaped the visual route: on the free
 * pool a 429 is ordinary traffic, not an incident, so this function fails loudly for the
 * chunk it was given and leaves the rest of the document to its caller.
 *
 * The Zod parse after `response_format` is not defensive duplication. Plan 4.1 requires
 * it, because a provider under load may ignore the schema entirely, and because a reply
 * that satisfies the shape can still be unusable — a predicate in Title Case, a
 * `numeric_value` carrying a currency symbol, a claim citing no block at all.
 */

import {
  ModelError,
  extractJson,
  type ChatMessage,
  type CompletionProvider,
} from '../model/index.ts';
import type { Chunk } from '../parsing/chunk.ts';
import {
  EXTRACTION_RESPONSE_SCHEMA,
  parseExtraction,
  type ExtractedClaim,
} from './contract.ts';
import { buildExtractionMessages, buildRepairMessages } from './prompt.ts';

export interface ExtractChunkOptions {
  readonly client: CompletionProvider;
  readonly maxTokens?: number;
  /** Whether a schema failure may be sent back once for correction. */
  readonly allowRepair?: boolean;
  /**
   * The collection's predicate vocabulary, rendered for the prompt.
   *
   * Absent for the first document in a collection, which has nothing to reuse yet and is
   * the one that establishes the names the rest will follow.
   */
  readonly vocabulary?: string;
}

export interface ChunkExtraction {
  readonly chunkIndex: number;
  readonly claims: readonly ExtractedClaim[];
  /** What actually served the request, which need not be what was requested. */
  readonly servedByModel: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
  /** True when the first reply failed validation and the second was accepted. */
  readonly repaired: boolean;
}

/**
 * Extracts the claims one chunk supports.
 *
 * Token counts are summed across the repair attempt as well, because plan 4.2 asks for
 * token usage to be recorded and a repair is spend the evaluation has to see.
 */
export async function extractChunk(
  chunk: Chunk,
  options: ExtractChunkOptions,
): Promise<ChunkExtraction> {
  const messages: ChatMessage[] = buildExtractionMessages(chunk, options.vocabulary ?? '');

  const first = await options.client.complete({
    messages,
    schema: { name: 'extracted_claims', schema: EXTRACTION_RESPONSE_SCHEMA },
    maxTokens: options.maxTokens ?? 4000,
  });

  const firstParse = parseExtraction(readJson(first.text));
  if (firstParse.ok) {
    return {
      chunkIndex: chunk.index,
      claims: firstParse.claims,
      servedByModel: first.servedByModel,
      promptTokens: first.promptTokens,
      completionTokens: first.completionTokens,
      latencyMs: first.latencyMs,
      repaired: false,
    };
  }

  if (options.allowRepair === false) {
    throw new ModelError(
      `extraction did not match the schema: ${firstParse.feedback}`,
      'schema_violation',
      true,
    );
  }

  const second = await options.client.complete({
    messages: buildRepairMessages(messages, first.text, firstParse.feedback),
    schema: { name: 'extracted_claims', schema: EXTRACTION_RESPONSE_SCHEMA },
    maxTokens: options.maxTokens ?? 4000,
  });

  const secondParse = parseExtraction(readJson(second.text));
  if (!secondParse.ok) {
    // Two failures is not a run of bad luck to keep pushing through. The chunk is
    // recorded as failed and the document keeps its other chunks, which is the same
    // trade the parsing stage makes for an unreadable page.
    throw new ModelError(
      `extraction did not match the schema after one repair: ${secondParse.feedback}`,
      'schema_violation_after_repair',
      false,
    );
  }

  return {
    chunkIndex: chunk.index,
    claims: secondParse.claims,
    servedByModel: second.servedByModel,
    promptTokens: first.promptTokens + second.promptTokens,
    completionTokens: first.completionTokens + second.completionTokens,
    latencyMs: first.latencyMs + second.latencyMs,
    repaired: true,
  };
}

/**
 * Reads the reply as JSON, treating unparsable output as a validation failure.
 *
 * `extractJson` throws when it finds nothing parsable at all. Converting that into a
 * value the schema will reject keeps both kinds of malformed reply on the same repair
 * path, instead of one being repairable and the other fatal for no principled reason.
 */
function readJson(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return { claims: null };
  }
}
