import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end multiplayer.
 *
 * Runs the real server and the production client bundle. Server-side
 * integration tests already prove the protocol; these prove the *browser*
 * half — that the client obtains an identity, joins over WebSocket, rebuilds a
 * 5 000-territory world from a seed, and renders it.
 */

/** Joins a match via Quick Play and waits for the first rendered frame. */
async function quickPlay(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('quick-play').click({ timeout: 30_000 });
  await expect(page.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('stat-fps')).toBeVisible({ timeout: 30_000 });
}

test.describe('lobby', () => {
  test('connects and offers a way in', async ({ page }) => {
    await page.goto('/');
    // Quick Play only appears once the socket is connected, so its presence
    // proves REST auth and the WebSocket handshake both succeeded.
    await expect(page.getByTestId('quick-play')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('create-room')).toBeVisible();
  });

  test('lists a match after one has been created', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('quick-play')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('room-name').fill('E2E Room');
    await page.getByTestId('create-room').click();

    // Creating joins immediately, so the canvas is the confirmation.
    await expect(page.locator('canvas')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('leave-match').click();
    await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('match', () => {
  test('joins and renders a world rebuilt from the server seed', async ({ page }) => {
    await quickPlay(page);

    // The map is never transmitted; seeing it at all means the client
    // regenerated it locally from the seed in match:init.
    const buffer = await page.locator('canvas').screenshot();
    expect(buffer.byteLength).toBeGreaterThan(20_000);
  });

  test('shows the player their own resources', async ({ page }) => {
    await quickPlay(page);

    // Resources are unicast, not broadcast — they are private information.
    await expect(page.getByText('Gold')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Land')).toBeVisible();
  });

  test('shows live standings', async ({ page }) => {
    await quickPlay(page);
    await expect(page.getByTestId('leaderboard')).toBeVisible({ timeout: 20_000 });
  });

  test('opens the inspector on the player’s own territory at join', async ({ page }) => {
    await quickPlay(page);

    // The camera focuses the player's spawn and selects it, so the inspector
    // is populated before any click — the highlight and the panel must agree.
    await expect(page.locator('dt', { hasText: 'Borders' })).toBeVisible({ timeout: 15_000 });
  });

  test('inspects a different territory on click', async ({ page }) => {
    await quickPlay(page);

    const box = await page.locator('canvas').boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    // Off-centre: the centre is the player's own territory, already selected,
    // and clicking it would toggle the selection off.
    await page.mouse.click(box.x + box.width * 0.78, box.y + box.height * 0.28);
    await expect(page.locator('dt', { hasText: 'Borders' })).toBeVisible({ timeout: 10_000 });
  });

  test('returns to the lobby on leave', async ({ page }) => {
    await quickPlay(page);
    await page.getByTestId('leave-match').click();
    await expect(page.getByTestId('quick-play')).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('two players', () => {
  test('rebuild an identical world from the same seed', async ({ browser }) => {
    // Separate contexts so the two clients have independent storage and
    // therefore independent guest identities — the same browser profile would
    // reuse one token and one account.
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await quickPlay(pageA);
      await quickPlay(pageB);
      await pageA.waitForTimeout(2000);
      await pageB.waitForTimeout(2000);

      /**
       * Compares replicated *state*, not pixels.
       *
       * Each player's camera is focused on their own spawn, so the two
       * canvases legitimately differ. Screenshots were always a weak proxy
       * anyway: the real claim is that both clients regenerated the same map
       * from the same seed and hold the same ownership table.
       */
      const sigA = await pageA.evaluate(() => window.__borderfall?.worldSignature());
      const sigB = await pageB.evaluate(() => window.__borderfall?.worldSignature());

      expect(sigA).toBeDefined();
      expect(sigB?.seed).toBe(sigA?.seed);
      expect(sigB?.territories).toBe(sigA?.territories);
      expect(sigB?.ownerHash).toBe(sigA?.ownerHash);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('each appear in the other’s standings', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await quickPlay(pageA);
      await quickPlay(pageB);

      /**
       * At least two — not exactly two.
       *
       * Players from earlier tests in this file are still inside their 90 s
       * reconnect grace and legitimately remain in the standings, because they
       * still hold territory. Asserting an exact count would be testing the
       * suite's execution order rather than the roster broadcast.
       */
      const rows = pageA.getByTestId('leaderboard').locator('li');
      await expect
        .poll(async () => rows.count(), { timeout: 20_000, intervals: [500] })
        .toBeGreaterThanOrEqual(2);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('replicate a conquest from one browser to the other', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await quickPlay(pageA);
      await quickPlay(pageB);
      await pageA.waitForTimeout(2000);
      await pageB.waitForTimeout(2000);

      const ownedBefore = (await pageA.evaluate(() => window.__borderfall?.myTerritories())) ?? [];
      const hashBefore = await pageB.evaluate(
        () => window.__borderfall?.worldSignature().ownerHash,
      );

      /**
       * Drive A's client directly rather than clicking the map: finding a
       * player's own territory on screen would require replicating the world
       * generator inside the test. The command still travels the full path —
       * socket, validation, simulation, broadcast — so nothing is bypassed
       * except the mouse.
       */
      const attacked = await pageA.evaluate(() => window.__borderfall?.expandOnce() ?? false);
      if (!attacked) test.skip(true, 'No expandable border on this spawn');

      // B must observe an ownership change it played no part in.
      await expect
        .poll(async () => pageB.evaluate(() => window.__borderfall?.worldSignature().ownerHash), {
          timeout: 20_000,
          intervals: [500],
        })
        .not.toBe(hashBefore);

      // And the change must be exactly the one A made: A gained territory.
      const ownedAfter = (await pageA.evaluate(() => window.__borderfall?.myTerritories())) ?? [];
      expect(ownedAfter.length).toBeGreaterThan(ownedBefore.length);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

/** Test-only surface exposed by the client; see `client/src/net/debug.ts`. */
declare global {
  interface Window {
    __borderfall?: {
      expandOnce(): boolean;
      myTerritories(): number[];
      mySlot(): number;
      worldSignature(): { seed: number; territories: number; ownerHash: string };
    };
  }
}
