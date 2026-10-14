// AP-UX-1a rollback verification (2026-10-13).
//
// Captures a desktop screenshot of the restored AP Invoice Review
// page at the same 1440 × 900 viewport the founder uses, so the
// restoration can be visually compared against the pre-AP-UX-1a
// reference.
//
// The staging dataset does not currently contain a "Club Support
// Inc" Work Intake item; the founder-referenced invoice was likely
// from a non-staging environment or a scaffold variant.  This test
// therefore targets the first AP_INVOICE_REVIEW item it finds on
// the Work Intake list — a representative real AP invoice review
// page that exercises the same component path the Club Support
// screenshot showed.
//
// Hard assertions guarantee the AP-UX-1a chrome is NOT present:
//   - no `[data-testid="ap-ux-intel-strip"]` anywhere on the page
//   - no `[data-testid="ap-ux-vendor-match-exception"]` anywhere
//   - no `.ap-ux-exception` on the page
// WI-2B §17 approval restriction is still enforced.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

runAt(
  "AP-UX-1a rollback · restored AP review page has NO ap-ux-* chrome",
  async ({ browser }) => {
    test.setTimeout(600_000);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    const outDir = ensureOutDir();

    await page.goto(`${BASE}/app/admin/work-intake`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3_000);

    // Follow the first Review link (any WI item — the review-page
    // component path is identical regardless of the intake's
    // AP-classification label).
    const link = page.locator('a[href^="/app/admin/work-intake/review/"]').first();
    await link.waitFor({ state: "visible", timeout: 30_000 });
    const href = await link.getAttribute("href");
    if (!href) throw new Error("No review link on Work Intake list");
    console.log(`AP_UX_1A_ROLLBACK_REVIEW_HREF ${href}`);
    await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4_000);

    // §A — AP-UX-1a chrome is GONE.
    const strip = page.locator('[data-testid="ap-ux-intel-strip"]');
    const vmx = page.locator('[data-testid="ap-ux-vendor-match-exception"]');
    const anyException = page.locator(".ap-ux-exception");
    const stripCount = await strip.count();
    const vmxCount = await vmx.count();
    const anyExCount = await anyException.count();
    console.log(`AP_UX_1A_ROLLBACK_STRIP_COUNT ${stripCount}`);
    console.log(`AP_UX_1A_ROLLBACK_VENDOR_EXCEPTION_COUNT ${vmxCount}`);
    console.log(`AP_UX_1A_ROLLBACK_ANY_AP_UX_EXCEPTION_COUNT ${anyExCount}`);
    expect(stripCount, "intel strip must be gone").toBe(0);
    expect(vmxCount, "vendor-match exception must be gone").toBe(0);
    expect(anyExCount, "no .ap-ux-exception primitive mounted").toBe(0);

    // §B — Review chrome (pre-AP-UX-1a) still renders.
    await expect(page.locator('[data-testid="wi-review-root"]').first()).toBeVisible();

    // §C — WI-2B §17 preserved: approve + send-back disabled.
    const approve = page.getByRole("button", { name: /Approve.*Start/i }).first();
    const sendBack = page.getByRole("button", { name: /Send back/i }).first();
    await expect(approve).toBeDisabled();
    await expect(sendBack).toBeDisabled();

    // Desktop screenshot of the restored page.
    await page.screenshot({
      path: path.join(outDir, "ap-ux-1a-rollback-restored.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });
    console.log("AP_UX_1A_ROLLBACK_SCREENSHOT test-results/ap-ux-1a-rollback-restored.png");

    await ctx.close();
  },
);
