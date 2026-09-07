/**
 * The OpenRouter client, with `fetch` stubbed.
 *
 * These are the behaviours that matter when the endpoint is a free tier: what happens on
 * a 429, on a timeout, on an empty completion, and on a reply that is valid JSON wrapped
 * in something else. None of them can be exercised against the real service on demand.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ModelError,
  OpenRouterClient,
  extractJson,
  imageContentPart,
} from './openrouter.ts';
import { SavedOutputClient, requestFingerprint } from './index.ts';

const OPTIONS = {
  apiKey: 'test-key',
  baseUrl: 'https://openrouter.test/api/v1',
  model: 'google/gemma-4-31b-it:free',
  timeoutMs: 5000,
  // Zero retries by default, so a test that wants retries opts in and the others stay fast.
  maxRetries: 0,
};

const okBody = (content: string) => ({
  model: 'google/gemma-4-31b-it:free',
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 34 },
});

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a successful completion', () => {
  it('returns the text, the serving model and token usage', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody('{"ok":true}')));

    const result = await new OpenRouterClient(OPTIONS).complete({
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.text).toBe('{"ok":true}');
    expect(result.promptTokens).toBe(12);
    expect(result.completionTokens).toBe(34);
    // Reported separately because OpenRouter may route to a different provider than
    // requested, and Phase 8 has to report what actually ran.
    expect(result.servedByModel).toBe('google/gemma-4-31b-it:free');
  });

  it('sends the model, a zero temperature and a fixed seed', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody('{}')));

    await new OpenRouterClient(OPTIONS).complete({ messages: [{ role: 'user', content: 'x' }] });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.model).toBe('google/gemma-4-31b-it:free');
    // Extraction should be as reproducible as a hosted model allows.
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(7);
  });

  it('sends a JSON schema as response_format when one is given', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody('{}')));

    await new OpenRouterClient(OPTIONS).complete({
      messages: [{ role: 'user', content: 'x' }],
      schema: { name: 'claims', schema: { type: 'object' } },
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('claims');
  });

  it('sends the API key as a bearer token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody('{}')));
    await new OpenRouterClient(OPTIONS).complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe('Bearer test-key');
  });
});

describe('failures', () => {
  it('marks a 429 retryable and honours Retry-After', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '3' } }),
    );

    const error = await new OpenRouterClient(OPTIONS)
      .complete({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e as ModelError);

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe('provider_rate_limited');
    expect((error as ModelError).retryable).toBe(true);
    // The provider's own instruction wins over our computed backoff.
    expect((error as ModelError).retryAfterSeconds).toBe(3);
  });

  it('marks a 400 permanent, since retrying a bad request cannot help', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad model' }, { status: 400 }));

    const error = await new OpenRouterClient(OPTIONS)
      .complete({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e as ModelError);

    expect((error as ModelError).retryable).toBe(false);
    expect((error as ModelError).status).toBe(400);
  });

  it('treats an empty completion as a failure to answer', async () => {
    // Free endpoints return this under load. Passing it on would look like a document
    // that legitimately contained no facts.
    fetchMock.mockResolvedValue(jsonResponse(okBody('   ')));

    const error = await new OpenRouterClient(OPTIONS)
      .complete({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e as ModelError);

    expect((error as ModelError).kind).toBe('empty_completion');
    expect((error as ModelError).retryable).toBe(true);
  });

  it('retries a 500 and succeeds on a later attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'upstream' }, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse(okBody('{"recovered":true}')));

    const result = await new OpenRouterClient({ ...OPTIONS, maxRetries: 2 }).complete({
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(result.text).toBe('{"recovered":true}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, { status: 401 }));

    await expect(
      new OpenRouterClient({ ...OPTIONS, maxRetries: 3 }).complete({
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow(ModelError);

    // One attempt, not four: a bad key will still be bad on the fourth try.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies a dropped connection as retryable', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('socket hang up'), { name: 'TypeError' }));

    const error = await new OpenRouterClient(OPTIONS)
      .complete({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e as ModelError);

    expect((error as ModelError).kind).toBe('network_error');
    expect((error as ModelError).retryable).toBe(true);
  });

  it('rejects an unrecognised response envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ nonsense: true }));

    const error = await new OpenRouterClient(OPTIONS)
      .complete({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e as ModelError);

    expect((error as ModelError).kind).toBe('malformed_response');
  });
});

describe('extractJson', () => {
  it('parses a clean object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('recovers JSON from a fenced code block', () => {
    // Structured output constrains shape, not obedience; a free model may still wrap it.
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```\n')).toEqual({ a: 1 });
  });

  it('recovers an object surrounded by prose', () => {
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it('recovers an array', () => {
    expect(extractJson('```\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  it('reports unparsable output as permanent, not retryable', () => {
    const error = (() => {
      try {
        extractJson('I cannot help with that.');
      } catch (e) {
        return e as ModelError;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(ModelError);
    expect(error?.retryable).toBe(false);
  });
});

describe('imageContentPart', () => {
  it('encodes bytes as a data URL', () => {
    const part = imageContentPart(new Uint8Array([137, 80, 78, 71]));
    expect(part.type).toBe('image_url');
    if (part.type !== 'image_url') return;
    expect(part.image_url.url).toMatch(/^data:image\/png;base64,/);
  });
});

describe('saved-output mode', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'superjoin-model-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('replays a recorded response without touching the network', async () => {
    const client = new SavedOutputClient('google/gemma-4-31b-it:free', cacheDir);
    const request = { messages: [{ role: 'user' as const, content: 'hello' }] };
    const fingerprint = requestFingerprint('google/gemma-4-31b-it:free', request);
    const path = join(cacheDir, fingerprint.slice(0, 2), `${fingerprint}.json`);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        text: '{"replayed":true}',
        servedByModel: 'google/gemma-4-31b-it:free',
        promptTokens: 1,
        completionTokens: 2,
        latencyMs: 3,
      }),
    );

    const result = await client.complete(request);
    expect(result.text).toBe('{"replayed":true}');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails loudly on a miss instead of returning nothing', async () => {
    // A silent empty answer would look like a document that contained no facts.
    const client = new SavedOutputClient('google/gemma-4-31b-it:free', cacheDir);

    const error = await client
      .complete({ messages: [{ role: 'user', content: 'unrecorded' }] })
      .catch((e: unknown) => e as ModelError);

    expect((error as ModelError).kind).toBe('saved_output_missing');
    expect((error as ModelError).message).toContain('OPENROUTER_API_KEY');
  });

  it('keys a replay on the exact request', async () => {
    // A looser key would answer a new question with an old answer.
    const a = requestFingerprint('m', { messages: [{ role: 'user', content: 'page 1' }] });
    const b = requestFingerprint('m', { messages: [{ role: 'user', content: 'page 2' }] });
    expect(a).not.toBe(b);
  });
});
