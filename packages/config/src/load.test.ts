import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, requireModelAccess } from './load.ts';

describe('loadConfig', () => {
  it('loads without a provider, so a service that never calls the model can start', () => {
    // The API is that service: it holds no model credential by design, and it reaches
    // this same loader through createDatabase.
    const config = loadConfig({});
    expect(config.awsRegion).toBeUndefined();
    expect(config.groqApiKey).toBeUndefined();
  });

  it('reads a region that is present', () => {
    expect(loadConfig({ AWS_REGION: 'us-east-1' }).awsRegion).toBe('us-east-1');
  });

  /**
   * Credentials do not decide whether Bedrock is available; the region does.
   *
   * Bedrock credentials legitimately arrive from a task role or SSO profile rather than
   * the environment, so requiring an access key here would refuse exactly the deployment
   * the plan prefers. A region cannot be inferred and no call can be made without one,
   * which is what makes it the honest signal.
   */
  it('accepts a region alone, with credentials left to the SDK chain', () => {
    const config = loadConfig({ AWS_REGION: 'ap-south-1' });
    expect(config.awsRegion).toBe('ap-south-1');
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
   * to read as an absent provider rather than fail validation here. The refusal belongs
   * to `requireModelAccess`, which names what is missing; a schema rejection would only
   * say the variable was invalid.
   */
  it('reads a blank region as an absent provider rather than refusing to parse', () => {
    expect(loadConfig({ AWS_REGION: '' }).awsRegion).toBeUndefined();
    expect(loadConfig({ AWS_REGION: '   ' }).awsRegion).toBeUndefined();
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

describe('requireModelAccess', () => {
  it('refuses to start when neither provider is configured', () => {
    // There is no offline mode behind this: the caller is about to reach a provider on
    // every document, and it must not be told to proceed without one.
    expect(() => requireModelAccess(loadConfig({}))).toThrow(ConfigError);
    expect(() => requireModelAccess(loadConfig({ AWS_REGION: '  ' }))).toThrow(
      /no model provider is configured/,
    );
  });

  it('accepts either provider on its own', () => {
    // Which one a run uses is a runtime setting, so one configured provider is enough to
    // start; demanding both would refuse a machine that is set up to use the one it has.
    expect(() => requireModelAccess(loadConfig({ AWS_REGION: 'us-east-1' }))).not.toThrow();
    expect(() => requireModelAccess(loadConfig({ GROQ_API_KEY: 'gsk-test' }))).not.toThrow();
  });
});
