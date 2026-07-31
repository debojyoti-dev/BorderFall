import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
// `vitest/config` rather than `vite` so the `test` block below is type-checked.
import { defineConfig } from 'vitest/config';

/**
 * Proxy rules shared by the dev and preview servers.
 *
 * Keeping the browser on a single origin sidesteps CORS entirely and makes the
 * local topology match the deployed one, so origin-related bugs surface here
 * rather than after a deploy. The target is configurable because the end-to-end
 * suite runs the API on a separate port from the development default.
 */
function proxyConfig() {
  const target = process.env['BORDERFALL_SERVER_ORIGIN'] ?? 'http://localhost:3001';
  return {
    '/api': {
      target,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api/, ''),
    },
    '/socket.io': {
      target,
      ws: true,
      changeOrigin: true,
    },
  };
}

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
    proxy: proxyConfig(),
  },

  /**
   * The preview server proxies too, so the production bundle can be exercised
   * end to end against a real backend. In an actual deployment nginx fills this
   * role — see `docker/nginx.conf`.
   */
  preview: {
    proxy: proxyConfig(),
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
