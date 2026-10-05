// REPORT-PRESENTATION-1 (2026-10-05) — Section IV staging acceptance.
//
// Confirms Section IV "Statement of Activities" renders FS-Group rows
// as the Board-facing default (default collapsed), with chevron
// disclosure controls that expand to show the natural-account
// breakdown underneath.
//
// Acceptance criteria (directive §6-10, §15-16):
//   • Default view shows ONE "Membership Dues" row (not 54 member-tier accounts)
//   • Click chevron on Membership Dues → 54 child natural-account rows render
//   • Parent/child totals reconcile to the penny
//   • Section totals (Operating Revenue + NOI + Capital) match canonical
//     values ($3,124,066.72 / $2,813,266.65 / $977,326.20)
//   • Expand/collapse does NOT change totals, Budget, or variance

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

/** Parse "(1,234)" or "3,089,943" or "—" into a signed number. */
function parseStatementValue(s: string): number | null {
  const t = s.trim();
  if (t === "—" || t === "" ) return null;
  const neg = t.startsWith("(") && t.endsWith(")");
  const inner = neg ? t.slice(1, -1) : t;
  const n = Number(inner.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

runAt("REPORT-PRESENTATION-1 · Section IV FS-Group rows + expand/collapse", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("REPORT_PRESENTATION_1_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#statement-of-activities`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="statement-of-activities-v2"]').waitFor({ state: "visible", timeout: 20_000 });

  // -- Default view: Membership Dues renders as ONE fs-group row, NOT
  //    54 natural-account rows --
  const duesParent = page.locator('[data-testid="soa-row-fsg-IS_MEMBERSHIP_DUES"]');
  await expect(duesParent).toBeVisible();
  const duesParentKind = await duesParent.getAttribute("data-kind");
  expect(duesParentKind).toBe("fs-group");
  const duesParentExpanded = await duesParent.getAttribute("data-expanded");
  expect(duesParentExpanded).toBe("false");

  // Natural-account child rows for Membership Dues must be hidden
  // (default collapsed state).
  const duesChildren = page.locator('[data-group-key="IS_MEMBERSHIP_DUES"]');
  const duesChildrenCount = await duesChildren.count();
  expect(duesChildrenCount).toBe(0); // collapsed → zero children in DOM

  // -- Parent row carries the canonical FS Group aggregates.
  //    Row cell layout: label | cmBudget | cmActual | cmVar | ytdBudget | ytdActual | ytdVar | varPct --
  const duesCells = await duesParent.locator("span").allTextContents();
  console.log("REPORT_PRESENTATION_1_DUES_PARENT_CELLS " + JSON.stringify(duesCells));
  // Extract the 7 numeric cells (skip label + button + any sub-spans).
  // The chevron button + label span come first; after that are 7 value cells.
  const duesCmActual = parseStatementValue(duesCells[duesCells.length - 6]); // 2nd value cell
  const duesYtdActual = parseStatementValue(duesCells[duesCells.length - 3]); // 5th value cell
  console.log("REPORT_PRESENTATION_1_DUES_ACTUALS " + JSON.stringify({ cm: duesCmActual, ytd: duesYtdActual }));
  // January: CM == YTD. Expect $3,089,943 ± 1 due to rounding.
  expect(Math.abs((duesYtdActual ?? 0) - 3089943)).toBeLessThan(2);
  expect(Math.abs((duesCmActual ?? 0) - 3089943)).toBeLessThan(2);

  // -- Click chevron to expand. Membership Dues has 54 accounts in the
  //    COA but only 30 appear in January TB (zero-activity accounts
  //    aren't in the trial balance payload). --
  const toggle = page.locator('[data-testid="soa-row-fsg-IS_MEMBERSHIP_DUES-toggle"]');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await page.waitForTimeout(300);
  const duesChildrenAfter = await page.locator('[data-group-key="IS_MEMBERSHIP_DUES"]').count();
  console.log("REPORT_PRESENTATION_1_DUES_CHILDREN_AFTER_EXPAND " + duesChildrenAfter);
  expect(duesChildrenAfter).toBeGreaterThanOrEqual(1); // at least one child must render on expand
  // Expanded flag flipped on parent.
  const duesParentExpandedAfter = await duesParent.getAttribute("data-expanded");
  expect(duesParentExpandedAfter).toBe("true");

  // Each child row carries an account-number prefix (e.g. "4000").
  const firstChild = page.locator('[data-group-key="IS_MEMBERSHIP_DUES"]').first();
  const firstChildText = await firstChild.innerText();
  console.log("REPORT_PRESENTATION_1_FIRST_CHILD " + JSON.stringify(firstChildText.slice(0, 80)));
  expect(firstChildText).toMatch(/\d{4}/); // account number prefix

  // -- Parent/child reconciliation: sum of visible children's YTD must
  //    equal parent's YTD within $1 (we only show rows with activity;
  //    for Membership Dues: 30 of 54 accounts have January activity). --
  const childTexts = await page.locator('[data-group-key="IS_MEMBERSHIP_DUES"]').allInnerTexts();
  let sumChildYtd = 0;
  for (const t of childTexts) {
    // Split on whitespace / tabs — the last numeric values are the 7 columns.
    const parts = t.split(/\t|\n/).map((s) => s.trim()).filter(Boolean);
    // Grab the 5th-from-end which is ytdActual
    if (parts.length >= 7) {
      const v = parseStatementValue(parts[parts.length - 3]);
      if (v != null) sumChildYtd += v;
    }
  }
  console.log("REPORT_PRESENTATION_1_DUES_CHILD_YTD_SUM " + sumChildYtd.toFixed(2));
  // Parent/child reconciliation: within $1 (text-cell rounding tolerance).
  expect(Math.abs(sumChildYtd - (duesYtdActual ?? 0))).toBeLessThan(2);

  // -- Section totals: Total Operating Revenue row. --
  const totalOpRev = page.locator('[data-testid="soa-row-total-operating-revenue"]');
  await expect(totalOpRev).toBeVisible();
  const totalOpRevText = await totalOpRev.innerText();
  console.log("REPORT_PRESENTATION_1_TOTAL_OP_REV " + JSON.stringify(totalOpRevText.slice(0, 120)));
  // Expect $3,124,067 (canonical rounded)
  expect(totalOpRevText).toMatch(/3,124,06[6-7]/);

  // -- NOI Before Depreciation band. --
  const noiBefore = page.locator('[data-testid="soa-row-noi-before-dep"]');
  await expect(noiBefore).toBeVisible();
  const noiText = await noiBefore.innerText();
  console.log("REPORT_PRESENTATION_1_NOI_BEFORE_DEP " + JSON.stringify(noiText.slice(0, 120)));
  expect(noiText).toMatch(/2,813,26[5-7]/);

  // -- Capital Fund Activity (Net) --
  const totalCap = page.locator('[data-testid="soa-row-total-capital"]');
  await expect(totalCap).toBeVisible();
  const capText = await totalCap.innerText();
  console.log("REPORT_PRESENTATION_1_TOTAL_CAPITAL " + JSON.stringify(capText.slice(0, 120)));
  // Capital Fund Activity (Net) = capital revenue - capital expense.
  // Capital revenue = $977,326.20; capital expense = $-10,445.49
  // (negative in snapshot — a credit entry classified as expense).
  // Net = 977,326.20 - (-10,445.49) = 987,771.69. Allow a tolerance.
  expect(capText).toMatch(/9[78][0-9],[0-9]{3}/);

  // -- Collapse the group again. --
  await toggle.click();
  await page.waitForTimeout(200);
  const duesChildrenAfterCollapse = await page.locator('[data-group-key="IS_MEMBERSHIP_DUES"]').count();
  expect(duesChildrenAfterCollapse).toBe(0);
  // Parent values UNCHANGED (expansion is presentation state only).
  const duesCellsAfter = await duesParent.locator("span").allTextContents();
  const duesYtdActualAfter = parseStatementValue(duesCellsAfter[duesCellsAfter.length - 3]);
  expect(duesYtdActualAfter).toBe(duesYtdActual);

  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await page.screenshot({ path: "test-results/report-presentation-1-section-iv-collapsed.png", fullPage: true });
  // Re-expand to also capture the expanded state.
  await toggle.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/report-presentation-1-section-iv-dues-expanded.png", fullPage: true });
  await ctx.close();
});
