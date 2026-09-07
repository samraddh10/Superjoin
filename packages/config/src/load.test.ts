import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './load.ts';

describe('loadConfig', () => {
  it('falls back to saved-output mode when no API key is set', () => {
    const config = loadConfig({});
    expect(config.modelMode).toBe('saved-output');
    expect(config.openRouterApiKey).toBeUndefined();
  });

  it('treats a blank API key as absent rather than as a live credential', () => {
    // A .env copied from .env.example leaves OPENROUTER_API_KEY set to the empty string.
    // Reading that as live access would fail later with an opaque auth error.
    expect(loadConfig({ OPENROUTER_API_KEY: '   ' }).modelMode).toBe('saved-output');
  });

  it('reports live mode when a key is present', () => {
    const config = loadConfig({ OPENROUTER_API_KEY: 'test-key' });
    expect(config.modelMode).toBe('live');
    expect(config.openRouterApiKey).toBe('test-key');
  });

  it('applies every default named in plan section 1.3', () => {
    const config = loadConfig({});
    expect(config.llmModel).toBe('google/gemma-4-31b-it:free');
    expect(config.embeddingModel).toBe('Xenova/all-mpnet-base-v2');
    expect(config.openRouterBaseUrl).toBe('https://openrouter.ai/api/v1');
    expect(config.embeddingDimensions).toBe(768);
    expect(config.maxUploadMb).toBe(50);
    expect(config.maxPdfPages).toBe(300);
    expect(config.llmConcurrency).toBe(2);
    expect(config.candidateTopK).toBe(15);
    expect(config.storageDir).toBe('./storage');
    expect(config.port).toBe(3000);
    expect(config.databaseUrl).toMatch(/^postgres:\/\//);
  });

  it('supplies the budgets the plan names but leaves unvalued', () => {
    const config = loadConfig({});
    expect(config.documentTokenBudget).toBeGreaterThan(0);
    expect(config.llmTimeoutMs).toBeGreaterThan(0);
    expect(config.providerMaxRetries).toBeGreaterThanOrEqual(0);
  });

  it('reads overrides as numbers, not strings', () => {
    const config = loadConfig({ MAX_UPLOAD_MB: '10', CANDIDATE_TOP_K: '25' });
    expect(config.maxUploadMb).toBe(10);
    expect(config.candidateTopK).toBe(25);
  });

  it('rejects a port that is not a valid TCP port', () => {
    for (const port of ['0', '70000', 'abc', '3000.5']) {
      expect(() => loadConfig({ PORT: port }), `expected ${port} to be rejected`).toThrow(ConfigError);
    }
  });

  it('rejects an embedding width that could not match the vector column', () => {
    // Storing vectors at a width the column does not have fails at insert time, far
    // from the cause. Catching it at startup keeps the failure legible.
    expect(() => loadConfig({ EMBEDDING_DIMENSIONS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ EMBEDDING_DIMENSIONS: 'wide' })).toThrow(ConfigError);
  });

  it('names the offending variable when the environment is invalid', () => {
    expect(() => loadConfig({ MAX_PDF_PAGES: '-1' })).toThrow(/MAX_PDF_PAGES/);
  });
});
