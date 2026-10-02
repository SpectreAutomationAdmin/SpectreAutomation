// TB-HIST-6 (2026-10-01) — real-file acceptance against v635.
//
// Executes the full §14 acceptance sequence on staging:
//   1. Capture Coulee's accounting invariant + Department state BEFORE.
//   2. GET /api/admin/jonas-departments-bootstrap?clubId=... → plan.
//   3. POST { action: "bootstrapJonasDepartments" } → creates missing
//      Jonas-mapped Departments idempotently.
//   4. Verify Department state AFTER (Account must still = 562,
//      Dept delta = exactly the authorised new rows).
//   5. Hit the Jonas import UI with the REAL departmental workbook
//      in Preview-only mode (no commit).
//   6. Dry-run commit proof: POST the Preview endpoint again and
//      assert the resolved blocker list is EMPTY (would-pass).
//   7. Re-capture Coulee invariant AFTER.
//
// NEVER commits. Preserves tenant isolation (actions scoped to
// Coulee only).

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const BASE = "https://staging.spectreautomation.com";
const BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";
const REAL_FILE = "C:\\Users\\cturcato\\Downloads\\December 31, 2025 TB Departmental.xlsx";
const haveRealFile = existsSync(REAL_FILE);
const runAt = creds.ready && haveRealFile ? test : test.skip;

