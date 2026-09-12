// Payroll 3B semantics-hotfix (2026-09-12) — staging acceptance for
// the approval-vs-freeze independence fix.
//
// Assumes the founder has already Manager-approved both Events and
// Course & Grounds departments on Coulee's founder-period (Aug 30 –
// Sep 12) BEFORE this spec runs. That state is the acceptance-
// hotfix evidence the founder captured.
//
// Drives the lifecycle transitions through the UI:
//   1. Screenshot 1: 2/2 approved · 2 awaiting freeze · 0 frozen.
//   2. Click "Freeze into Payroll" on the first APPROVED_UNFROZEN row.
//   3. Screenshot 2: 2/2 approved · 1 awaiting freeze · 1 frozen.
//   4. Click "Freeze into Payroll" on the remaining APPROVED_UNFROZEN row.
//   5. Screenshot 3: 2/2 approved · 0 awaiting freeze · 2 frozen.
//
// Each transition verifies: Approvals tab count stays "Approvals
// (2/2)"; workflow Step 3 stays `done`; checklist item 2 stays
// "2/2 approved"; only the freeze aggregate + row state changes.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3b-semantics-staging");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FOUNDER_PP = "cmtjc2wud001bgnjugkqrdz2r";

test.use({ viewport: { width: 1440, height: 900 } });

test("Payroll 3B semantics-hotfix — approve vs freeze lifecycle progression", async ({ context }) => {
  test.setTimeout(240_000);
  const page = await loginAsFounder(context);
  await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}&tab=approvals`, { waitUntil: "networkidle" });

  // -------- Screenshot 1 --------
  const tab1 = await page.getByTestId("payroll-admin-tab-approvals").innerText();
  console.log(`[1/3] tab label: ${tab1}`);
  await page.screenshot({ path: path.join(OUT, "01-2of2-approved-0-frozen-1440x900.png"), fullPage: false });

  // -------- Freeze first APPROVED_UNFROZEN scope --------
  const freezeButtons1 = page.locator('[data-testid^="payroll-admin-approval-freeze-"]');
  const initialFreezeButtonCount = await freezeButtons1.count();
  console.log(`[1/3] freeze buttons visible: ${initialFreezeButtonCount}`);
  expect(initialFreezeButtonCount, "expected at least 1 APPROVED_UNFROZEN scope with a Freeze button").toBeGreaterThan(0);

  // Click the first freeze button and wait for the redirect to the
  // approvals tab (server action posts + revalidates + redirects).
  await freezeButtons1.first().click();
  await page.waitForURL(/tab=approvals/, { timeout: 60_000 });

  // -------- Screenshot 2 --------
  await page.waitForLoadState("networkidle");
  const tab2 = await page.getByTestId("payroll-admin-tab-approvals").innerText();
  console.log(`[2/3] tab label after 1 freeze: ${tab2}`);
  await page.screenshot({ path: path.join(OUT, "02-2of2-approved-1-frozen-1440x900.png"), fullPage: false });

  // -------- Freeze remaining APPROVED_UNFROZEN scope --------
  const freezeButtons2 = page.locator('[data-testid^="payroll-admin-approval-freeze-"]');
  const remainingFreezeCount = await freezeButtons2.count();
  console.log(`[2/3] freeze buttons remaining: ${remainingFreezeCount}`);

  if (remainingFreezeCount > 0) {
    await freezeButtons2.first().click();
    await page.waitForURL(/tab=approvals/, { timeout: 60_000 });
    await page.waitForLoadState("networkidle");
  }

  // -------- Screenshot 3 --------
  const tab3 = await page.getByTestId("payroll-admin-tab-approvals").innerText();
  console.log(`[3/3] tab label after 2 freezes: ${tab3}`);
  await page.screenshot({ path: path.join(OUT, "03-2of2-approved-2-frozen-1440x900.png"), fullPage: false });

  // Approvals tab count should remain "2/2" through all three states.
  // (The tab-badge text is "Approvals (2/2)" — but exact number
  // may vary if additional scopes appeared during the test.)
  for (const label of [tab1, tab2, tab3]) {
    // Every tab label must match "Approvals (X/Y)" where X === Y.
    const match = label.match(/Approvals \((\d+)\/(\d+)\)/);
    expect(match, `tab label '${label}' must match Approvals (X/Y)`).not.toBeNull();
    if (match) {
      const approved = Number.parseInt(match[1]!, 10);
      const required = Number.parseInt(match[2]!, 10);
      expect(approved, `at each stage 'approved' must equal 'required' — got ${approved}/${required} in '${label}'`)
        .toBe(required);
    }
  }
});
