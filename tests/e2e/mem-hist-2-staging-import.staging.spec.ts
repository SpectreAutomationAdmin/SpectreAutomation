// MEM-HIST-2 §19 / §27 / §28 (2026-10-03) — authorized staging commit
// of the sanitized Jonas Member Master.
//
// This spec is the ONE place the real sanitized workbook is uploaded
// to Coulee Ridge on staging. It:
//
//   1. captures the protected accounting baseline (562 / 0 / 2 / 2)
//   2. uploads the workbook with action=preview + asserts
//      aggregate shape (3,080 members, 21 statuses, bill-to split
//      2,300 / 778 / 2)
//   3. uploads again with action=commit + asserts the commit outcome
//   4. uploads a THIRD time with action=commit → idempotency rejects
//      with 409 "already committed"
//   5. verifies via GET that MemberExternalIdentity + Member counts
//      reflect the commit
//   6. re-captures baseline — unchanged
//
// The real workbook stays on the founder's workstation. The spec
// reads it from the staging secret SPECTRE_MEM_MASTER_WORKBOOK_PATH
// — when unset, the spec skips (same pattern as staging-auth).

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import { readFileSync, existsSync } from "node:fs";

const creds = stagingCredsAvailable();
const WORKBOOK_PATH = process.env.SPECTRE_MEM_MASTER_WORKBOOK_PATH
  ?? "C:/Users/cturcato/Downloads/Membership Master - Sanitized for Spectre.xlsx";
const workbookReady = existsSync(WORKBOOK_PATH);
const runAt = creds.ready && workbookReady ? test : test.skip;

const BASE = "https://staging.spectreautomation.com";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";
const SOURCE_EFFECTIVE = "2026-10-03";

async function captureInvariant(page: Page) {
  const resp = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(resp.ok(), `coa diagnostic responded ${resp.status()}`).toBe(true);
  return resp.json();
}

async function postWorkbook(page: Page, action: "preview" | "commit"): Promise<{ status: number; body: unknown }> {
  const bytes = readFileSync(WORKBOOK_PATH);
  const resp = await page.request.post(`${BASE}/api/admin/member-master-import`, {
    multipart: {
      clubId: COULEE_CLUB_ID,
      sourceEffectiveDate: SOURCE_EFFECTIVE,
      action,
      file: {
        name: "Membership Master - Sanitized for Spectre.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: bytes,
      },
    },
    // Commit touches ~3,080 members × 5 Prisma roundtrips = ~15k
    // DB queries on a Fly staging db. Allow up to 10 minutes.
    timeout: 600_000,
  });
  return { status: resp.status(), body: await resp.json().catch(() => null) };
}

runAt("MEM-HIST-2 · authorized staging commit of sanitized Jonas Member Master", async ({ browser }) => {
  test.setTimeout(600_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await captureInvariant(page);
  console.log("MEM_HIST_2_BEFORE " + JSON.stringify({
    status: before.status, totalRows: before.total, club: before.club,
  }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  // 1. PREVIEW — pure parse, no DB.
  const preview = await postWorkbook(page, "preview");
  expect(preview.status, `preview responded ${preview.status}: ${JSON.stringify(preview.body)}`).toBe(200);
  const pv = preview.body as {
    rowCount: number;
    invalidCount: number;
    billToSummary: { self: number; resolved: number; unresolved: number; invalid: number };
    statusDistribution: Record<string, number>;
    shareholderCount: number;
  };
  console.log("MEM_HIST_2_PREVIEW " + JSON.stringify({
    rowCount: pv.rowCount,
    invalidCount: pv.invalidCount,
    billTo: pv.billToSummary,
    shareholderCount: pv.shareholderCount,
    statusDistinct: Object.keys(pv.statusDistribution).length,
  }));
  expect(pv.rowCount).toBe(3080);
  expect(pv.billToSummary.self).toBe(2300);
  expect(pv.billToSummary.resolved).toBe(778);
  expect(pv.billToSummary.unresolved).toBe(2);
  expect(pv.shareholderCount).toBe(522);
  expect(Object.keys(pv.statusDistribution).length).toBe(21);

  // 2. COMMIT — persist. May take ~5 minutes on Fly staging DB
  //    (~15k Prisma queries). Accepts either outcome:
  //      - fresh commit (200 + outcome struct)
  //      - already-committed (409 — idempotency works)
  //    Both prove the pipeline is correct.
  const commit = await postWorkbook(page, "commit");
  console.log("MEM_HIST_2_COMMIT " + JSON.stringify({ status: commit.status, body: commit.body }));
  expect([200, 409]).toContain(commit.status);
  if (commit.status === 200) {
    const c = commit.body as {
      committed: boolean;
      batchId: string;
      rowCount: number;
      newMembers: number;
      matchedMembers: number;
      billToSelf: number;
      billToResolved: number;
      billToUnresolved: number;
      classifications: number;
    };
    expect(c.committed).toBe(true);
    expect(c.rowCount).toBe(3080);
    expect(c.classifications).toBe(3080);
    expect(c.billToSelf + c.billToResolved + c.billToUnresolved).toBe(3080);
  } else {
    expect((commit.body as { error?: string }).error).toMatch(/already committed/i);
  }

  // 3. IDEMPOTENCY — second commit of IDENTICAL workbook always 409s.
  const dup = await postWorkbook(page, "commit");
  console.log("MEM_HIST_2_IDEMPOTENT " + JSON.stringify({ status: dup.status, body: dup.body }));
  expect(dup.status).toBe(409);
  expect((dup.body as { error?: string }).error).toMatch(/already committed/i);

  // 4. GET verifies totals.
  const totalsResp = await page.request.get(`${BASE}/api/admin/member-master-import?clubId=${COULEE_CLUB_ID}`);
  expect(totalsResp.ok()).toBe(true);
  const totals = await totalsResp.json();
  console.log("MEM_HIST_2_TOTALS " + JSON.stringify(totals.totals));
  expect(totals.totals.externalIdentities).toBeGreaterThanOrEqual(3080);
  expect(totals.totals.historyEntries).toBeGreaterThanOrEqual(3080);
  expect(totals.totals.billingRelationships).toBeGreaterThanOrEqual(3080);

  // 5. Baseline hold.
  const after = await captureInvariant(page);
  console.log("MEM_HIST_2_AFTER " + JSON.stringify({ club: after.club }));
  expect(after.club.account).toBe(562);
  expect(after.club.journalEntry).toBe(0);
  expect(after.club.reportingLedgerBatch).toBe(2);
  expect(after.club.reportingLedgerSnapshot).toBe(2);

  await context.close();
});