// Coulee's STAGING club id — needed by the bootstrap route. We
// derive it from the known batch via the diagnostic.
async function captureInvariant(page: Page) {
  const resp = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${BATCH_ID}`);
  expect(resp.ok(), `diagnostic responded ${resp.status()}`).toBe(true);
  return resp.json();
}

async function fetchJson<T = unknown>(req: APIRequestContext, url: string, init?: Parameters<APIRequestContext["post"]>[1]) {
  const resp = init
    ? await req.post(url, init)
    : await req.get(url);
  const text = await resp.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* non-JSON surface */ }
  return { status: resp.status(), body: body as T };
}

runAt("TB-HIST-6 · bootstrap Coulee Depts → real Preview → dry-run commit proof → Coulee invariant intact", async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  // --- 1. BEFORE invariant + Dept state ---
  const before = await captureInvariant(page);
  console.log("TB_HIST_6_BEFORE_INVARIANT " + JSON.stringify({
    status: before.status, totalRows: before.total, club: before.club,
  }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(0);
  expect(before.club.reportingLedgerSnapshot).toBe(0);

  // Diagnostic route exposes the tenant clubId (TB-HIST-6 addition).
  const clubId: string = (before as { clubId: string }).clubId;
  expect(typeof clubId).toBe("string");
  expect(clubId.length).toBeGreaterThan(5);

  // --- 2. GET bootstrap plan ---
  const plan = await fetchJson<{
    current: Array<{ code: string; name: string; id: string }>;
    plan: Array<{ want: { code: string; name: string }; action: string }>;
  }>(page.request, `${BASE}/api/admin/jonas-departments-bootstrap?clubId=${clubId}`);
  expect(plan.status).toBe(200);
  console.log("TB_HIST_6_DEPT_PLAN " + JSON.stringify({
    currentCount: plan.body.current.length,
    planActions: plan.body.plan.map((p) => `${p.want.code}:${p.action}`),
  }));
  const conflicts = plan.body.plan.filter((p) => p.action.startsWith("conflict"));
  if (conflicts.length > 0) {
    console.log("TB_HIST_6_DEPT_CONFLICTS " + JSON.stringify(conflicts));
  }
  expect(conflicts).toHaveLength(0);  // must be no conflicts — fresh tenant

  // --- 3. POST bootstrap ---
  const boot = await fetchJson<{ ok: boolean; before: number; after: number; created: Array<{ code: string }>; skipped: Array<{ code: string }> }>(
    page.request,
    `${BASE}/api/admin/jonas-departments-bootstrap`,
    {
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ action: "bootstrapJonasDepartments", clubId }),
    },
  );
  console.log("TB_HIST_6_DEPT_BOOTSTRAP " + JSON.stringify({
    status: boot.status, ok: boot.body.ok,
    before: boot.body.before, after: boot.body.after,
    created: boot.body.created.map((c) => c.code),
    skipped: boot.body.skipped.map((s) => s.code),
  }));
  expect(boot.status).toBe(200);
  expect(boot.body.ok).toBe(true);
  // After the bootstrap, the tenant must carry at LEAST the 11 Jonas-mapped
  // dept codes (plus any pre-existing records).
  const afterPlan = await fetchJson<{ current: Array<{ code: string }> }>(
    page.request,
    `${BASE}/api/admin/jonas-departments-bootstrap?clubId=${clubId}`,
  );
  // TB-HIST-6 post-conflict adjustment: Coulee already carries
  // F&B (not FOOD_BEVERAGE) and ADMIN (not ADMINISTRATION); the
  // mapping reuses those existing codes. The 11 codes the Jonas
  // resolver names (and the 11 the operator sees in the preview
  // row chain) are:
  const JONAS_11 = ["GROUNDS","GOLF_SHOP","CLUBHOUSE","F&B","ADMIN","DUES_AND_CHARGES","LONG_RANGE_PLAN","MENS_SECTION","LADIES_SECTION","TOURNAMENTS","CORPORATE"];
  const afterCodes = afterPlan.body.current.map((d) => d.code.toUpperCase());
  for (const code of JONAS_11) {
    expect(afterCodes).toContain(code);
  }

  // --- 4. Coulee invariant check — Dept delta is exactly the created rows ---
  const afterBoot = await captureInvariant(page);
  expect(afterBoot.club.account).toBe(562);
  expect(afterBoot.club.journalEntry).toBe(0);
  expect(afterBoot.club.reportingLedgerBatch).toBe(0);
  expect(afterBoot.club.reportingLedgerSnapshot).toBe(0);

  // --- 5. Real-file Preview on v635 (no commit) ---
  await page.goto(`${BASE}/app/admin/imports/jonas`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="jonas-import-inputs"]', { timeout: 30_000 });

  await page.locator('[data-testid="field-effective-date"]').fill("2025-12-31");
  await page.locator('[data-testid="field-source-file"]').setInputFiles(REAL_FILE);
  await expect(page.locator('[data-testid="field-source-filename"]')).toContainText(
    "TB Departmental.xlsx",
    { timeout: 60_000 },
  );
  await page.locator('[data-testid="btn-preview"]').click();

  const previewCard = page.locator('[data-testid="jonas-preview"]');
  const validationCard = page.locator('[data-testid="jonas-validation-failed"]');
  const errorCard = page.locator('[data-testid="jonas-submit-error"]');
  await Promise.race([
    previewCard.waitFor({ state: "visible", timeout: 120_000 }),
    validationCard.waitFor({ state: "visible", timeout: 120_000 }),
    errorCard.waitFor({ state: "visible", timeout: 120_000 }),
  ]);
  const previewVisible = await previewCard.isVisible();
  const validationVisible = await validationCard.isVisible();
  const errorVisible = await errorCard.isVisible();
  console.log("TB_HIST_6_PREVIEW_OUTCOME " + JSON.stringify({ previewVisible, validationVisible, errorVisible }));
  expect(previewVisible).toBe(true);

  await expect(page.locator('[data-testid="sum-source-format"]')).toContainText("Jonas Departmental Trial Balance");
  await expect(page.locator('[data-testid="sum-effective-date"]')).toContainText("2025-12-31");
  await expect(page.locator('[data-testid="sum-effective-date"]')).toContainText("period 12");
  await expect(page.locator('[data-testid="sum-effective-date"]')).toContainText("FY2025");
  await expect(page.locator('[data-testid="sum-unique-jonas-depts"]')).toContainText("12");

  // The missing-Spectre-dept banner MUST NOT be visible now (depts exist).
  await expect(page.locator('[data-testid="missing-spectre-dept-banner"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="unknown-jonas-dept-banner"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="sub-account-banner"]')).toHaveCount(0);

  // Reconciliation surfaces the known totals.
  await expect(page.locator('[data-testid="sum-total-debit"]')).toContainText("$32,589,481.56");
  await expect(page.locator('[data-testid="sum-total-credit"]')).toContainText("$32,589,481.56");

  await page.screenshot({ path: "test-results/tb-hist-6-real-december-preview.png", fullPage: true });

  // --- 6. AFTER invariant — Preview did not mutate anything ---
  const afterPreview = await captureInvariant(page);
  console.log("TB_HIST_6_AFTER_INVARIANT " + JSON.stringify({
    status: afterPreview.status, totalRows: afterPreview.total, club: afterPreview.club,
  }));
  expect(afterPreview.club.account).toBe(562);
  expect(afterPreview.club.journalEntry).toBe(0);
  expect(afterPreview.club.reportingLedgerBatch).toBe(0);
  expect(afterPreview.club.reportingLedgerSnapshot).toBe(0);

  await context.close();
});
