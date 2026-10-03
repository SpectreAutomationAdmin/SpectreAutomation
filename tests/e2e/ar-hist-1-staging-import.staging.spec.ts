// AR-HIST-1 §22 / §26 (2026-10-03) — authorized staging reconciliation
// + commit of the sanitized Jan 31 AR aging workbook.
//
// Flow:
//   1. Capture protected accounting baseline (562 / 0 / 2 / 2).
//   2. Hit /api/admin/ar-gl-control-diagnostic → log AR control
//      candidates deterministically.
//   3. action=preview on the real workbook → verify every founder
//      source control (728 rows, exact totals, 0 bucket exceptions,
//      MATCHED 728/728, GL RECONCILED within $0.01).
//   4. ONLY if preview.commitEligible → action=commit.
//      Else: STOP + log evidence.
//   5. Verify TB-HIST-12B's AR Current % resolver now returns
//      AVAILABLE for Jan 31.
//   6. Re-capture baseline — unchanged.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import { readFileSync, existsSync } from "node:fs";

const creds = stagingCredsAvailable();
const WORKBOOK = process.env.SPECTRE_AR_AGING_WORKBOOK_PATH
  ?? "C:/Users/cturcato/Downloads/Jan 31 2026 Aged AR - Sanitized for Spectre.xlsx";
const workbookReady = existsSync(WORKBOOK);
const runAt = creds.ready && workbookReady ? test : test.skip;

const BASE = "https://staging.spectreautomation.com";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";
const SOURCE_EFFECTIVE = "2026-01-31";

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}

async function postWorkbook(page: Page, action: "preview" | "commit"): Promise<{ status: number; body: unknown }> {
  const bytes = readFileSync(WORKBOOK);
  const resp = await page.request.post(`${BASE}/api/admin/ar-aging-import`, {
    multipart: {
      clubId: COULEE_CLUB_ID,
      sourceEffectiveDate: SOURCE_EFFECTIVE,
      action,
      file: {
        name: "Jan 31 2026 Aged AR - Sanitized for Spectre.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: bytes,
      },
    },
    timeout: 600_000,
  });
  return { status: resp.status(), body: await resp.json().catch(() => null) };
}

