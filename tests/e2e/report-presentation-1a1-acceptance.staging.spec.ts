// REPORT-PRESENTATION-1A.1 (2026-10-05) — staging acceptance.
//
// Verifies:
//   (A) Section IV emits the Financing & Other section between
//       NOI-after-dep and the Capital divider, with the "Net Result
//       Before Capital Fund" row following.
//   (B) New canonical NOI (excluding Interest Expense) renders on
//       Section IV AND on Section III stewardship headline (one
//       canonical definition across sections).
//   (C) Interest Expense ($7,180.11 Jan) no longer reduces NOI Before
//       Depreciation. New NOI = Prior NOI + Interest ≈ $2,820,447.
//   (D) Print path: Chromium media="print" emulation shows the
//       category hierarchy + FS Group parent rows + category
//       subtotals + statement totals, with no natural-account
//       children in the DOM (collapsed by default on first render).

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

function rowValuesFromInnerText(innerText: string): number[] {
  const parts = innerText.split(/\t|\n/).map((s) => s.trim()).filter(Boolean);
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

runAt("REPORT-PRESENTATION-1A.1 · Interest moved to Financing & Other + canonical NOI reconciles", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("REPORT_PRESENTATION_1A1_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#statement-of-activities`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="statement-of-activities-v2"]').waitFor({ state: "visible", timeout: 20_000 });

  // ---- (A) Financing & Other section + Net Result Before Capital Fund render ----
  const financingHeading = page.locator('[data-testid="soa-row-cat-heading-FINANCING_AND_OTHER"]');
  await expect(financingHeading, "Financing & Other category heading").toBeVisible();
  const financingSubtotal = page.locator('[data-testid="soa-row-cat-subtotal-FINANCING_AND_OTHER"]');
  await expect(financingSubtotal, "Financing & Other category subtotal").toBeVisible();
  const financingVals = rowValuesFromInnerText(await financingSubtotal.innerText());
  const financingYtd = financingVals[4];
  console.log("REPORT_PRESENTATION_1A1_FINANCING_SUBTOTAL " + JSON.stringify({ ytdActual: financingYtd }));
  // Interest Expense Jan = $7,180.11
  expect(Math.abs(financingYtd - 7180)).toBeLessThan(2);

  const netBeforeCap = page.locator('[data-testid="soa-row-net-before-capital"]');
  await expect(netBeforeCap, "Net Result Before Capital Fund row").toBeVisible();
  const netBeforeCapText = await netBeforeCap.innerText();
  console.log("REPORT_PRESENTATION_1A1_NET_BEFORE_CAPITAL " + JSON.stringify(netBeforeCapText.slice(0, 120)));
  const netBeforeCapVals = rowValuesFromInnerText(netBeforeCapText);
  const netBeforeCapYtd = netBeforeCapVals[4];
  // Net Before Capital = NOI After Dep − Financing

  // ---- (B) Canonical NOI reconciliation ----
  const noiBefore = page.locator('[data-testid="soa-row-noi-before-dep"]');
  const noiVals = rowValuesFromInnerText(await noiBefore.innerText());
  const noiYtd = noiVals[4];
  console.log("REPORT_PRESENTATION_1A1_NOI_SECTION_IV " + JSON.stringify({ ytdActual: noiYtd }));
  // Prior NOI $2,813,267 + Financing $7,180 = $2,820,447.
  expect(Math.abs(noiYtd - 2_820_447)).toBeLessThan(3);

  // Section III stewardship NOI summary card
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#stewardship-dashboard`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="stewardship-kpi-dashboard"]').waitFor({ state: "visible", timeout: 20_000 });
  const sec3Noi = await page.locator('[data-testid="stewardship-summary-noi-value"]').innerText().catch(() => "");
  const sec3Rev = await page.locator('[data-testid="stewardship-summary-revenue-value"]').innerText().catch(() => "");
  console.log("REPORT_PRESENTATION_1A1_SECTION_III " + JSON.stringify({ noi: sec3Noi, revenue: sec3Rev }));
  // Section III NOI must now MATCH Section IV ($2.820M). Previously
  // showed $2.808M due to the stewardship adapter's parallel path.
  expect(sec3Noi).toMatch(/\$2\.820M/);
  // Section III Revenue must also match Section IV ($3.124M).
  expect(sec3Rev).toMatch(/\$3\.124M/);

  // ---- (C) Verify Interest Expense is NOT inside Operating & Administrative anymore ----
  const opAdminSubtotal = page.locator('[data-testid="soa-row-cat-subtotal-OPERATING_AND_ADMINISTRATIVE_EXPENSES"]');
  const opAdminText = await opAdminSubtotal.innerText();
  const opAdminVals = rowValuesFromInnerText(opAdminText);
  const opAdminYtd = opAdminVals[4];
  console.log("REPORT_PRESENTATION_1A1_OP_ADMIN_SUBTOTAL " + JSON.stringify({ ytdActual: opAdminYtd }));
  // Old staging value was $133,767 (including Interest $7,180).
  // New value excludes Interest: $133,767 - $7,180 = $126,587.
  expect(Math.abs(opAdminYtd - 126_587)).toBeLessThan(3);

  // ---- (D) Print path verification ----
  // Chromium media="print" emulation. The server-rendered DOM reflects
  // the collapsed-by-default state because the client component's
  // useState initial value is an empty Set. No DB mutation; no
  // publication required.
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#statement-of-activities`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="statement-of-activities-v2"]').waitFor({ state: "visible", timeout: 20_000 });
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(500);
  // Natural-account children must NOT be in the print DOM (collapsed).
  const childrenInPrint = await page.locator('[data-group-key="IS_MEMBERSHIP_DUES"]').count();
  console.log("REPORT_PRESENTATION_1A1_PRINT_CHILDREN " + childrenInPrint);
  expect(childrenInPrint).toBe(0);
  // Category headings + FS Group parents + category subtotals + totals
  // must all be present.
  for (const sel of [
    '[data-testid="soa-row-cat-heading-DUES_AND_MEMBER_REVENUE"]',
    '[data-testid="soa-row-cat-heading-FINANCING_AND_OTHER"]',
    '[data-testid="soa-row-fsg-IS_MEMBERSHIP_DUES"]',
    '[data-testid="soa-row-cat-subtotal-DUES_AND_MEMBER_REVENUE"]',
    '[data-testid="soa-row-cat-subtotal-FINANCING_AND_OTHER"]',
    '[data-testid="soa-row-total-operating-revenue"]',
    '[data-testid="soa-row-noi-before-dep"]',
    '[data-testid="soa-row-noi-after-dep"]',
    '[data-testid="soa-row-net-before-capital"]',
    '[data-testid="soa-row-total-capital"]',
    '[data-testid="soa-row-net-combined"]',
  ]) {
    await expect(page.locator(sel), `print DOM: ${sel}`).toBeVisible();
  }
  // Chevron buttons are present in the DOM (they're inside the fs-group
  // row) but not required to interact with for the Board PDF; verify
  // the fs-group row renders without needing the user to click.
  const chevronCount = await page.locator('[data-testid*="-toggle"]').count();
  console.log("REPORT_PRESENTATION_1A1_PRINT_CHEVRON_COUNT " + chevronCount);
  // Capture print screenshot.
  await page.screenshot({ path: "test-results/report-presentation-1a1-section-iv-print.png", fullPage: true });
  await page.emulateMedia({ media: null }); // reset

  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await ctx.close();
});
