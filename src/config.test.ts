import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('falls back to saved-output mode when no API key is set', () => {
    const config = loadConfig({});
    assert.equal(config.modelMode, 'saved-output');
    assert.equal(config.geminiApiKey, undefined);
  });

  it('treats a blank API key as absent rather than as a live credential', () => {
    // A .env copied from .env.example leaves GEMINI_API_KEY set to the empty string.
    // Reading that as live access would fail later with an opaque auth error.
    const config = loadConfig({ GEMINI_API_KEY: '   ' });
    assert.equal(config.modelMode, 'saved-output');
  });

  it('reports live mode when a key is present', () => {
    const config = loadConfig({ GEMINI_API_KEY: 'test-key' });
    assert.equal(config.modelMode, 'live');
    assert.equal(config.geminiApiKey, 'test-key');
  });

  it('applies defaults for the unset variables', () => {
    const config = loadConfig({});
    assert.equal(config.port, 3000);
    assert.equal(config.storageDir, './storage');
    assert.match(config.databaseUrl, /^postgres:\/\//);
  });

  it('rejects a port that is not a valid TCP port', () => {
    for (const port of ['0', '70000', 'abc', '3000.5']) {
      assert.throws(() => loadConfig({ PORT: port }), ConfigError, `expected ${port} to be rejected`);
    }
  });
});
