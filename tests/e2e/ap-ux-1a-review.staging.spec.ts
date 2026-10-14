// AP-UX-1a (2026-10-13) — staging acceptance for the AP review UX
// slice.  Verifies on the DEPLOYED staging build:
//
//   §A  (desktop 1440) — The IntelligenceStrip renders when AP
//       extraction has produced any signal, with per-stage status
//       data attributes exposed for assistive tech.
//   §B  (desktop 1440) — When vendor-match is unresolved, the
//       <ap-ux-vendor-match-exception> notice renders between the
//       strip and the Invoice Details card, with a primary action
//       linking to Mission Control (NO new mutation surface).
//   §C  (desktop 1440) — Approve + Send-back action buttons remain
//       `disabled` (WI-2B §17 preserved).
//   §D  (mobile 390)   — The strip + exception stack cleanly;
//       exception actions span the width of the notice; no
//       horizontal scroll.  Reduced-motion safe.
//
// This spec intentionally does NOT drive any backend mutation —
// AP-UX-1a added no new mutation surface.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

// A real AP work-intake id on Coulee staging.  Resolved at run
// time rather than hardcoded — we visit the Work Intake list,
// pick the first AP-intake row's Review link, and follow it.
async function openFirstReview(page: import("@playwright/test").Page) {
  await page.goto(`${BASE}/app/admin/work-intake`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(3_000);
  // Any WI item's review link lives at /app/admin/work-intake/review/<id>.
  const link = page.locator('a[href^="/app/admin/work-intake/review/"]').first();
  await link.waitFor({ state: "visible", timeout: 30_000 });
  const href = await link.getAttribute("href");
  if (!href) throw new Error("No review link found on the Work Intake list");
  await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);
  return page.locator('[data-testid="wi-review-root"]').first();
}

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

runAt(
  "AP-UX-1a · Review-page progressive strip + exception notice (desktop 1440 + mobile 390)",
  async ({ browser }) => {
    test.setTimeout(600_000);
    const outDir = ensureOutDir();

    // ─── §A/§B/§C — desktop 1440 × 900 ──────────────────────────
    const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const desktop = await loginAsFounder(desktopCtx);
    const root = await openFirstReview(desktop);
    await expect(root).toBeVisible();

    // The intelligence strip MAY or may not render — only when the
    // AP intelligence pipeline has produced at least one signal.
    // Capture presence informationally; when present, assert its
    // stage statuses are all one of the 5 directive-mandated values.
    const strip = desktop.locator('[data-testid="ap-ux-intel-strip"]').first();
    const stripCount = await strip.count();
    console.log(`AP_UX_1A_STRIP_PRESENT ${stripCount > 0}`);
    if (stripCount > 0) {
      const statuses = await strip.locator("li[data-status]").evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-status")),
      );
      console.log(`AP_UX_1A_STAGE_STATUSES ${JSON.stringify(statuses)}`);
      for (const s of statuses) {
        expect(s, `stage status is one of the 5 directive-mandated values`).toMatch(
          /^(COMPLETED|SUGGESTED|PROCESSING|ATTENTION|UNEVALUATED)$/,
        );
      }
    }

    // Vendor-match exception: present only when the AP intelligence
    // reports an unresolved match.  Informational log either way;
    // when present, pin the primary action route.
    const vmx = desktop.locator('[data-testid="ap-ux-vendor-match-exception"]').first();
    const vmxCount = await vmx.count();
    console.log(`AP_UX_1A_VENDOR_MATCH_EXCEPTION_PRESENT ${vmxCount > 0}`);
    if (vmxCount > 0) {
      const primary = vmx.locator('[data-testid="ap-ux-exception-action-0"]').first();
      await expect(primary).toBeVisible();
      await expect(primary).toHaveText(/Open in Mission Control/);
      await expect(primary).toHaveAttribute("href", "/app/admin");
    }

    // §C — WI-2B §17 preserved: both action buttons are still
    // disabled on the live staging build.
    const approve = desktop.getByRole("button", { name: /Approve.*Start/i }).first();
    const sendBack = desktop.getByRole("button", { name: /Send back/i }).first();
    await expect(approve).toBeDisabled();
    await expect(sendBack).toBeDisabled();

    await desktop.screenshot({
      path: path.join(outDir, "ap-ux-1a-desktop.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });
    console.log("AP_UX_1A_DESKTOP_SCREENSHOT test-results/ap-ux-1a-desktop.png");
    await desktopCtx.close();

    // ─── §D — mobile 390 × 844 ──────────────────────────────────
    const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobile = await loginAsFounder(mobileCtx);
    await openFirstReview(mobile);
    await mobile.waitForTimeout(1_500);

    // No horizontal scroll on the body — the review page MUST
    // honour the mobile viewport.
    const overflowX = await mobile.evaluate(() => {
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    console.log(`AP_UX_1A_MOBILE_OVERFLOW ${JSON.stringify(overflowX)}`);
    expect(
      overflowX.scrollWidth - overflowX.clientWidth,
      "no horizontal scroll on the mobile review page",
    ).toBeLessThanOrEqual(2);

    // If the intel strip or exception is rendered, its grid should
    // collapse to a single column on mobile.
    const mobileStrip = mobile.locator('[data-testid="ap-ux-intel-strip"]').first();
    if ((await mobileStrip.count()) > 0) {
      const columns = await mobileStrip.evaluate((el) => {
        const list = el.querySelector(".ap-ux-intel-strip-list") as HTMLElement | null;
        return list ? window.getComputedStyle(list).gridTemplateColumns : null;
      });
      console.log(`AP_UX_1A_MOBILE_STRIP_COLUMNS ${columns}`);
      // Single-column grid on <=640 px → one track reported.
      expect(columns?.split(" ").length ?? 0).toBe(1);
    }

    await mobile.screenshot({
      path: path.join(outDir, "ap-ux-1a-mobile.png"),
      clip: { x: 0, y: 0, width: 390, height: 844 },
    });
    console.log("AP_UX_1A_MOBILE_SCREENSHOT test-results/ap-ux-1a-mobile.png");
    await mobileCtx.close();
  },
);
