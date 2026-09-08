import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './load.ts';

describe('loadConfig', () => {
  it('falls back to saved-output mode when no region is set', () => {
    const config = loadConfig({});
    expect(config.modelMode).toBe('saved-output');
    expect(config.awsRegion).toBeUndefined();
  });

  it('reports live mode when a region is present', () => {
    const config = loadConfig({ AWS_REGION: 'us-east-1' });
    expect(config.modelMode).toBe('live');
    expect(config.awsRegion).toBe('us-east-1');
  });

  /**
   * Credentials do not decide the mode; the region does.
   *
   * Bedrock credentials legitimately arrive from a task role or SSO profile rather than
   * the environment, so requiring an access key here would report saved-output on exactly
   * the deployment the plan prefers. A region cannot be inferred and no live call can be
   * made without one, which is what makes it the honest signal.
   */
  it('reports live mode from a region alone, with credentials left to the SDK chain', () => {
    const config = loadConfig({ AWS_REGION: 'ap-south-1' });
    expect(config.modelMode).toBe('live');
    expect(config.awsAccessKeyId).toBeUndefined();
    expect(config.awsSecretAccessKey).toBeUndefined();
  });

  it('treats a blank credential as absent rather than as one the SDK should use', () => {
    // A .env copied from .env.example leaves these set to the empty string, and passing
    // that to the SDK fails later with an opaque signature error.
    const config = loadConfig({ AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: '   ' });
    expect(config.awsAccessKeyId).toBeUndefined();
  });

  /**
   * Compose substitutes the empty string for an unset `${AWS_REGION:-}`, so a blank has
   * to select saved-output rather than fail validation. Rejecting it stopped the worker
   * from booting at all, which is the opposite of the fallback the blank was for.
   */
  it('reads a blank region as saved-output instead of refusing to start', () => {
    expect(loadConfig({ AWS_REGION: '' }).modelMode).toBe('saved-output');
    expect(loadConfig({ AWS_REGION: '   ' }).modelMode).toBe('saved-output');
  });

  it('carries explicit credentials through when they are given', () => {
    const config = loadConfig({
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'token',
    });
    expect(config.awsAccessKeyId).toBe('AKIAEXAMPLE');
    expect(config.awsSecretAccessKey).toBe('secret');
    expect(config.awsSessionToken).toBe('token');
  });

  it('applies every default named in plan section 1.3', () => {
    const config = loadConfig({});
    expect(config.bedrockModelId).toBe('moonshotai.kimi-k2.5');
    expect(config.embeddingModel).toBe('Xenova/all-mpnet-base-v2');
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
