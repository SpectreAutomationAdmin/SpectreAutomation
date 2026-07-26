import { test, expect, type Page } from "@playwright/test";

// Step 42 — browser-driven regression for the floor-plan editor.
//
// The drag visual is now a floating HTML ghost (position:fixed at
// viewport level). The original SVG <g> stays put (dimmed) during
// drag; only the ghost follows the cursor. On pointerup the editor
// converts the final cursor position to canvas coords, clamps,
// snaps, and commits via the existing pendingMoves overlay.
//
// The dev server must be running on http://localhost:3000 BEFORE
// this test runs:
//   npm run dev            # in one terminal
//   npm run test:e2e       # in another

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

async function openLoungeDraft(page: Page, opts?: { debug?: boolean }) {
  page.on("dialog", (d) => d.accept().catch(() => {}));
  const url = opts?.debug
    ? "/app/admin/ops/floor-plans?debug=1"
    : "/app/admin/ops/floor-plans";
  await page.goto(url);

  const discardBtn = page.getByRole("button", { name: "Discard draft" });
  if (await discardBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await discardBtn.click();
    await expect(
      page.getByRole("button", { name: "Start a draft" }),
    ).toBeVisible({ timeout: 10_000 });
  }

  const startBtn = page.getByRole("button", { name: "Start a draft" });
  if (await startBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await startBtn.click();
    await expect(page.getByTestId("publish-button")).toBeVisible({ timeout: 10_000 });
  }
}

