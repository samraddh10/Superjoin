/**
 * The Bedrock client and the contracts around it.
 *
 * The interesting cases are the places Bedrock differs from the chat-completions shape
 * the rest of the pipeline was written against: system prompts are a separate field, a
 * schema is a forced tool call rather than `response_format`, images are typed blocks
 * rather than data URLs, and failures are named exceptions rather than status codes.
 * Each of those is somewhere a wrong assumption would fail at runtime against a real
 * account, so each is pinned here.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const send = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-bedrock-runtime')>();
  return {
    ...actual,
    BedrockRuntimeClient: class {
      send = send;
    },
  };
});

const { BedrockClient } = await import('./bedrock.ts');
const { ModelError, extractJson, imageContentPart } = await import('./types.ts');

const OPTIONS = {
  modelId: 'anthropic.claude-sonnet-4-5-v1:0',
  region: 'us-east-1',
  timeoutMs: 30_000,
  maxRetries: 0,
};

/** What Bedrock returns for a plain text answer. */
function textReply(text: string) {
  return {
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 11, outputTokens: 7 },
    stopReason: 'end_turn',
  };
}

/** What Bedrock returns when a forced tool call is satisfied. */
function toolReply(name: string, input: unknown) {
  return {
    output: { message: { content: [{ toolUse: { name, input, toolUseId: 't1' } }] } },
    usage: { inputTokens: 20, outputTokens: 30 },
    stopReason: 'tool_use',
  };
}

function awsError(name: string, httpStatusCode = 400): Error {
  const error = new Error(`${name} raised`);
  error.name = name;
  (error as unknown as { $metadata: unknown }).$metadata = { httpStatusCode };
  return error;
}

beforeEach(() => {
  send.mockReset();
});

describe('BedrockClient', () => {
  it('lifts system prompts out of the message list', async () => {
    send.mockResolvedValue(textReply('done'));

    await new BedrockClient(OPTIONS).complete({
      messages: [
        { role: 'system', content: 'You extract claims.' },
        { role: 'user', content: 'Revenue was 8,142 Cr.' },
      ],
    });

    const input = send.mock.calls[0]?.[0].input;
    // Bedrock rejects a system role inside `messages` outright rather than ignoring it.
    expect(input.system).toEqual([{ text: 'You extract claims.' }]);
    expect(input.messages).toHaveLength(1);
    expect(input.messages[0].role).toBe('user');
  });

  it('sends a schema as a forced tool call and returns its arguments as JSON', async () => {
    const claims = { claims: [{ subject: 'revenue', value: '8142' }] };
    send.mockResolvedValue(toolReply('extracted_claims', claims));

    const result = await new BedrockClient(OPTIONS).complete({
      messages: [{ role: 'user', content: 'extract' }],
      schema: {
        name: 'extracted_claims',
        schema: { type: 'object', properties: { claims: { type: 'array' } }, required: ['claims'] },
      },
    });

    const input = send.mock.calls[0]?.[0].input;
    expect(input.toolConfig.tools[0].toolSpec.name).toBe('extracted_claims');
    // Required rather than auto: the caller asked for a shape, so prose is not an
    // acceptable alternative to calling the tool.
    expect(input.toolConfig.toolChoice).toEqual({ tool: { name: 'extracted_claims' } });

    // Handed back stringified so callers run one parse path whether a schema was used or
    // not, which is what lets extractJson and Zod stay unchanged.
    expect(extractJson(result.text)).toEqual(claims);
    expect(result.promptTokens).toBe(20);
    expect(result.completionTokens).toBe(30);
  });

  it('omits the tool config entirely when no schema was asked for', async () => {
    send.mockResolvedValue(textReply('plain answer'));

    const result = await new BedrockClient(OPTIONS).complete({
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(send.mock.calls[0]?.[0].input.toolConfig).toBeUndefined();
    expect(result.text).toBe('plain answer');
  });

  it('converts an image part into a typed Bedrock image block', async () => {
    send.mockResolvedValue(textReply('transcribed'));

    await new BedrockClient(OPTIONS).complete({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe this page.' },
            imageContentPart(new Uint8Array([137, 80, 78, 71]), 'image/png'),
          ],
        },
      ],
    });

    const block = send.mock.calls[0]?.[0].input.messages[0].content[1];
    // Bedrock names the format itself and takes raw bytes, not a data URL.
    expect(block.image.format).toBe('png');
    expect(Buffer.from(block.image.source.bytes)).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it('refuses an image type Bedrock does not accept, rather than sending it', async () => {
    await expect(
      new BedrockClient(OPTIONS).complete({
        messages: [{ role: 'user', content: [imageContentPart(new Uint8Array([1]), 'image/tiff')] }],
      }),
    ).rejects.toMatchObject({ kind: 'unsupported_image_format' });

    expect(send).not.toHaveBeenCalled();
  });

  /**
   * The distinction the extraction stage's give-up rule depends on.
   *
   * Throttling and validation are both 400-family on the wire, and one clears on its own
   * while the other never will. Classifying by status code would collapse them.
   */
  it('treats throttling as retryable and validation as permanent', async () => {
    send.mockRejectedValue(awsError('ThrottlingException', 429));
    await expect(
      new BedrockClient(OPTIONS).complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'provider_rate_limited', retryable: true });

    send.mockRejectedValue(awsError('ValidationException', 400));
    await expect(
      new BedrockClient(OPTIONS).complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'invalid_request', retryable: false });
  });

  it('does not retry an access denial, which no amount of waiting fixes', async () => {
    send.mockRejectedValue(awsError('AccessDeniedException', 403));

    const client = new BedrockClient({ ...OPTIONS, maxRetries: 5 });
    await expect(
      client.complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'provider_access_denied', retryable: false });

    // Model access is granted per region in the console; eight retries only delay the
    // message that says so.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and returns the eventual success', async () => {
    send
      .mockRejectedValueOnce(awsError('ServiceUnavailableException', 503))
      .mockResolvedValue(textReply('second time'));

    const result = await new BedrockClient({ ...OPTIONS, maxRetries: 2 }).complete({
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(result.text).toBe('second time');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty completion instead of reporting a document with no facts', async () => {
    send.mockResolvedValue({ output: { message: { content: [{ text: '   ' }] } }, stopReason: 'max_tokens' });

    await expect(
      new BedrockClient(OPTIONS).complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'empty_completion', retryable: true });
  });

  it('records the model that was asked for, so a run says what produced it', async () => {
    send.mockResolvedValue(textReply('ok'));

    const result = await new BedrockClient(OPTIONS).complete({
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(result.servedByModel).toBe('anthropic.claude-sonnet-4-5-v1:0');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('recovers an object from a fenced block', () => {
    expect(extractJson('here you go:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('recovers an object surrounded by prose', () => {
    expect(extractJson('Sure! {"a":3} hope that helps')).toEqual({ a: 3 });
  });

  it('fails permanently when there is no JSON at all', () => {
    try {
      extractJson('I could not find any claims.');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
      expect((error as InstanceType<typeof ModelError>).retryable).toBe(false);
    }
  });
});

describe('imageContentPart', () => {
  it('carries the media type and base64 bytes, not a vendor URL shape', () => {
    const part = imageContentPart(new Uint8Array([137, 80, 78, 71]));
    expect(part.type).toBe('image');
    if (part.type !== 'image') return;
    expect(part.mimeType).toBe('image/png');
    expect(Buffer.from(part.base64, 'base64')).toEqual(Buffer.from([137, 80, 78, 71]));
  });
});
