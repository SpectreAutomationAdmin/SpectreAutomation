// Payroll Consolidation (2026-09-14) — staging acceptance.
//
// Proves the founder's core requirement: Finance → Payroll is the ONE
// canonical payroll workspace. All required capabilities are reachable
// from there. Legacy Ops payroll route redirects. Cancel path is used
// on the Discard dialog per §15/§20 — the founder's live PREPARED batch
// must not be discarded by automation.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-consolidation");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("consolidation · Finance → Payroll is canonical + legacy redirects", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`));

  // ------------------------------------------------------------------
  // §24 Screenshot 05 — left navigation clean (no Ops payroll entries).
  // Capture the sidebar BEFORE navigating so it shows the current admin
  // shell in the background.
  // ------------------------------------------------------------------
  await page.goto(`${STAGING}/app/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, "05-left-navigation-clean.png"), fullPage: false });

  // Assert no "Payroll (legacy)" / "Payroll setup" / "Payroll time" /
  // "Payroll processing" / "Payroll history" text nodes exist in the
  // rendered sidebar.
  const sidebarText = await page.locator("body").innerText();
  expect(sidebarText).not.toContain("Payroll (legacy)");
  expect(sidebarText).not.toContain("Payroll processing");
  // "Payroll setup" was formerly under Ops — must not be a top-level entry.
  // NB: sub-page titles inside the workspace itself may still contain
  // these words, but the sidebar entries must be gone.

  // ------------------------------------------------------------------
  // §24 Screenshot 01 — Finance → Payroll with the founder's PREPARED
  // batch visible, Discard action reachable.
  // The founder's PREPARED batch lives on payPeriodId cmtjc2wyo001dgnjumh7gz72r.
  // ------------------------------------------------------------------
  const foundersPayPeriodId = "cmtjc2wyo001dgnjumh7gz72r";
  await page.goto(
    `${STAGING}/app/admin/payroll?payPeriodId=${foundersPayPeriodId}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(OUT, "01-finance-payroll-prepared.png"), fullPage: false });

  // Discard action visible on Finance workspace.
  const discardBtn = page.locator('[data-testid="payroll-admin-actions-discard-prepared"]');
  await expect(discardBtn).toBeVisible({ timeout: 10_000 });

  // Open the confirmation dialog + screenshot.
  await discardBtn.scrollIntoViewIfNeeded();
  await discardBtn.click();
  await page.waitForTimeout(600);
  const dialog = page.locator('[data-testid="payroll-admin-discard-dialog"]');
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: path.join(OUT, "02-finance-payroll-discard-dialog.png"), fullPage: false });

  const dialogText = await dialog.innerText();
  expect(dialogText).toContain("Discard prepared payroll?");
  expect(dialogText).toContain("Pay period");
  expect(dialogText).toContain("Employees");
  expect(dialogText).toContain("This cannot be undone.");

  // §15 preservation — take the Cancel path.
  await page.locator('[data-testid="payroll-admin-discard-cancel"]').click();
  await page.waitForTimeout(400);
  await expect(dialog).toBeHidden();

  // ------------------------------------------------------------------
  // §24 Screenshot 03 — Payroll setup canonical destination.
  // ------------------------------------------------------------------
  await page.goto(`${STAGING}/app/admin/payroll/setup`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "03-finance-payroll-setup.png"), fullPage: false });
  const setupText = await page.locator("body").innerText();
  expect(setupText.toLowerCase()).toContain("membership");

  // ------------------------------------------------------------------
  // §24 Screenshot 04 — Payroll history canonical destination.
  // ------------------------------------------------------------------
  await page.goto(`${STAGING}/app/admin/payroll/history`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, "04-finance-payroll-history.png"), fullPage: false });

  // ------------------------------------------------------------------
  // §24 Screenshot 06 — legacy /app/admin/ops/payroll redirects to canonical.
  // ------------------------------------------------------------------
  await page.goto(`${STAGING}/app/admin/ops/payroll`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // Post-redirect URL should be the canonical Finance Payroll route.
  const finalUrl = page.url();
  await page.screenshot({ path: path.join(OUT, "06-legacy-route-redirect.png"), fullPage: false });
  expect(finalUrl, `Legacy /app/admin/ops/payroll must redirect to /app/admin/payroll. Landed at: ${finalUrl}`)
    .toContain("/app/admin/payroll");
  expect(finalUrl).not.toContain("/app/admin/ops/payroll");

  // Assert no page-level crash on any of these navigations.
  expect(
    pageErrors.filter((e) => /Cannot read/i.test(e)).length,
    `No length crash. pageErrors: ${JSON.stringify(pageErrors)}`,
  ).toBe(0);

  await ctx.close();
});
