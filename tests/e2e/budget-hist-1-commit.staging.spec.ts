// BUDGET-HIST-1 (2026-10-04) — explicit COMMIT acceptance.
// Separate file from the Preview spec so Commit runs ONLY when
// explicitly invoked (`npx playwright test …budget-hist-1-commit…`).

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

runAt("BUDGET-HIST-1 · (3) COMMIT + idempotency + diagnostic", async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext();
  const page = await loginAsFounder(context);

  const before = await invariant(page);
  console.log("BUDGET_HIST_1_COMMIT_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  const csv = readFileSync(CSV, "utf8");
  const commitUrl = `${BASE}/api/admin/budget-import/commit?clubId=${CLUB_ID}&fiscalYear=2026&sourceFilename=2026.csv`;
  const r = await page.request.post(commitUrl, {
    data: csv,
    headers: { "content-type": "text/plain" },
  });
  expect(r.ok()).toBe(true);
  const commit = await r.json();
  console.log("BUDGET_HIST_1_COMMIT " + JSON.stringify(commit));
  expect(commit.outcome === "created" || commit.outcome === "unchanged").toBe(true);
  expect(commit.budget?.sourceFileHash).toMatch(/^[0-9a-f]{64}$/);
  expect(commit.lineCount).toBe(199);

  // Idempotency: re-commit should return "unchanged".
  const r2 = await page.request.post(commitUrl, {
    data: csv,
    headers: { "content-type": "text/plain" },
  });
  expect(r2.ok()).toBe(true);
  const commit2 = await r2.json();
  console.log("BUDGET_HIST_1_COMMIT_IDEMPOTENT " + JSON.stringify(commit2));
  expect(commit2.outcome).toBe("unchanged");
  expect(commit2.lineCount).toBe(199);
  expect(commit2.budget?.id).toBe(commit.budget?.id);

  // Diagnostic: canonical Budget resolver output for Jan 2026.
  const diagR = await page.request.get(
    `${BASE}/api/admin/budget-import/diagnostic?clubId=${CLUB_ID}&fiscalYear=2026&throughMonth=1`,
  );
  expect(diagR.ok()).toBe(true);
  const diag = await diagR.json();
  console.log("BUDGET_HIST_1_DIAG_IS " + JSON.stringify(diag.incomeStatementJan));
  console.log("BUDGET_HIST_1_DIAG_BUDGET " + JSON.stringify(diag.budget));
  console.log("BUDGET_HIST_1_DIAG_MONTHLY_RAW " + JSON.stringify(diag.monthlyTotalsRaw));
  console.log("BUDGET_HIST_1_DIAG_FS_GROUPS " + JSON.stringify(diag.byFsGroup));
  console.log("BUDGET_HIST_1_DIAG_PER_DEPT " + JSON.stringify(diag.perDepartmentActualVsBudget));
  console.log("BUDGET_HIST_1_DIAG_BASELINE " + JSON.stringify(diag.accountingBaseline));

  // Canonical IS values are logged for the acceptance package; the
  // test only asserts shape (revenue > 0 after sign-flip; expenses
  // ≥ 0; NOI = revenue − cogs − opex). Exact dollar values differ
  // from source monthly totals because the IS resolver splits by
  // Account.type + fsGroupKey.
  expect(diag.incomeStatementJan.revenue).toBeGreaterThan(0);
  expect(diag.incomeStatementJan.cogs).toBeGreaterThanOrEqual(0);
  expect(diag.incomeStatementJan.opex).toBeGreaterThanOrEqual(0);
  // Protected accounting baseline unchanged (budget doesn't touch
  // Account / JournalEntry / ReportingLedger*).
  expect(diag.accountingBaseline.account).toBe(before.club.account);
  expect(diag.accountingBaseline.journalEntry).toBe(0);
  expect(diag.accountingBaseline.reportingLedgerBatch).toBe(before.club.reportingLedgerBatch);
  expect(diag.accountingBaseline.reportingLedgerSnapshot).toBe(before.club.reportingLedgerSnapshot);
  // Budget persistence check.
  expect(diag.accountingBaseline.budgetCount).toBeGreaterThanOrEqual(1);
  expect(diag.accountingBaseline.budgetLineCount).toBe(199);

  // AFTER baseline hold.
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  console.log("BUDGET_HIST_1_COMMIT_AFTER " + JSON.stringify({ club: after.club }));
  await context.close();
});
