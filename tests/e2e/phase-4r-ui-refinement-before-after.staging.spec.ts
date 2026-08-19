// Phase 4R · UI-Refinement (2026-08-15) — before/after visual capture
// for the sidebar identity + header hierarchy + card id-tag removal.
//
// Runs against staging v218 (BEFORE) and again after the deploy that
// carries the UI changes (AFTER). Read-only.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT_DIR = process.env.SPECTRE_UI_REFINEMENT_OUT ??
  "test-results/phase-4r-ui-refinement/before";
fs.mkdirSync(OUT_DIR, { recursive: true });

test.describe("Phase 4R · UI refinement — screenshot capture", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("Mission Control full-page + sidebar-crop + card-crop", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    // Full-page capture
    await page.screenshot({
      path: path.join(OUT_DIR, "01-mission-control-full.png"),
      fullPage: true,
    });

    // Sidebar crop (upper-left identity area)
    const sidebar = page.locator("aside").first();
    if (await sidebar.count()) {
      await sidebar.screenshot({ path: path.join(OUT_DIR, "02-sidebar.png") });
    }

    // Top bar crop
    const topbar = page.locator('[data-testid="spectre-topbar"]').first();
    if (await topbar.count()) {
      await topbar.screenshot({ path: path.join(OUT_DIR, "03-topbar.png") });
    }

    // First AP card (id-tag exposure evidence)
    const firstCard = page.locator('.spectre-mc-item').first();
    if (await firstCard.count()) {
      await firstCard.scrollIntoViewIfNeeded();
      await firstCard.screenshot({ path: path.join(OUT_DIR, "04-first-card.png") });
    }

    // Completed history
    await page.goto(`${avail.baseURL}/app/admin?view=history`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: path.join(OUT_DIR, "05-completed-history-full.png"),
      fullPage: true,
    });
    const firstHistoryCard = page.locator('.spectre-mc-item').first();
    if (await firstHistoryCard.count()) {
      await firstHistoryCard.scrollIntoViewIfNeeded();
      await firstHistoryCard.screenshot({ path: path.join(OUT_DIR, "06-first-history-card.png") });
    }

    // Two other Spectre pages — breadcrumb regression check
    for (const route of [
      { slug: "members", url: "/app/admin/members" },
      { slug: "reporting-monthly", url: "/app/admin/reporting/monthly" },
    ]) {
      await page.goto(`${avail.baseURL}${route.url}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1000);
      const tb = page.locator('[data-testid="spectre-topbar"]').first();
      if (await tb.count()) {
        await tb.screenshot({ path: path.join(OUT_DIR, `07-topbar-${route.slug}.png`) });
      }
      await page.screenshot({ path: path.join(OUT_DIR, `08-${route.slug}-full.png`), fullPage: true });
    }

    await ctx.close();
  });
});
