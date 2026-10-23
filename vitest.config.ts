import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript sources through this export condition,
// so tests never run against stale `dist` builds.
const SOURCE_CONDITION = '@pearcoderhq/source';

export default defineConfig({
  resolve: {
    conditions: [SOURCE_CONDITION, 'module', 'node', 'development|production'],
  },
  ssr: {
    resolve: {
      conditions: [SOURCE_CONDITION, 'module', 'node', 'development|production'],
      externalConditions: [SOURCE_CONDITION],
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    passWithNoTests: false,
    // Many tests run real servers, TLS and multiple clients; slow CI runners (Windows) need room.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    server: {
      deps: {
        inline: [/@pearcoderhq\//],
      },
    },
  },
});
