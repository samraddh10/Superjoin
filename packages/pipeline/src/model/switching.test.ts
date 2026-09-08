/**
 * The provider switch.
 *
 * What matters here is that the setting is read *per call*, because the whole point is a
 * toggle taking effect in a worker nobody restarted — and that a misconfigured or
 * unreadable setting degrades to a working provider rather than taking the run down.
 */

import { describe, expect, it, vi } from 'vitest';

import { SwitchingClient, type ProviderEntry } from './switching.ts';
import type { CompletionResult } from './types.ts';

function reply(model: string): CompletionResult {
  return { text: model, servedByModel: model, promptTokens: 1, completionTokens: 1, latencyMs: 0 };
}

function entry(model: string): ProviderEntry {
  return { model, complete: vi.fn(async () => reply(model)) };
}

/** A database stand-in whose single settings row can be changed between calls. */
function fakeDb(provider: () => string | undefined) {
  return {
    select: () => ({
      from: () => ({
        limit: async () => {
          const value = provider();
          return value === undefined ? [] : [{ activeProvider: value }];
        },
      }),
    }),
  } as never;
}

const request = { messages: [{ role: 'user' as const, content: 'x' }] };

describe('SwitchingClient', () => {
  it('sends to whichever provider the setting names', async () => {
    const client = new SwitchingClient({
      db: fakeDb(() => 'groq'),
      providers: { bedrock: entry('kimi'), groq: entry('llama') },
      fallback: 'bedrock',
    });

    expect((await client.complete(request)).servedByModel).toBe('llama');
  });

  /**
   * The reason this class exists rather than resolving once at construction.
   *
   * The cache is short-lived, so the second call is made past its window.
   */
  it('picks up a change without being rebuilt', async () => {
    let active = 'bedrock';
    const client = new SwitchingClient({
      db: fakeDb(() => active),
      providers: { bedrock: entry('kimi'), groq: entry('llama') },
      fallback: 'bedrock',
    });

    expect((await client.complete(request)).servedByModel).toBe('kimi');

    active = 'groq';
    vi.setSystemTime(Date.now() + 10_000);

    expect((await client.complete(request)).servedByModel).toBe('llama');
    vi.useRealTimers();
  });

  it('falls back when the setting names a provider with no credentials', async () => {
    const client = new SwitchingClient({
      db: fakeDb(() => 'groq'),
      providers: { bedrock: entry('kimi') },
      fallback: 'bedrock',
    });

    // Selecting an unconfigured provider must not strand the run: the API refuses that
    // switch, but a row written before a key was removed would otherwise poison every call.
    expect((await client.complete(request)).servedByModel).toBe('kimi');
  });

  it('falls back when the settings row cannot be read at all', async () => {
    const broken = {
      select: () => ({
        from: () => ({
          limit: async () => {
            throw new Error('connection reset');
          },
        }),
      }),
    } as never;

    const client = new SwitchingClient({
      db: broken,
      providers: { bedrock: entry('kimi'), groq: entry('llama') },
      fallback: 'groq',
    });

    // A settings read is not worth failing a completion over.
    expect((await client.complete(request)).servedByModel).toBe('llama');
  });

  it('reports a clear error when the chosen provider has no client', async () => {
    const client = new SwitchingClient({
      db: fakeDb(() => 'groq'),
      providers: {},
      fallback: 'groq',
    });

    await expect(client.complete(request)).rejects.toMatchObject({
      kind: 'provider_not_configured',
      retryable: false,
    });
  });
});
