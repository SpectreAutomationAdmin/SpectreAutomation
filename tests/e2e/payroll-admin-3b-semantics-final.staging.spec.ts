// One-shot screenshot capture of the fully-settled 2/2-approved
// 2/2-frozen state after all freeze mutations have committed.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3b-semantics-staging");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FOUNDER_PP = "cmtjc2wud001bgnjugkqrdz2r";

test.use({ viewport: { width: 1440, height: 900 } });

test("final settled state: 2/2 approved · 2/2 frozen", async ({ context }) => {
  const page = await loginAsFounder(context);
  await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}&tab=approvals`, { waitUntil: "networkidle" });
  // Extra settle so no client-side pending indicators are showing.
  await page.waitForTimeout(1500);
  const tab = await page.getByTestId("payroll-admin-tab-approvals").innerText();
  console.log(`[settled] tab: ${tab}`);
  await page.screenshot({ path: path.join(OUT, "03-final-2of2-approved-2-frozen-settled-1440x900.png"), fullPage: false });
});