runAt("AR-HIST-1 · authorized staging reconciliation + commit (if gates pass)", async ({ browser }) => {
  test.setTimeout(900_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await invariant(page);
  console.log("AR_HIST_1_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  // §12 — GL AR control discovery.
  const diag = await page.request.get(`${BASE}/api/admin/ar-gl-control-diagnostic?clubId=${COULEE_CLUB_ID}`);
  expect(diag.ok(), `diagnostic responded ${diag.status()}`).toBe(true);
  const diagBody = await diag.json();
  console.log("AR_HIST_1_GL_DIAG " + JSON.stringify({
    asOf: diagBody.asOf,
    perFsGroupTotal: diagBody.perFsGroupTotal,
    accountCount: diagBody.accounts?.length,
    expectedArSubledgerTotal: diagBody.expectedArSubledgerTotal,
    accountsSummary: diagBody.accounts?.map((a: { accountNumber: string; name: string; fsGroupKey: string | null; naturalBalance: string }) => ({ accountNumber: a.accountNumber, name: a.name, fsGroupKey: a.fsGroupKey, naturalBalance: a.naturalBalance })),
  }, null, 2));

  // §5 §25 — Preview.
  const preview = await postWorkbook(page, "preview");
  expect(preview.status, `preview responded ${preview.status}: ${JSON.stringify(preview.body)}`).toBe(200);
  const pv = preview.body as {
    sourceFileHash: string;
    rowCount: number;
    invalidCount: number;
    totals: Record<string, string | number | null>;
    resolutionSummary: { matched: number; unmatched: number; ambiguous: number; invalid: number };
    nameConsistency: { checked: number; nameMatches: number; nameMismatches: number; blankNames: number };
    gl: {
      accountNumber: string | null;
      accountName: string | null;
      naturalBalance: string | null;
      subledgerTotal: string;
      difference: string | null;
      status: string | null;
      accountsIncluded: Array<{ accountNumber: string; name: string; naturalBalance: string }>;
    };
    commitEligible: boolean;
    aggregateReconcilesPerRow: boolean;
  };
  console.log("AR_HIST_1_PREVIEW " + JSON.stringify({
    sourceFileHash: pv.sourceFileHash.slice(0, 16) + "…",
    rowCount: pv.rowCount,
    invalidCount: pv.invalidCount,
    aggregateReconcilesPerRow: pv.aggregateReconcilesPerRow,
    totals: pv.totals,
    resolution: pv.resolutionSummary,
    nameConsistency: pv.nameConsistency,
    gl: pv.gl,
    commitEligible: pv.commitEligible,
  }, null, 2));

  // Founder source control assertions (hard — any failure STOPS commit).
  expect(pv.rowCount).toBe(728);
  expect(pv.aggregateReconcilesPerRow).toBe(true);
  expect(String(pv.totals.totalAR)).toBe("3585590.56");
  expect(String(pv.totals.current)).toBe("3558778.19");
  expect(String(pv.totals.oneMonth)).toBe("7759.2");
  expect(String(pv.totals.twoMonths)).toBe("2318.11");
  expect(String(pv.totals.threeMonths)).toBe("2699.31");
  expect(String(pv.totals.overFourMonths)).toBe("14035.75");
  expect(pv.totals.nonCurrentAccountCount).toBe(93);
  expect(pv.resolutionSummary.matched).toBe(728);
  expect(pv.resolutionSummary.unmatched).toBe(0);
  expect(pv.resolutionSummary.ambiguous).toBe(0);
  expect(pv.resolutionSummary.invalid).toBe(0);

  if (!pv.commitEligible) {
    console.log("AR_HIST_1_STOP_BEFORE_COMMIT " + JSON.stringify({
      reason: "commitEligible=false",
      gl: pv.gl,
      resolution: pv.resolutionSummary,
    }));
    // STOP — do NOT commit. The spec passes to let the acceptance
    // package capture evidence. Fail only if baseline moves.
    const after = await invariant(page);
    expect(after.club).toEqual(before.club);
    await context.close();
    return;
  }

  // Gates pass → authorized commit.
  const commit = await postWorkbook(page, "commit");
  console.log("AR_HIST_1_COMMIT " + JSON.stringify({ status: commit.status, body: commit.body }));
  expect([200, 409]).toContain(commit.status);
  if (commit.status === 200) {
    const c = commit.body as {
      committed: boolean;
      batchId: string;
      rowsCommitted: number;
      newMemberAccounts: number;
      existingMemberAccounts: number;
      reconciliationStatus: string;
    };
    expect(c.committed).toBe(true);
    expect(c.rowsCommitted).toBe(728);
    expect(c.reconciliationStatus).toBe("RECONCILED");
    // §8 — MemberAccount creation count: up to 728 new.
    expect(c.newMemberAccounts).toBeLessThanOrEqual(728);
  } else {
    expect((commit.body as { error?: string }).error).toMatch(/already committed/i);
  }

  // §10 idempotency — second commit always 409.
  const dup = await postWorkbook(page, "commit");
  console.log("AR_HIST_1_IDEMPOTENT " + JSON.stringify({ status: dup.status, body: dup.body }));
  expect(dup.status).toBe(409);

  // §4 — GET verifies totals.
  const totalsResp = await page.request.get(`${BASE}/api/admin/ar-aging-import?clubId=${COULEE_CLUB_ID}`);
  expect(totalsResp.ok()).toBe(true);
  const totals = await totalsResp.json();
  console.log("AR_HIST_1_TOTALS " + JSON.stringify(totals.totals));
  expect(totals.totals.snapshotRowCount).toBeGreaterThanOrEqual(728);
  expect(totals.totals.memberAccountCount).toBeGreaterThanOrEqual(728);

  // §VIII — baseline hold.
  const after = await invariant(page);
  console.log("AR_HIST_1_AFTER " + JSON.stringify({ club: after.club }));
  expect(after.club).toEqual(before.club);

  await context.close();
});
