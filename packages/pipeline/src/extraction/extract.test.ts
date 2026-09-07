/**
 * The extraction contract and the call around it.
 *
 * The interesting cases are all failures. A free endpoint under load returns prose,
 * fenced JSON, a Title Case predicate or a claim with no citation, and the plan's answer
 * to each is a bounded repair rather than an exception, so that is what is tested.
 */

import { describe, expect, it } from 'vitest';

import type { CompletionProvider, CompletionRequest, CompletionResult } from '../model/index.ts';
import { ModelError } from '../model/index.ts';
import type { Chunk } from '../parsing/chunk.ts';
import { EXTRACTION_RESPONSE_SCHEMA, parseExtraction } from './contract.ts';
import { extractChunk } from './extract.ts';
import { buildExtractionMessages } from './prompt.ts';

const chunk: Chunk = {
  index: 0,
  text: '[page 5]\n\n[B1]\nRevenue from services was 8,142 Cr in FY24.',
  heading: null,
  sourceBlockIds: ['block-1'],
  blockRefs: [{ ref: 'B1', sourceBlockId: 'block-1' }],
  physicalPages: [5],
  estimatedTokens: 20,
};

const validClaim = {
  subject: 'Delhivery Limited',
  predicate: 'revenue_from_services',
  original_statement: 'Revenue from services was 8,142 Cr in FY24.',
  raw_value: '8,142 Cr',
  numeric_value: '8142',
  currency: 'INR',
  scale: 'crore',
  unit: null,
  period_label: 'FY2024',
  period_type: 'fiscal_year',
  scope: null,
  assertion_status: 'reported',
  qualifiers: [],
  evidence_block_ids: ['B1'],
  quote: 'Revenue from services was 8,142 Cr in FY24.',
};

/** A provider that answers from a fixed script, so a call sequence is observable. */
class ScriptedClient implements CompletionProvider {
  readonly mode = 'live' as const;
  readonly model = 'test/model';
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly replies: readonly (string | ModelError)[]) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const reply = this.replies[this.requests.length - 1];
    if (reply === undefined) throw new Error('the client was called more times than scripted');
    if (reply instanceof ModelError) throw reply;

    return {
      text: reply,
      servedByModel: 'test/model-served',
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 10,
    };
  }
}

describe('parseExtraction', () => {
  it('accepts a well-formed reply', () => {
    const parsed = parseExtraction({ claims: [validClaim] });
    expect(parsed.ok).toBe(true);
  });

  it('rejects a numeric_value that is not a plain decimal string', () => {
    // A currency symbol here is how a financial figure ends up going through a Number.
    const parsed = parseExtraction({
      claims: [{ ...validClaim, numeric_value: '₹8,142' }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.feedback).toContain('numeric_value');
  });

  it('rejects a predicate that is not lower_snake_case', () => {
    const parsed = parseExtraction({
      claims: [{ ...validClaim, predicate: 'Revenue From Services' }],
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a claim that cites nothing', () => {
    // A claim with no citation cannot be grounded, so there is nothing to review later.
    const parsed = parseExtraction({ claims: [{ ...validClaim, evidence_block_ids: [] }] });
    expect(parsed.ok).toBe(false);
  });

  it('names the offending path so the repair has something to correct', () => {
    const parsed = parseExtraction({ claims: [{ ...validClaim, quote: '' }] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.feedback).toContain('quote');
  });

  it('keeps a null period rather than treating it as missing', () => {
    const parsed = parseExtraction({
      claims: [{ ...validClaim, period_label: null, period_type: null }],
    });
    expect(parsed.ok).toBe(true);
  });
});

describe('the response schema sent to the provider', () => {
  it('marks every property required, as strict mode demands', () => {
    const item = EXTRACTION_RESPONSE_SCHEMA.properties.claims.items;
    expect(item.required.length).toBe(Object.keys(item.properties).length);
    expect(item.additionalProperties).toBe(false);
  });
});

describe('buildExtractionMessages', () => {
  it('lists the handles the model may cite', () => {
    const [, user] = buildExtractionMessages(chunk);
    expect(user?.content).toContain('B1');
  });

  it('tells the model the passage is data, not instruction', () => {
    // Plan 4.2: PDF text is source data, embedded imperatives included.
    const [system] = buildExtractionMessages(chunk);
    expect(String(system?.content)).toContain('not instruction');
  });

  it('never puts a filename in the prompt', () => {
    // Acceptance criterion A2 requires a renamed PDF to produce equivalent claims, which
    // it cannot if the name is part of what the model is shown.
    const rendered = buildExtractionMessages(chunk).map((message) => String(message.content)).join('');
    expect(rendered).not.toContain('.pdf');
  });
});

describe('extractChunk', () => {
  it('returns the claims from a well-formed reply', async () => {
    const client = new ScriptedClient([JSON.stringify({ claims: [validClaim] })]);
    const result = await extractChunk(chunk, { client });

    expect(result.claims).toHaveLength(1);
    expect(result.repaired).toBe(false);
    expect(result.servedByModel).toBe('test/model-served');
    expect(client.requests).toHaveLength(1);
  });

  it('recovers JSON wrapped in prose and a code fence', async () => {
    const client = new ScriptedClient([
      'Certainly. Here are the claims:\n```json\n' +
        JSON.stringify({ claims: [validClaim] }) +
        '\n```',
    ]);

    const result = await extractChunk(chunk, { client });
    expect(result.claims).toHaveLength(1);
    expect(result.repaired).toBe(false);
  });

  it('repairs once with the validation failure fed back', async () => {
    const client = new ScriptedClient([
      JSON.stringify({ claims: [{ ...validClaim, predicate: 'Revenue' }] }),
      JSON.stringify({ claims: [validClaim] }),
    ]);

    const result = await extractChunk(chunk, { client });

    expect(result.repaired).toBe(true);
    expect(result.claims).toHaveLength(1);
    // The repair carries the rejected reply and the specific problem, not a bare retry.
    const repair = client.requests[1]!;
    const last = repair.messages[repair.messages.length - 1];
    expect(String(last?.content)).toContain('predicate');
  });

  it('sums tokens across the repair, so the spend is not understated', async () => {
    const client = new ScriptedClient([
      JSON.stringify({ claims: [{ ...validClaim, predicate: 'Revenue' }] }),
      JSON.stringify({ claims: [validClaim] }),
    ]);

    const result = await extractChunk(chunk, { client });
    expect(result.promptTokens).toBe(200);
    expect(result.completionTokens).toBe(100);
  });

  it('gives up after one repair rather than spending the budget on a stuck model', async () => {
    const bad = JSON.stringify({ claims: [{ ...validClaim, predicate: 'Revenue' }] });
    const client = new ScriptedClient([bad, bad]);

    await expect(extractChunk(chunk, { client })).rejects.toMatchObject({
      kind: 'schema_violation_after_repair',
      retryable: false,
    });
    expect(client.requests).toHaveLength(2);
  });

  it('treats an unparsable reply as a schema failure, not a fatal error', async () => {
    const client = new ScriptedClient([
      'I cannot help with that.',
      JSON.stringify({ claims: [validClaim] }),
    ]);

    const result = await extractChunk(chunk, { client });
    expect(result.repaired).toBe(true);
  });

  it('propagates a throttle so the stage can count it as one', async () => {
    const client = new ScriptedClient([
      new ModelError('429', 'provider_rate_limited', true, 30, 429),
    ]);

    await expect(extractChunk(chunk, { client })).rejects.toMatchObject({
      kind: 'provider_rate_limited',
    });
  });
});
