// Payroll 3A date-fix — capture the founder's target period at
// 1440x900 to prove header, selector, and Pay Period Information card
// all display the same calendar dates (Aug 30 – Sep 12, Pay Sep 12).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3a-staging");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FOUNDER_PP = "cmtjc2wud001bgnjugkqrdz2r"; // Aug 30 – Sep 12

test.use({ viewport: { width: 1440, height: 900 } });

test("Founder period Aug 30 – Sep 12: all date surfaces agree", async ({ context }) => {
  test.setTimeout(180_000);
  const page = await loginAsFounder(context);
  await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });

  await expect(page.getByTestId("payroll-admin-header")).toBeVisible();

  // Header period + pay-date line
  const periodLine = await page.getByTestId("payroll-admin-period-line").innerText();
  const payDateLine = await page.getByTestId("payroll-admin-pay-date-line").innerText();
  const selectorLabel = await page.getByTestId("payroll-admin-change-period").locator(`option[value="${FOUNDER_PP}"]`).innerText();
  const payPeriodCard = await page.getByTestId("payroll-admin-pay-period").innerText();

  console.log("[dates]");
  console.log("  header period :", periodLine);
  console.log("  header payDate:", payDateLine);
  console.log("  selector      :", selectorLabel);
  console.log("  card          :", payPeriodCard.replace(/\n+/g, " | "));

  // No Aug 29 / Sep 11 drift anywhere.
  const combined = `${periodLine}\n${payDateLine}\n${selectorLabel}\n${payPeriodCard}`;
  expect(combined, `Aug 29 drift found: ${combined}`).not.toMatch(/Aug 29|Fri, Sep 11/);
  // Positive: Aug 30 + Sep 12 present.
  expect(periodLine).toContain("Aug 30");
  expect(periodLine).toContain("Sep 12");
  expect(payDateLine).toContain("Sep 12");
  expect(selectorLabel).toContain("Aug 30");
  expect(selectorLabel).toContain("Sep 12");
  expect(payPeriodCard).toContain("Aug 30");
  expect(payPeriodCard).toContain("Sep 12");

  await page.screenshot({ path: path.join(OUT, "staging-payroll-founder-period-1440x900.png"), fullPage: false });

  // Founder period may now be prepared (as of 3B acceptance). The
  // date-boundary regression this test guards is independent of
  // whether Prepare has been clicked — the header/selector/card
  // date agreement above is the only assertion that matters here.
  // Empty-state and Prepare button visibility are conditional.
  const emptyState = page.getByTestId("payroll-admin-employee-empty");
  const emptyStateCount = await emptyState.count();
  if (emptyStateCount > 0) await expect(emptyState).toBeVisible();
  const prepare = page.getByTestId("payroll-admin-prepare");
  const prepareCount = await prepare.count();
  if (prepareCount > 0) await expect(prepare).toBeVisible();
});
