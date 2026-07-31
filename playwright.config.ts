import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * These tests exist to verify the things unit tests structurally cannot: that
 * PixiJS actually initialises a WebGL context, that 5 000 territories reach the
 * screen, and that pointer gestures move the camera. A renderer that
 * type-checks and passes unit tests can still render a blank canvas.
 */
export default defineConfig({
  testDir: './e2e',

  /**
   * Serial, with a generous timeout.
   *
   * These tests software-render 5 000 polygons through SwiftShader. Running
   * them in parallel puts several such browsers on the same CPU, and
   * everything — screenshots, even `mouse.wheel` — starts hitting the default
   * 30 s timeout. Rendering tests are CPU-bound, so parallelism costs
   * throughput here instead of buying it.
   */
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,

  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Headless Chrome falls back to SwiftShader for WebGL. These flags
          // keep that path enabled rather than failing to acquire a context,
          // which is what makes canvas rendering testable in CI at all.
          args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],

  /**
   * Both halves of the stack.
   *
   * Phase 3 tests are genuinely end-to-end — the client obtains a guest token
   * over REST, joins a match over WebSocket, and rebuilds the world from the
   * seed the server chose. A client-only preview cannot exercise any of that.
   */
  webServer: [
    {
      command: 'npm run start --workspace=@borderfall/server',
      url: 'http://localhost:3101/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        NODE_ENV: 'production',
        PORT: '3101',
        JWT_SECRET: 'e2e-test-secret',
        MONGO_ENABLED: 'false',
        LOG_LEVEL: 'warn',
        CORS_ORIGINS: 'http://localhost:4173',
      },
    },
    {
      command: 'npm run preview --workspace=@borderfall/client -- --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      // Points the preview proxy at the API instance started above.
      env: { BORDERFALL_SERVER_ORIGIN: 'http://localhost:3101' },
    },
  ],
});
