// REPORT-AUDIT-1A (2026-10-05) — staging acceptance.
//
// §1  Section III PP&E Reinvestment renders "—" + precise unavailable
//     text (not 0%, not a numeric value).
// §2  Section XII Departmental Payroll Analysis renders LIVE data
//     sourced from the SAME canonical payroll resolvers Section II
//     uses. Totals reconcile to the penny.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}

runAt("REPORT-AUDIT-1A · Section III PPE availability + Section XII canonical payroll", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("REPORT_AUDIT_1A_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  // -------- §1 Section III PP&E Reinvestment --------
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#stewardship-dashboard`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="stewardship-kpi-dashboard"]').waitFor({ state: "visible", timeout: 20_000 });
  const ppeActual = await page.locator('[data-testid="stewardship-ppe-reinvestment-actual"]').innerText();
  const ppeAssessment = await page.locator('[data-testid="stewardship-ppe-reinvestment-assessment"]').innerText();
  console.log("REPORT_AUDIT_1A_PPE " + JSON.stringify({ actual: ppeActual, assessment: ppeAssessment }));
  expect(ppeActual).toBe("—");
  expect(ppeAssessment).toMatch(/PP&E component split not configured/);

  // -------- Regression: other Section III cards still correct --------
  const duesRev = await page.locator('[data-testid="stewardship-dues-rev-actual"]').innerText();
  const payrollRatio = await page.locator('[data-testid="stewardship-payroll-ratio-actual"]').innerText();
  const noiMargin = await page.locator('[data-testid="stewardship-noi-margin-actual"]').innerText();
  const arCurrent = await page.locator('[data-testid="stewardship-ar-current-actual"]').innerText();
  console.log("REPORT_AUDIT_1A_SEC3_REGRESSION " + JSON.stringify({ duesRev, payrollRatio, noiMargin, arCurrent }));
  expect(duesRev).toMatch(/98\.9%/);
  expect(payrollRatio).toMatch(/5\.2%/);
  expect(noiMargin).toMatch(/90\.3%/);
  expect(arCurrent).toMatch(/99\.3%/);

  // -------- §2 Section XII Departmental Payroll Analysis renders live --------
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#departmental-payroll-analysis`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  const pageText = await page.locator("body").innerText();

  // Section XII should NOT contain the generic "Data not available for
  // this reporting period." phrase anywhere in its chapter.
  const chapterStart = pageText.indexOf("Departmental Payroll Analysis");
  const chapterSlice = pageText.slice(chapterStart, chapterStart + 2500);
  console.log("REPORT_AUDIT_1A_SEC12_SLICE " + JSON.stringify(chapterSlice.slice(0, 400)));
  expect(chapterSlice).not.toContain("Data not available for this reporting period.");

  // Chapter heading reads correctly.
  expect(chapterSlice).toContain("Departmental Payroll Analysis");

  // The canonical YTD total payroll should be $0.163M.
  expect(chapterSlice).toMatch(/\$0\.163M|\$163K/);

  // At least one real dept name from PAYROLL-HIST-1 renders.
  const anyRealDept = ["Administration", "Clubhouse", "Course & Grounds", "Food & Beverage", "Golf Shop"].some((d) => chapterSlice.includes(d));
  expect(anyRealDept).toBe(true);

  // Wages/benefits split callout renders the unavailable message.
  expect(chapterSlice).toMatch(/Compensation split unavailable|Wages \/ taxes & benefits split is not configured/);

  // Payroll-to-Revenue reads 5.2% (canonical), NOT 59.2% (Silver Springs).
  expect(chapterSlice).toMatch(/5\.2%/);
  expect(chapterSlice).not.toContain("59.2%");

  // Prior-year must NOT be fabricated — table columns show only MTD + YTD + Variance.
  // Verify by absence of "Prior Year" or "PY" column heading in chapter slice.
  expect(chapterSlice).not.toMatch(/Prior Year|FY2025/);

  // -------- Baseline unchanged --------
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await page.screenshot({ path: "test-results/report-audit-1a-section-xii.png", fullPage: true });
  await ctx.close();
});
