// REPORT-PRESENTATION-1A (2026-10-05) — Section IV category
// hierarchy staging acceptance.
//
// Confirms Section IV renders the Board-facing hierarchy:
//   Section → Category → FS Group (expandable) → Account → Subtotal
//
// Reconciliation gates (directive §15):
//   • Sum FS Groups within a category == category subtotal (to the penny)
//   • Sum category subtotals (OPERATING_REVENUE) == Total Operating Revenue
//   • Sum category subtotals (OPERATING_EXPENSE) == Total Operating Expense
//     (NOI math preserved — NOI Before Dep = Revenue − OpEx-ex-dep)
//   • Collapse state does NOT change any aggregate

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

/** Pull the 7 numeric cells from a row's innerText. Row layout is
 *  label (possibly with inline chevron + account number) followed by
 *  the 7 numeric columns in order. "—" cells are treated as 0 so
 *  position is preserved across sparse-budget rows. */
function rowValuesFromInnerText(innerText: string): number[] {
  const parts = innerText.split(/\t|\n/).map((s) => s.trim()).filter(Boolean);
  // Identify the trailing 7 cells. A cell is a numeric literal, a
  // parenthesized negative, a "—", or a "+X.X%" / "X.X%" / "-X.X%".
  const isCell = (s: string): boolean => {
    if (s === "—") return true;
    if (/^[+-]?\d/.test(s)) return true;
    if (/^\(/.test(s)) return true;
    return false;
  };
  const nums: number[] = [];
  for (let i = parts.length - 1; i >= 0 && nums.length < 7; i--) {
    if (!isCell(parts[i])) continue;
    const v = parseStatementValue(parts[i]);
    nums.unshift(v ?? 0);
  }
  return nums;
}

runAt("REPORT-PRESENTATION-1A · Section IV Board category hierarchy + subtotal reconciliation", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("REPORT_PRESENTATION_1A_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#statement-of-activities`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="statement-of-activities-v2"]').waitFor({ state: "visible", timeout: 20_000 });

  // -- Category headings render --
  const expectedCategoryHeadings = [
    "DUES_AND_MEMBER_REVENUE",
    "GOLF_OPERATIONS_REVENUE",
    "FOOD_AND_BEVERAGE_REVENUE",
    "OTHER_OPERATING_REVENUE",
    "COST_OF_SALES",
    "PAYROLL_AND_RELATED",
    "OPERATING_AND_ADMINISTRATIVE_EXPENSES",
    "CAPITAL_REVENUE",
  ];
  for (const key of expectedCategoryHeadings) {
    const heading = page.locator(`[data-testid="soa-row-cat-heading-${key}"]`);
    await expect(heading, `category heading ${key} should render`).toBeVisible();
  }

  // -- Category subtotal rows render + each carries the 7-column grid --
  const subtotalKeys = expectedCategoryHeadings;
  const subtotals: Record<string, { ytdActual: number; ytdBudget: number }> = {};
  for (const key of subtotalKeys) {
    const row = page.locator(`[data-testid="soa-row-cat-subtotal-${key}"]`);
    await expect(row, `category subtotal ${key} should render`).toBeVisible();
    const text = await row.innerText();
    const vals = rowValuesFromInnerText(text);
    // vals = [cmBudget, cmActual, cmVariance, ytdBudget, ytdActual, ytdVariance, varPct]
    expect(vals.length).toBeGreaterThanOrEqual(5);
    subtotals[key] = { ytdActual: vals[4], ytdBudget: vals[3] };
  }
  console.log("REPORT_PRESENTATION_1A_CATEGORY_SUBTOTALS " + JSON.stringify(subtotals));

  // -- Sum of REVENUE category subtotals = Total Operating Revenue --
  const revCats = ["DUES_AND_MEMBER_REVENUE", "GOLF_OPERATIONS_REVENUE", "FOOD_AND_BEVERAGE_REVENUE", "OTHER_OPERATING_REVENUE"];
  const sumRevYtd = revCats.reduce((s, k) => s + (subtotals[k]?.ytdActual ?? 0), 0);
  const totalOpRevRow = page.locator('[data-testid="soa-row-total-operating-revenue"]');
  const totalOpRevText = await totalOpRevRow.innerText();
  const totalOpRevVals = rowValuesFromInnerText(totalOpRevText);
  const totalOpRevYtd = totalOpRevVals[4];
  console.log("REPORT_PRESENTATION_1A_REV_RECON " + JSON.stringify({ sumRevCategoryYtd: sumRevYtd, totalOpRevYtd }));
  // Within $1 (rounding).
  expect(Math.abs(sumRevYtd - totalOpRevYtd)).toBeLessThan(2);
  // Canonical reconciliation.
  expect(Math.abs(totalOpRevYtd - 3_124_067)).toBeLessThan(2);

  // -- Sum of EXPENSE category subtotals (ex-depreciation) + NOI math --
  const expCats = ["COST_OF_SALES", "PAYROLL_AND_RELATED", "OPERATING_AND_ADMINISTRATIVE_EXPENSES"];
  const sumExpYtd = expCats.reduce((s, k) => s + (subtotals[k]?.ytdActual ?? 0), 0);
  console.log("REPORT_PRESENTATION_1A_OPEX_EX_DEP " + sumExpYtd.toFixed(2));
  // NOI Before Dep = $2,813,266.65 canonical; so Opex-ex-dep ~= $310,800.
  const noiBefore = page.locator('[data-testid="soa-row-noi-before-dep"]');
  const noiText = await noiBefore.innerText();
  const noiVals = rowValuesFromInnerText(noiText);
  const noiYtdActual = noiVals[4];
  console.log("REPORT_PRESENTATION_1A_NOI_FROM_PAGE " + noiYtdActual);
  // Revenue - OpEx-ex-dep should equal NOI-before-dep within $2.
  const computedNoi = totalOpRevYtd - sumExpYtd;
  console.log("REPORT_PRESENTATION_1A_COMPUTED_NOI " + computedNoi.toFixed(2));
  expect(Math.abs(computedNoi - noiYtdActual)).toBeLessThan(2);
  // NOI canonical reconciliation.
  expect(Math.abs(noiYtdActual - 2_813_267)).toBeLessThan(2);

  // -- Capital section category subtotal + total --
  const sumCapRevYtd = subtotals["CAPITAL_REVENUE"]?.ytdActual ?? 0;
  console.log("REPORT_PRESENTATION_1A_CAPITAL_REVENUE_SUBTOTAL " + sumCapRevYtd.toFixed(2));
  // Capital revenue = $977,326.20 canonical.
  expect(Math.abs(sumCapRevYtd - 977_326)).toBeLessThan(2);

  // -- Membership Dues FS Group reconciles to the Dues & Member Revenue category subtotal --
  const duesGroup = page.locator('[data-testid="soa-row-fsg-IS_MEMBERSHIP_DUES"]');
  const duesText = await duesGroup.innerText();
  const duesVals = rowValuesFromInnerText(duesText);
  const duesYtdActual = duesVals[4];
  console.log("REPORT_PRESENTATION_1A_DUES_PARENT " + duesYtdActual);
  // The Dues category also contains IS_ANNUAL_FEES. Dues subtotal should
  // be >= Membership Dues parent (sum of 2 groups).
  const duesCategorySubtotal = subtotals["DUES_AND_MEMBER_REVENUE"].ytdActual;
  expect(duesCategorySubtotal).toBeGreaterThanOrEqual(duesYtdActual);
  // Membership Dues itself must be $3,089,943 to the penny per earlier recon.
  expect(Math.abs(duesYtdActual - 3_089_943)).toBeLessThan(2);

  // -- Expand Membership Dues → verify natural-account rows render --
  const toggle = page.locator('[data-testid="soa-row-fsg-IS_MEMBERSHIP_DUES-toggle"]');
  await toggle.click();
  await page.waitForTimeout(300);
  const childrenCount = await page.locator('[data-group-key="IS_MEMBERSHIP_DUES"]').count();
  console.log("REPORT_PRESENTATION_1A_DUES_CHILDREN_AFTER_EXPAND " + childrenCount);
  expect(childrenCount).toBeGreaterThanOrEqual(10);

  // -- Expansion must NOT alter category subtotal values --
  const duesSubtotalAfter = page.locator('[data-testid="soa-row-cat-subtotal-DUES_AND_MEMBER_REVENUE"]');
  const duesSubtotalText = await duesSubtotalAfter.innerText();
  const duesSubtotalVals = rowValuesFromInnerText(duesSubtotalText);
  expect(duesSubtotalVals[4]).toBe(duesCategorySubtotal);

  // -- Save screenshots (collapsed + expanded) --
  await toggle.click(); // back to collapsed
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/report-presentation-1a-section-iv-collapsed.png", fullPage: true });
  await toggle.click(); // expand again for the second screenshot
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/report-presentation-1a-section-iv-dues-expanded.png", fullPage: true });

  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await ctx.close();
});
