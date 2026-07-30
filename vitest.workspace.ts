import { defineWorkspace } from 'vitest/config';

/**
 * Three test projects, because they need genuinely different environments:
 *
 * - `shared` and `server` run in Node. They are pure simulation code, and
 *   running them in jsdom would both slow them down and hide accidental DOM
 *   dependencies that must never exist in server code.
 * - `client` runs in jsdom for component tests.
 *
 * Keeping them split also means `vitest --project server` gives a fast,
 * focused loop while iterating on the engine.
 */
export default defineWorkspace([
  {
    test: {
      name: 'shared',
      root: './shared',
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
    resolve: {
      alias: {
        '@borderfall/shared': new URL('./shared/src/index.ts', import.meta.url).pathname,
      },
    },
  },
  {
    test: {
      name: 'server',
      root: './server',
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
    resolve: {
      alias: {
        '@borderfall/shared': new URL('./shared/src/index.ts', import.meta.url).pathname,
      },
    },
  },
  './client',
]);
