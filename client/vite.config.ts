import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
// `vitest/config` rather than `vite` so the `test` block below is type-checked.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      /**
       * Resolve the shared package to its TypeScript *source*.
       *
       * Vite then treats `shared/` as part of this app's module graph, so a
       * change to a balance constant or a packet shape hot-reloads instantly
       * instead of requiring a rebuild of a dependency. This is the whole
       * reason `@borderfall/shared` ships source rather than a `dist/`.
       */
      '@borderfall/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      /**
       * Proxying keeps the browser on a single origin in development, which
       * sidesteps CORS entirely and — more importantly — makes the dev
       * environment match the production reverse-proxy topology, so
       * origin-related bugs surface locally instead of at deploy time.
       */
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },

  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        /**
         * Pixi is ~400 KB and changes far less often than game code. Splitting
         * it into its own chunk means a gameplay patch invalidates a small
         * bundle rather than forcing every returning player to re-download the
         * renderer.
         */
        manualChunks: {
          pixi: ['pixi.js'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },

  test: {
    name: 'client',
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