test.describe("Floor-plan editor — floating-ghost drag (step 42)", () => {
  // Step 42 — the principal acceptance test. The floating HTML ghost
  // must stay centered on the cursor at every sampled point.
  test("floating ghost: ghost center stays within 2px of cursor throughout drag", async ({ page }) => {
    await login(page);
    await openLoungeDraft(page);

    const tile = page.getByTestId("floor-plan-tile-L1");
    await expect(tile).toBeVisible({ timeout: 10_000 });
    const shape = tile.locator("ellipse, rect").first();
    await expect(shape).toBeVisible();

    const shapeBox = await shape.boundingBox();
    if (!shapeBox) throw new Error("Shape bbox unavailable");
    // Grab inside the painted fill (for ROUND tiles the <g> bbox
    // corner is outside the ellipse, no pointer events fire there).
    const grabX = shapeBox.x + shapeBox.width * 0.15;
    const grabY = shapeBox.y + shapeBox.height * 0.5;

    await page.mouse.move(grabX, grabY);
    await page.mouse.down();

    // The floating ghost must appear on pointerdown.
    const ghost = page.getByTestId("floor-plan-floating-drag-ghost");
    await expect(ghost).toBeVisible({ timeout: 2_000 });

    const samples: Array<{ cursor: [number, number]; ghost: [number, number]; distance: number }> = [];
    const path: Array<[number, number]> = [
      [grabX + 30, grabY],
      [grabX + 60, grabY + 20],
      [grabX + 90, grabY + 40],
      [grabX + 60, grabY + 60],
      [grabX + 30, grabY + 80],
      [grabX, grabY + 60],
      [grabX - 40, grabY + 30],
      [grabX - 80, grabY - 30],
    ];
    for (const [cx, cy] of path) {
      await page.mouse.move(cx, cy, { steps: 2 });
      await page.waitForTimeout(30);
      const box = await ghost.boundingBox();
      if (!box) throw new Error("Ghost bbox unavailable mid-drag");
      const ghostCx = box.x + box.width / 2;
      const ghostCy = box.y + box.height / 2;
      const distance = Math.hypot(cx - ghostCx, cy - ghostCy);
      samples.push({ cursor: [cx, cy], ghost: [ghostCx, ghostCy], distance });
    }

    await page.screenshot({
      path: "test-results/floor-plan-floating-ghost.png",
      fullPage: true,
    });

    await page.mouse.up();

    await expect(ghost).toHaveCount(0, { timeout: 2_000 });

    const distances = samples.map((s) => s.distance);
    const maxDist = Math.max(...distances);
    const avgDist = distances.reduce((a, b) => a + b, 0) / distances.length;

    test.info().annotations.push({
      type: "floating-ghost-measurement",
      description: `samples=${samples.length} max=${maxDist.toFixed(2)}px avg=${avgDist.toFixed(2)}px`,
    });

    for (const s of samples) {
      expect(
        s.distance,
        `cursor (${s.cursor[0].toFixed(1)}, ${s.cursor[1].toFixed(1)}) vs ghost center (${s.ghost[0].toFixed(1)}, ${s.ghost[1].toFixed(1)}) — distance ${s.distance.toFixed(2)}px must be <= 2px`,
      ).toBeLessThanOrEqual(2);
    }
    expect(maxDist, "max cursor-to-ghost-center distance must be <= 2px").toBeLessThanOrEqual(2);
  });

  // Step 42 — the SVG tile must dim while the ghost is in flight.
  test("floating ghost: original SVG tile is dimmed during drag", async ({ page }) => {
    await login(page);
    await openLoungeDraft(page);

    const tile = page.getByTestId("floor-plan-tile-L1");
    await expect(tile).toBeVisible();
    const shape = tile.locator("ellipse, rect").first();
    const shapeBox = await shape.boundingBox();
    if (!shapeBox) throw new Error("Shape bbox unavailable");
    const grabX = shapeBox.x + shapeBox.width * 0.15;
    const grabY = shapeBox.y + shapeBox.height * 0.5;

    // Pre-drag the tile is fully opaque.
    const opacityBefore = await tile.getAttribute("opacity");
    expect(opacityBefore == null || opacityBefore === "1").toBeTruthy();

    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.waitForTimeout(50);

    const opacityMid = await tile.getAttribute("opacity");
    expect(parseFloat(opacityMid ?? "1"), "SVG tile must be dimmed during drag").toBeLessThan(1);

    await page.mouse.up();
    // Wait long enough for the save round-trip + reconciliation effect
    // so the saving cue (opacity 0.8) clears back to fully opaque.
    await page.waitForTimeout(2000);

    const opacityAfter = await tile.getAttribute("opacity");
    expect(parseFloat(opacityAfter ?? "1"), "SVG tile fully opaque after save lands").toBe(1);
  });

  // Step 42 — release outside the canvas: tile clamps to nearest legal
  // position inside the canvas. Verified by reading data-x/data-y
  // (the rendered optimistic coord) after release.
  test("floating ghost: release outside canvas clamps to nearest legal position", async ({ page }) => {
    await login(page);
    await openLoungeDraft(page);

    const canvas = page
      .getByTestId("floor-plan-preview")
      .locator("svg[viewBox]")
      .first();
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("Canvas bbox unavailable");

    const tile = page.getByTestId("floor-plan-tile-L1");
    const shape = tile.locator("ellipse, rect").first();
    const shapeBox = await shape.boundingBox();
    if (!shapeBox) throw new Error("Shape bbox unavailable");
    const grabX = shapeBox.x + shapeBox.width / 2;
    const grabY = shapeBox.y + shapeBox.height / 2;

    await page.mouse.move(grabX, grabY);
    await page.mouse.down();

    // Drag well past the right edge of the canvas.
    const targetX = canvasBox.x + canvasBox.width + 200;
    const targetY = grabY;
    await page.mouse.move(targetX, targetY, { steps: 10 });
    await page.mouse.up();

    // After release the rendered tile center must be inside the canvas.
    await page.waitForTimeout(300);
    const dataX = await tile.getAttribute("data-x");
    expect(dataX, "data-x must be present").toBeTruthy();
    const x = parseFloat(dataX!);
    // Canvas viewBox is 1000 wide. L1's width is 80, so half-width
    // is 40, max legal center is 960. We dropped way past the edge
    // so we expect ~960 (snapped to nearest 10).
    expect(x).toBeGreaterThanOrEqual(40);
    expect(x).toBeLessThanOrEqual(960);
  });

  // Step 42 — debug HUD renders when ?debug=1, hidden otherwise.
  test("debug HUD: shows cursor + ghost + distance when ?debug=1", async ({ page }) => {
    await login(page);
    await openLoungeDraft(page, { debug: true });

    const tile = page.getByTestId("floor-plan-tile-L1");
    await expect(tile).toBeVisible({ timeout: 10_000 });
    const shape = tile.locator("ellipse, rect").first();
    const shapeBox = await shape.boundingBox();
    if (!shapeBox) throw new Error("Shape bbox unavailable");
    const grabX = shapeBox.x + shapeBox.width / 2;
    const grabY = shapeBox.y + shapeBox.height / 2;

    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(grabX + 80, grabY + 30, { steps: 4 });
    await page.waitForTimeout(50);

    const hud = page.getByTestId("floor-plan-debug-hud");
    await expect(hud).toBeVisible({ timeout: 2_000 });
    const distAttr = await hud.getAttribute("data-distance");
    expect(distAttr).toBeTruthy();
    const distance = parseFloat(distAttr!);
    expect(distance, "debug HUD distance must be <= 2px during drag").toBeLessThanOrEqual(2);

    await page.mouse.up();
  });

  // Step 39 — keyboard delete removes the selected table.
  test("keyboard delete: select a clean tile and press Delete to remove it", async ({ page }) => {
    await login(page);
    await openLoungeDraft(page);

    const tile = page.getByTestId("floor-plan-tile-L2");
    await expect(tile).toBeVisible({ timeout: 10_000 });
    await tile.click();
    await page.waitForTimeout(150);

    await page.keyboard.press("Delete");

    await expect(
      tile,
      "L2 must be removed after Delete (clean tile, no archive blockers)",
    ).toHaveCount(0, { timeout: 10_000 });
  });

  // Step 39 — archive blocker prevents removing a SEATED tile.
  test("keyboard delete: archive blocker prevents removing a SEATED tile", async ({ page }) => {
    await login(page);
    await openLoungeDraft(page);

    const tile = page.getByTestId("floor-plan-tile-L1");
    await expect(tile).toBeVisible();
    await tile.click();
    await page.waitForTimeout(150);

    await page.keyboard.press("Delete");

    await page.waitForTimeout(1500);
    await expect(tile, "L1 must remain (SEATED blocker)").toHaveCount(1);
  });

  // Step 39 — typing in an input must NOT trigger delete.
  test("keyboard delete: typing in an input does NOT delete the selected tile", async ({ page }) => {
    await login(page);
    await openLoungeDraft(page);

    const tile = page
      .locator('[data-testid^="floor-plan-tile-"]:not([data-testid^="floor-plan-tile-ghost-"])')
      .first();
    const testId = await tile.getAttribute("data-testid");
    await tile.click();

    await tile.dblclick();
    const modal = page.getByTestId("edit-table-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const input = modal.locator(".input").first();
    await input.click();
    await input.press("Backspace");

    await expect(page.locator(`[data-testid="${testId}"]`)).toHaveCount(1);

    await modal.getByRole("button", { name: "Cancel" }).click();
  });
});
