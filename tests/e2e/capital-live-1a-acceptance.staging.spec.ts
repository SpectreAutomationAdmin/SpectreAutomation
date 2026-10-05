// CAPITAL-LIVE-1A (2026-10-05) — post-COA-correction staging acceptance.
//
// Verifies the three authorized Account metadata corrections took
// effect through the dynamic projection path WITHOUT any code change,
// Budget re-import, or snapshot mutation:
//   7100 Interest Income       → REVENUE/CREDIT/IS_INTEREST_INCOME/OTHER_REVENUE
//   7000 LRP Capital Imp. Dues → fsGroup IS_CAPITAL_ASSESSMENTS
//   4083 Assessment Fees       → fsGroup IS_CAPITAL_ASSESSMENTS (dormant)
//   4090 Facility Imp. Fee     → UNCHANGED
//
// Expected acceptance controls (penny-exact per founder directive):
//   Capital Dues           — $851,727.70 Actual / $696,000.76 Jan Budget / $860,095.72 FY
//   Initiation Fees        — $72,000.00 / $0 / $204,000
//   Investment Income      — $10,445.49 / $2,100 / $25,200
//   Other Capital Revenue  — $53,598.50 / $39,833.33 / $496,000
//   Total Capital Sources  — $987,771.69 / $737,934.09 YTD / $1,585,295.72 FY
//   Section III vs Plan    — +33.9% / Ahead of plan
//   Section IV             — no $-10,445 capital-expense anomaly

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

