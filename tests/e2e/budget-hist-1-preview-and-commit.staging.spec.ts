// BUDGET-HIST-1 (2026-10-04) — staging Preview + Commit acceptance.
//
// Three distinct Playwright tests so each phase can be re-run
// independently if a reconciliation gate fires:
//   (1) BEFORE snapshot of the protected accounting baseline.
//   (2) Preview against the 2026 Budget CSV — asserts source
//       structural controls + reconciliation gates.
//   (3) Commit (gated — only runs if `BUDGET_COMMIT=1` env var is
//       set). Re-run idempotency check. Post-commit diagnostic +
//       AFTER baseline hold.

import { existsSync, readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const CSV = "C:/Users/cturcato/AppData/Local/Temp/claude/c--dev-SpectreAutomation/0024fdd7-1cbc-4a67-8903-1a917d6d43e4/scratchpad/2026-coulee-budget.csv";
const runAt = creds.ready && existsSync(CSV) ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}

runAt("BUDGET-HIST-1 · (1) baseline + (2) preview", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const page = await loginAsFounder(context);

  const before = await invariant(page);
  console.log("BUDGET_HIST_1_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  const csv = readFileSync(CSV, "utf8");
  const previewUrl = `${BASE}/api/admin/budget-import/preview?clubId=${CLUB_ID}&fiscalYear=2026`;
  const r = await page.request.post(previewUrl, {
    data: csv,
    headers: { "content-type": "text/plain" },
  });
  expect(r.ok()).toBe(true);
  const preview = await r.json();
  console.log("BUDGET_HIST_1_PREVIEW_SUMMARY " + JSON.stringify({
    club: preview.club?.name,
    fiscalYear: preview.fiscalYear?.label,
    rowCount: preview.parse.rowCount,
    uniqueAccountCount: preview.parse.uniqueAccountCount,
    uniqueDeptCodeCount: preview.parse.uniqueDeptCodeCount,
    monthlyJan: preview.parse.monthlyTotals[0],
    annualTotal: preview.parse.annualTotal,
    sourceFileHash: preview.parse.sourceFileHash,
    blockers: preview.blockers,
    warnings: preview.warnings,
    wouldReplaceExistingBudget: preview.wouldReplaceExistingBudget,
    isFullyResolved: preview.mapping.isFullyResolved,
  }));
  console.log("BUDGET_HIST_1_PREVIEW_DEPTS " + JSON.stringify(
    preview.mapping.departments.map((d: any) => ({
      jonas: d.jonasDeptCode, spectre: d.spectreCode, name: d.departmentName, evidence: d.evidence,
    })),
  ));
  console.log("BUDGET_HIST_1_PREVIEW_UNMATCHED_ACCTS " + JSON.stringify({
    count: preview.mapping.unmatchedAccountNumbers.length,
    sample: preview.mapping.unmatchedAccountNumbers.slice(0, 20),
  }));
  console.log("BUDGET_HIST_1_PREVIEW_FS_GROUPS " + JSON.stringify(preview.byFsGroup));
  console.log("BUDGET_HIST_1_PREVIEW_PER_DEPT " + JSON.stringify(
    preview.perDepartment.map((d: any) => ({
      jonas: d.jonasDeptCode, name: d.departmentName,
      rows: d.rowCount, jan: d.monthlyTotals[0], annual: d.annualTotal,
    })),
  ));

  // Hard founder-side controls.
  expect(preview.parse.rowCount).toBe(199);
  expect(preview.parse.uniqueAccountCount).toBe(157);
  expect(preview.parse.uniqueDeptCodeCount).toBe(8);
  expect(preview.parse.duplicateDeptAccountKeys).toEqual([]);
  // Monthly + annual totals from our pre-flight audit.
  expect(preview.parse.monthlyTotals[0]).toBeCloseTo(-2_751_048.99, 2);
  expect(preview.parse.annualTotal).toBeCloseTo(-861_251.43, 2);
  // Hash deterministic.
  expect(preview.parse.sourceFileHash).toMatch(/^[0-9a-f]{64}$/);

  // Baseline unchanged after preview (preview is non-mutating).
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await context.close();
});
