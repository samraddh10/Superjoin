import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The API runs as its own service, so the dev server proxies rather than serving both.
 *
 * Everything the app calls lives under one of these prefixes. Proxying in development
 * keeps the browser on a single origin, which means no CORS configuration exists to be
 * wrong in development and permissive in production.
 */
const API_PREFIXES = [
  '/collections',
  '/documents',
  '/facts',
  '/relationships',
  '/runs',
  '/settings',
  '/health',
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Source rather than dist, matching the tsconfig path. The contracts package is
      // Zod and types with no server dependencies, so bundling it from source is safe and
      // removes an ordering requirement between the backend build and the web build.
      '@superjoin/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      API_PREFIXES.map((prefix) => [
        prefix,
        { target: process.env['VITE_API_TARGET'] ?? 'http://localhost:3000', changeOrigin: true },
      ]),
    ),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
