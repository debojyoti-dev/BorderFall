import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  /**
   * `@borderfall/shared` is published as TypeScript source, not as a built
   * package — that is what gives us cross-package HMR in development. For the
   * production bundle it therefore has to be compiled *in* rather than left as
   * an external import that Node could not resolve at runtime.
   */
  noExternal: ['@borderfall/shared'],
  /** Native/optional Socket.IO deps that must stay external to load correctly. */
  external: ['bufferutil', 'utf-8-validate'],
});
