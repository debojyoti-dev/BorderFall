import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/**
 * Renderer end-to-end tests.
 *
 * Unit tests cannot verify any of this: they run in jsdom, which has no WebGL
 * context, no compositor and no frame loop. Since Phase 3 the map only exists
 * inside a match, so each test joins one first.
 *
 * Canvas comparison uses Playwright screenshots rather than `getImageData`:
 * Pixi creates its context with `preserveDrawingBuffer: false` (the default,
 * and correct — preserving it costs bandwidth every frame), so reading the
 * drawing buffer back through a 2D canvas returns solid black.
 */

async function canvasSignature(page: Page): Promise<string> {
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('Canvas has no bounding box');
  const buffer = await page.screenshot({
    clip: box,
    animations: 'disabled',
    // Both HUD layers carry values that vary between otherwise identical
    // renders — a live fps counter and live resource totals.
    mask: [page.getByTestId('stats-overlay'), page.locator('.hud-layer')],
  });
  return createHash('sha1').update(buffer).digest('hex');
}

async function enterMatch(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('quick-play').click({ timeout: 30_000 });
  await expect(page.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('stat-fps')).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await enterMatch(page);
});

test('draws a varied map rather than a blank canvas', async ({ page }) => {
  const buffer = await page.locator('canvas').screenshot();
  // A blank canvas compresses to almost nothing; thousands of distinctly
  // coloured polygons do not.
  expect(buffer.byteLength).toBeGreaterThan(20_000);
});

test('runs a live frame loop', async ({ page }) => {
  await page.waitForTimeout(2500);
  const fps = Number((await page.getByTestId('stat-fps').innerText()).replace(/[^0-9]/g, ''));

  // CI renders through SwiftShader (software), an order of magnitude slower
  // than a GPU. This asserts the loop is alive and not pathological — it is
  // not a measurement of the 60 fps target, which needs real hardware.
  expect(fps).toBeGreaterThan(3);
});

test('pans the camera on drag', async ({ page }) => {
  const box = await page.locator('canvas').boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const before = await canvasSignature(page);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 300, box.y + box.height / 2 - 200, { steps: 12 });
  await page.mouse.up();
  // Let inertia settle so the comparison is against a stable frame.
  await page.waitForTimeout(1500);

  expect(await canvasSignature(page)).not.toEqual(before);
});

test('zooms toward the cursor on scroll', async ({ page }) => {
  const box = await page.locator('canvas').boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const readZoom = async (): Promise<number> =>
    Number((await page.getByTestId('stat-zoom').innerText()).replace('x', ''));

  await page.waitForTimeout(800);
  const before = await readZoom();

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(900);

  expect(await readZoom()).toBeGreaterThan(before);
});

test('culls off-screen chunks as it zooms in', async ({ page }) => {
  const box = await page.locator('canvas').boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const readChunks = async (): Promise<number> =>
    Number((await page.getByTestId('stat-chunks').innerText()).replace(/[^0-9]/g, ''));

  await page.waitForTimeout(800);
  const zoomedOut = await readChunks();

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(900);

  // Zooming in must reduce the chunks submitted for drawing, or the culling
  // that makes 5 000 territories affordable is not working.
  expect(await readChunks()).toBeLessThan(zoomedOut);
});

test('selects a territory on click and shows its details', async ({ page }) => {
  const box = await page.locator('canvas').boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  // Off-centre: on join the camera focuses the player's own territory and
  // selects it, so clicking the centre would toggle that selection off.
  await page.mouse.click(box.x + box.width * 0.78, box.y + box.height * 0.28);
  await expect(page.locator('dt', { hasText: 'Borders' })).toBeVisible({ timeout: 10_000 });
});
