import { createHash } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Renderer end-to-end tests.
 *
 * The claim under test is "5 000 territories render and respond to input".
 * Unit tests cannot verify any of it: they run in jsdom, which has no WebGL
 * context, no compositor and no frame loop.
 *
 * **Canvas comparison uses Playwright screenshots, not `getImageData`.** Pixi
 * creates its WebGL context with `preserveDrawingBuffer: false` (the default,
 * and the right choice — preserving it costs memory bandwidth every frame), so
 * the drawing buffer is cleared after compositing. Reading it back through
 * `drawImage` into a 2D canvas returns solid black. Screenshots capture the
 * composited result and are what actually reflects what a player sees.
 */

/**
 * Stable hash of the canvas pixels, for comparing renders.
 *
 * Uses a clipped *page* screenshot rather than `locator.screenshot()`: the
 * element variant runs a stabilisation pass that waits on `document.fonts`,
 * which never settles here and times the test out. Clipping skips it.
 */
async function canvasSignature(page: Page): Promise<string> {
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('Canvas has no bounding box');
  const buffer = await page.screenshot({
    clip: box,
    animations: 'disabled',
    /**
     * Both HUD layers sit on top of the canvas and carry values that vary
     * between otherwise identical renders — a live fps counter and a
     * "generated in N ms" readout. Masking them is what makes the determinism
     * comparison meaningful: without it, two pixel-identical maps differ by
     * ~116 pixels of timing text.
     */
    mask: [page.getByTestId('stats-overlay'), page.getByTestId('hud-panels')],
  });
  return createHash('sha1').update(buffer).digest('hex');
}

function statZoom(page: Page): Locator {
  return page.getByTestId('stat-zoom');
}

async function readZoom(page: Page): Promise<number> {
  return Number((await statZoom(page).innerText()).replace('x', ''));
}

async function waitForFirstFrame(page: Page): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible({ timeout: 30_000 });
  // The overlay only appears after the ticker has produced frames, making it a
  // reliable "rendering has started" signal.
  await expect(page.getByTestId('stat-fps')).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForFirstFrame(page);
});

test('generates and renders a full-size world', async ({ page }) => {
  const territoryText = await page
    .locator('dt', { hasText: 'Territories' })
    .locator('xpath=following-sibling::dd[1]')
    .innerText();
  const territories = Number(territoryText.replace(/[^0-9]/g, ''));

  expect(territories).toBeGreaterThan(4000);
  expect(territories).toBeLessThan(6500);
});

test('draws a varied map rather than a blank canvas', async ({ page }) => {
  const buffer = await page.locator('canvas').screenshot();

  // A blank canvas compresses to almost nothing. A map of thousands of
  // distinctly coloured polygons does not.
  expect(buffer.byteLength).toBeGreaterThan(20_000);
});

test('runs a live frame loop', async ({ page }) => {
  await page.waitForTimeout(2500);
  const fps = Number((await page.getByTestId('stat-fps').innerText()).replace(/[^0-9]/g, ''));

  // CI renders through SwiftShader (software), which is an order of magnitude
  // slower than a GPU. This asserts the loop is alive and not pathological —
  // it is not a measurement of the 60 fps target, which needs real hardware.
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

  await page.waitForTimeout(800);
  const before = await readZoom(page);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(900);

  const after = await readZoom(page);
  expect(after).toBeGreaterThan(before);
});

test('culls off-screen chunks as it zooms in', async ({ page }) => {
  const box = await page.locator('canvas').boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.waitForTimeout(800);
  const readChunks = async (): Promise<number> =>
    Number((await page.getByTestId('stat-chunks').innerText()).replace(/[^0-9]/g, ''));

  const zoomedOut = await readChunks();

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(900);

  // Zooming in must reduce the number of chunks submitted for drawing, or the
  // culling that makes 5 000 territories affordable is not working.
  expect(await readChunks()).toBeLessThan(zoomedOut);
});

test('selects a territory on click and shows its details', async ({ page }) => {
  await expect(page.getByText('Click a territory to inspect it.')).toBeVisible();

  const box = await page.locator('canvas').boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect(page.getByText('Click a territory to inspect it.')).toBeHidden();
  await expect(page.locator('dt', { hasText: 'Borders' })).toBeVisible();
});

test('generates a different world for a different seed', async ({ page }) => {
  const before = await canvasSignature(page);

  await page.locator('#seed').fill('987654');
  await page.getByRole('button', { name: 'Generate' }).click();
  await waitForFirstFrame(page);
  await page.waitForTimeout(1200);

  expect(await canvasSignature(page)).not.toEqual(before);
});

test('reproduces an identical world for the same seed', async ({ page }) => {
  // The guarantee the whole seed-replication design rests on: the same seed
  // must always rebuild the same map, or clients desync from the server.
  const generate = async (seed: string): Promise<void> => {
    await page.locator('#seed').fill(seed);
    await page.getByRole('button', { name: 'Generate' }).click();
    await waitForFirstFrame(page);
    await page.waitForTimeout(1200);
  };

  await generate('4242');
  const first = await canvasSignature(page);

  await generate('111');
  await generate('4242');
  const second = await canvasSignature(page);

  expect(second).toEqual(first);
});
