// Payroll Admin Slice 3E acceptance hotfix (2026-09-12) — Controller
// side of the real UI walk. Logs in as the fixture Controller and
// approves the currently-open PAYROLL_FINAL_APPROVAL card through
// the review workspace. No SSH, no DB mutation.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAs } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3e-controller-approve");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const CTRL_EMAIL = "fixture.controller.3e@spectre.test";
const FIXTURE_PW = "spectre-3e-fixture";

test.use({ viewport: { width: 1440, height: 900 } });

test("Payroll 3E — Controller approves through UI", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);

  await page.goto(`${STAGING}/app/admin/payroll/process`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, "01-ctrl-queue-1440x900.png"), fullPage: false });

  const reviewLink = page.locator('a[href*="/app/admin/payroll/batches/"]').first();
  await reviewLink.waitFor({ state: "visible", timeout: 30_000 });
  const href = await reviewLink.getAttribute("href");
  console.log(`[3E-approve] deep-link: ${href}`);
  await reviewLink.click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, "02-ctrl-review-1440x900.png"), fullPage: false });

  const badge = await page.getByTestId("review-lifecycle-badge").innerText().catch(() => "");
  console.log(`[3E-approve] current badge: ${badge}`);

  const sodNotice = page.getByTestId("review-sod-notice");
  expect(await sodNotice.count()).toBe(0);

  const approveBtn = page.getByTestId("review-approve-btn");
  await approveBtn.waitFor({ state: "visible", timeout: 20_000 });
  await approveBtn.click();
  const approveConfirm = page.getByTestId("review-approve-confirm-panel");
  await expect(approveConfirm).toBeVisible();
  await page.screenshot({ path: path.join(OUT, "03-ctrl-approve-confirm-1440x900.png"), fullPage: false });

  await page.getByTestId("review-approve-confirm-btn").click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, "04-ctrl-approved-1440x900.png"), fullPage: false });

  const finalBadge = await page.getByTestId("review-lifecycle-badge").innerText().catch(() => "");
  console.log(`[3E-approve] final badge: ${finalBadge}`);
  expect(finalBadge.toUpperCase()).toContain("APPROVED");
});
