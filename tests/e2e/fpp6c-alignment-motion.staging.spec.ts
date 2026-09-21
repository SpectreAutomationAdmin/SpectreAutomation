// FPP-6C (2026-09-21) — alignment + motion polish acceptance.
//
// Proves:
//   § feed-header controls (View: Active + Completed history) hold
//     the same X position between closed and open state — they no
//     longer slide when the preview enters.
//   § selected work card top edge and preview top edge are aligned
//     to within a couple of pixels — master-detail visual pair.
//   § Review checklist section and Calculation/package provenance
//     footer no longer render in the compact preview.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const OVERVIEW_URL = "/app/admin";
const OPEN_URL = "/app/admin?workItem=cmual5x0x00087hkl20vowupf";

test.describe("FPP-6C alignment + motion", () => {
  test("View / History control X position is stable between closed and open", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    // Closed measurement.
    const closed = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await closed.waitForLoadState("domcontentloaded");
    const closedRects = await closed.evaluate(() => {
      const active = document.querySelector('[data-testid="feed-view-active"]')?.getBoundingClientRect();
      const history = document.querySelector('[data-testid="feed-view-history"]')?.getBoundingClientRect();
      return {
        active: active ? { x: active.x, y: active.y, right: active.right } : null,
        history: history ? { x: history.x, y: history.y, right: history.right } : null,
      };
    });

    // Open measurement — new page in the same context so we can compare
    // without stale layout state.
    const open = await context.newPage();
    await open.goto(`${new URL(closed.url()).origin}${OPEN_URL}`);
    await open.waitForLoadState("domcontentloaded");
    await expect(open.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 15_000 });
    const openRects = await open.evaluate(() => {
      const active = document.querySelector('[data-testid="feed-view-active"]')?.getBoundingClientRect();
      const history = document.querySelector('[data-testid="feed-view-history"]')?.getBoundingClientRect();
      return {
        active: active ? { x: active.x, y: active.y, right: active.right } : null,
        history: history ? { x: history.x, y: history.y, right: history.right } : null,
      };
    });

    console.log("CLOSED controls:", JSON.stringify(closedRects, null, 2));
    console.log("OPEN   controls:", JSON.stringify(openRects, null, 2));

    // Same X, same Y, same right edge — within 1px tolerance for sub-pixel rendering.
    expect(closedRects.active).not.toBeNull();
    expect(openRects.active).not.toBeNull();
    expect(Math.abs(openRects.active!.x - closedRects.active!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(openRects.active!.y - closedRects.active!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(openRects.history!.x - closedRects.history!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(openRects.history!.y - closedRects.history!.y)).toBeLessThanOrEqual(1);
    // history's right edge is the anchor to the feed-head's right edge.
    expect(Math.abs(openRects.history!.right - closedRects.history!.right)).toBeLessThanOrEqual(1);
  });

  test("Selected card top aligns with preview top (master-detail pair)", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 15_000 });

    const rects = await page.evaluate(() => {
      const card = document.querySelector('[data-testid^="payroll-final-approval-card-"]')?.getBoundingClientRect();
      const preview = document.querySelector('[data-testid="payroll-approval-preview"]')?.getBoundingClientRect();
      return {
        card: card ? { top: card.top, height: card.height } : null,
        preview: preview ? { top: preview.top, height: preview.height } : null,
      };
    });
    console.log("CARD/PREVIEW tops:", JSON.stringify(rects, null, 2));
    expect(rects.card).not.toBeNull();
    expect(rects.preview).not.toBeNull();
    // Same top Y within 2px sub-pixel tolerance.
    expect(Math.abs(rects.preview!.top - rects.card!.top)).toBeLessThanOrEqual(2);
  });

  test("Review + provenance sections are removed from the preview", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("preview-review-checks")).toHaveCount(0);
    await expect(page.getByTestId("preview-provenance")).toHaveCount(0);
    // Executive Insight + Full-Review link remain.
    await expect(page.getByTestId("preview-executive-insights")).toBeVisible();
    await expect(page.getByTestId("preview-full-review-link")).toBeVisible();
  });
});
