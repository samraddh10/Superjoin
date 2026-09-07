import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Workspace packages expose their TypeScript sources under the `development`
    // condition and their compiled output otherwise, so tests run against source
    // without a build step while production still consumes what tsc emitted.
    conditions: ['development'],
  },
  test: {
    include: [
      '{apps,packages}/*/src/**/*.test.ts',
      // The evaluation workspace sits beside apps and packages rather than inside them.
      'evaluation/src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    // Extraction tests open real PDFs from datasets/, so paths resolve from the root.
    root: import.meta.dirname,
  },
});