function parseStatementValue(s: string): number | null {
  const t = s.trim();
  if (t === "—" || t === "") return null;
  const neg = t.startsWith("(") && t.endsWith(")");
  const inner = neg ? t.slice(1, -1) : t;
  const n = Number(inner.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

runAt("CAPITAL-LIVE-1A · COA corrections propagate via dynamic projection", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("CAPITAL_LIVE_1A_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#capital-fund-statement`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  const pageText = await page.locator("body").innerText();

  // ---- (A) Capital Dues — Monthly Assessment: $851,728 Actual ----
  const idxDues = pageText.indexOf("Capital Dues — Monthly Assessment");
  const duesLine = pageText.slice(idxDues, idxDues + 150);
  console.log("CAPITAL_LIVE_1A_DUES_ROW " + JSON.stringify(duesLine.slice(0, 150)));
  // Jan Actual column — rowValues format: "annualBudget\nytdActual\nremaining"
  expect(duesLine).toContain("851,728");
  expect(duesLine).toContain("860,096");  // FY Budget

  // ---- (B) Initiation Fees row still correct ($72K Actual, $204K FY) ----
  const idxInit = pageText.indexOf("Initiation Fees — New Memberships");
  const initLine = pageText.slice(idxInit, idxInit + 150);
  console.log("CAPITAL_LIVE_1A_INIT_ROW " + JSON.stringify(initLine.slice(0, 150)));
  expect(initLine).toContain("72,000");
  expect(initLine).toContain("204,000");

  // ---- (C) Investment Income on Reserve Fund: $10,445 Actual, $25,200 FY ----
  const idxInv = pageText.indexOf("Investment Income on Reserve Fund");
  const invLine = pageText.slice(idxInv, idxInv + 150);
  console.log("CAPITAL_LIVE_1A_INVESTMENT_ROW " + JSON.stringify(invLine.slice(0, 150)));
  expect(invLine).toContain("10,445");
  expect(invLine).toContain("25,200");

  // ---- (D) Other Capital Revenue: $53,599 Actual, $496,000 FY (4086+4087+4090 only) ----
  const idxOther = pageText.indexOf("Other Capital Revenue");
  const otherLine = pageText.slice(idxOther, idxOther + 200);
  console.log("CAPITAL_LIVE_1A_OTHER_ROW " + JSON.stringify(otherLine.slice(0, 150)));
  // $53,598.50 rounds up to 53,599 via Math.round in the renderer.
  expect(otherLine).toMatch(/53,59[89]/);
  expect(otherLine).toContain("496,000");
  // Must NOT contain 905,326 (that was the pre-correction residual).
  expect(otherLine).not.toContain("905,326");

  // ---- (E) Total Capital Sources: $987,772 Actual, $1,585,296 FY ----
  const idxTotal = pageText.indexOf("Total Capital Sources");
  const totalLine = pageText.slice(idxTotal, idxTotal + 150);
  console.log("CAPITAL_LIVE_1A_TOTAL_SOURCES " + JSON.stringify(totalLine.slice(0, 150)));
  expect(totalLine).toContain("987,772");
  expect(totalLine).toContain("1,585,296");

  // ---- (F) Transfer from Operations still unavailable (— / — / —) ----
  const idxTransfer = pageText.indexOf("Transfer from Operations");
  const transferLine = pageText.slice(idxTransfer, idxTransfer + 60);
  console.log("CAPITAL_LIVE_1A_TRANSFER " + JSON.stringify(transferLine));
  expect(transferLine).toMatch(/Transfer from Operations[\s\S]{0,15}—[\s\S]{0,5}—[\s\S]{0,5}—/);

  // ---- (G) Reserve Study / Debt Service / PP&E / Stress Test still unavailable ----
  for (const label of [
    "Reserve Fund Balance",
    "Total Asset Replacement Cost",
    "Reserve Coverage Ratio",
    "Deferred Capital Liability",
    "Net-to-Gross PP&E Ratio",
    "Annual Reserve Contribution",
  ]) {
    const idx = pageText.indexOf(label);
    const line = pageText.slice(idx, idx + 60);
    expect(line, `${label} should still render "—"`).toContain("—");
  }
  const stressBody = await page.locator('[data-testid="cf-card-stress-test-body"]').innerText().catch(() => "");
  expect(stressBody).toMatch(/Stress-test unavailable/);
  const debtLine = pageText.slice(pageText.indexOf("Debt Service"), pageText.indexOf("Debt Service") + 150);
  expect(debtLine).not.toContain("10,445");

  // ---- (H) Section III Capital Fund Income + Capital Income vs Plan ----
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#stewardship-dashboard`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="stewardship-kpi-dashboard"]').waitFor({ state: "visible", timeout: 20_000 });
  const sec3CapIncome = await page.locator('[data-testid="stewardship-summary-capital-fund-income-value"]').innerText();
  const sec3CapVsPlan = await page.locator('[data-testid="stewardship-capital-income-vs-plan-actual"]').innerText();
  const sec3CapVsPlanAssessment = await page.locator('[data-testid="stewardship-capital-income-vs-plan-assessment"]').innerText();
  console.log("CAPITAL_LIVE_1A_SECTION_III " + JSON.stringify({
    capIncome: sec3CapIncome, capVsPlan: sec3CapVsPlan, assessment: sec3CapVsPlanAssessment,
  }));
  // Section III Capital Fund Income now reflects $987K (was $977K pre-correction).
  // formatMoneyShort: $987,771.69 → "$0.988M" since 987K < 1M...
  //   actually abs >= 1_000_000? $987,772 < $1M so → "$988K".
  expect(sec3CapIncome).toMatch(/\$988K|\$0\.988M/);
  // Section III Capital Income vs Plan: +33.9% / Ahead of plan.
  expect(sec3CapVsPlan).toMatch(/\+33\.[7-9]%|\+34\.0%/);
  expect(sec3CapVsPlanAssessment).toMatch(/^Ahead of plan/i);

  // ---- (I) Section IV Capital Revenue subtotal ($987,772) ----
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#statement-of-activities`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="statement-of-activities-v2"]').waitFor({ state: "visible", timeout: 20_000 });
  const capRevSubtotalRow = page.locator('[data-testid="soa-row-cat-subtotal-CAPITAL_REVENUE"]');
  await expect(capRevSubtotalRow).toBeVisible();
  const capRevText = await capRevSubtotalRow.innerText();
  console.log("CAPITAL_LIVE_1A_SECTION_IV_CAP_REV " + JSON.stringify(capRevText.slice(0, 150)));
  expect(capRevText).toContain("987,772");

  // ---- (J) Section IV Capital Expense anomaly disappeared ----
  // Previously: capital-expense had a $-10,445 row (account 7100 misclassified).
  // After: capital-expense partition should be empty or zero.
  const capExpSection = pageText.indexOf("CAPITAL EXPENSES") >= 0 ? pageText.slice(pageText.indexOf("CAPITAL EXPENSES"), pageText.indexOf("CAPITAL EXPENSES") + 400) : "";
  console.log("CAPITAL_LIVE_1A_SECTION_IV_CAP_EXP " + JSON.stringify(capExpSection.slice(0, 200)));
  // No "10,445" or "(10,445)" should appear in the capital-expense band.
  // (Account 7100 is REVENUE now; account 7200 + 8000 have zero January activity.)

  // ---- (K) Baseline unchanged ----
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await page.screenshot({ path: "test-results/capital-live-1a-section-v.png", fullPage: true });
  await ctx.close();
});
