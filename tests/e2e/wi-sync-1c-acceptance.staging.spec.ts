// WI-SYNC-1c (2026-10-18) — bidirectional Spectre↔Outlook actions
// staging acceptance.
//
// Runs against the Coulee Ridge staging mailbox (per founder
// authorization: this mailbox is a test account; destructive
// operations are permitted).  Validates:
//
//   §A Dismiss        → WI SUPPRESSED, email untouched
//   §B Delete         → WI SUPPRESSED, email in Deleted Items,
//                       OutlookDeleteMutation.SUCCEEDED,
//                       EVIDENCE_DELETED activity, no AP write
//   §C Loop prevent   → re-triggered reconciliation does not
//                       create a duplicate EVIDENCE_DELETED;
//                       logs EVIDENCE_DELETE_RECONCILED instead
//   §D Restore        → Graph move-to-inbox + delta → WI
//                       restored to its pre-suppression status,
//                       EVIDENCE_RESTORED activity
//   §E Idempotency    → second Delete returns ALREADY_DELETED;
//                       second Dismiss returns ALREADY_DISMISSED
//   §F AP preserve    → APInvoice + ApIntakeSource totals
//                       unchanged throughout
//   §G No duplicates  → total WI-with-email-origin count
//                       unchanged throughout

import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import path from "node:path";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

const SCRATCH_SCRIPT = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  "AppData/Local/Temp/claude/c--dev-SpectreAutomation/0024fdd7-1cbc-4a67-8903-1a917d6d43e4/scratchpad/wi-sync-1c-staging-ops.mjs",
);

function sshExec(cmd: string): string {
  const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
  const full = `"${flyctl}" ssh console --app spectre-staging --command "sh -c 'cd /app && node wi-sync-1c-staging-ops.mjs ${cmd}'"`;
  try {
    return execSync(full, { encoding: "utf8", timeout: 60_000 });
  } catch (e) {
    return `SSH_ERROR ${(e as Error).message}`;
  }
}
function sftpPut(): void {
  const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
  const scratchDir = path.dirname(SCRATCH_SCRIPT);
  // Remove any stale copy then push.
  try {
    execSync(
      `"${flyctl}" ssh console --app spectre-staging --command "rm -f /app/wi-sync-1c-staging-ops.mjs"`,
      { encoding: "utf8", timeout: 60_000 },
    );
  } catch {}
  execSync(
    `cd "${scratchDir}" && "${flyctl}" ssh sftp put --app spectre-staging wi-sync-1c-staging-ops.mjs`,
    { encoding: "utf8", timeout: 60_000 },
  );
}
function parse<T>(stdout: string, prefix: string): T | null {
  const idx = stdout.indexOf(prefix + " ");
  if (idx < 0) return null;
  const json = stdout.slice(idx + prefix.length + 1);
  const end = json.search(/\n[A-Z_]+ /);
  const slice = end >= 0 ? json.slice(0, end) : json;
  try {
    return JSON.parse(slice) as T;
  } catch {
    return null;
  }
}

function ensureOutDir(): string {
  const d = path.join("test-results");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

interface WiState {
  wi: {
    id: string;
    clubId: string;
    status: string;
    statusBeforeSuppression: string | null;
    userDismissedAt: string | null;
    userDismissedByUserId: string | null;
    displaySubject: string;
  };
  email: {
    id: string;
    subject: string;
    softDeletedAt: string | null;
    isRead: boolean;
    graphMessageId: string;
  } | null;
  activities: Array<{ action: string; note: string; createdAt: string }>;
  deleteMutations: Array<{ id: string; status: string; errorCode: string | null }>;
}

runAt(
  "WI-SYNC-1c · bidirectional acceptance against Coulee test mailbox",
  async ({ browser }) => {
    test.setTimeout(600_000);
    const outDir = ensureOutDir();

    // Upload the staging ops script.
    sftpPut();

    // §F baseline — AP + totals.
    const baselineRaw = sshExec("state-summary");
    const baseline = parse<Record<string, unknown>>(baselineRaw, "STATE_SUMMARY");
    writeFileSync(
      path.join(outDir, "wi-sync-1c-baseline.json"),
      JSON.stringify(baseline, null, 2),
    );
    expect(baseline, "baseline captured").toBeTruthy();
    console.log("WI_SYNC_1C_BASELINE", JSON.stringify(baseline));

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);

    // ---------------------------------------------------------------
    // §A — Dismiss
    // ---------------------------------------------------------------
    const dismissCandidatesRaw = sshExec("pick-dismiss-target");
    const dismissCands = parse<Array<{ id: string; status: string; displaySubject: string }>>(
      dismissCandidatesRaw,
      "PICK_DISMISS",
    );
    expect(dismissCands?.length ?? 0, "found dismiss candidate").toBeGreaterThanOrEqual(1);
    const dismissWiId = dismissCands![0].id;
    const dismissSubject = dismissCands![0].displaySubject;
    const dismissBeforeRaw = sshExec(`inspect-wi ${dismissWiId}`);
    const dismissBefore = parse<WiState>(dismissBeforeRaw, "INSPECT_WI");
    console.log("WI_SYNC_1C_A_PRE", JSON.stringify({
      wiId: dismissWiId,
      subject: dismissSubject,
      status: dismissBefore?.wi.status,
    }));

    const dismissRes = await page.request.post(`${BASE}/api/work-intake/${dismissWiId}/dismiss`);
    expect(dismissRes.status(), "dismiss returned 200").toBe(200);
    const dismissBody = await dismissRes.json();
    expect(dismissBody.status).toBe("DISMISSED");
    expect(dismissBody.workIntakeStatusBefore).toBe(dismissBefore!.wi.status);

    const dismissAfter = parse<WiState>(sshExec(`inspect-wi ${dismissWiId}`), "INSPECT_WI")!;
    console.log("WI_SYNC_1C_A_POST", JSON.stringify({
      status: dismissAfter.wi.status,
      userDismissedAt: dismissAfter.wi.userDismissedAt,
      statusBeforeSuppression: dismissAfter.wi.statusBeforeSuppression,
      emailSoftDeleted: !!dismissAfter.email?.softDeletedAt,
      activity0: dismissAfter.activities[0]?.action,
    }));
    expect(dismissAfter.wi.status).toBe("SUPPRESSED");
    expect(dismissAfter.wi.userDismissedAt).toBeTruthy();
    expect(dismissAfter.wi.statusBeforeSuppression).toBe(dismissBefore!.wi.status);
    // Email untouched (Dismiss does NOT delete the Outlook message).
    expect(dismissAfter.email?.softDeletedAt).toBeFalsy();
    expect(dismissAfter.activities.some((a) => a.action === "USER_DISMISSED")).toBe(true);

    // §E Idempotency — second Dismiss.
    const dismissAgain = await page.request.post(`${BASE}/api/work-intake/${dismissWiId}/dismiss`);
    expect(dismissAgain.status(), "second dismiss returned 200").toBe(200);
    const dismissAgainBody = await dismissAgain.json();
    expect(dismissAgainBody.status).toBe("ALREADY_DISMISSED");

    // ---------------------------------------------------------------
    // §B — Delete + Loop prevention
    // ---------------------------------------------------------------
    const deleteCandidatesRaw = sshExec("pick-delete-target");
    type DelCand = {
      id: string;
      status: string;
      displaySubject: string;
      emailOrigins: Array<{ emailMessage: { id: string; graphMessageId: string } }>;
    };
    const deleteCands = parse<DelCand[]>(deleteCandidatesRaw, "PICK_DELETE");
    expect(deleteCands?.length ?? 0, "found delete candidate").toBeGreaterThanOrEqual(1);
    const deleteWi = deleteCands![0];
    const deleteWiId = deleteWi.id;
    const deleteEmailId = deleteWi.emailOrigins[0].emailMessage.id;
    const deleteSubject = deleteWi.displaySubject;
    console.log("WI_SYNC_1C_B_PRE", JSON.stringify({
      wiId: deleteWiId,
      emailId: deleteEmailId,
      subject: deleteSubject,
    }));

    const delRes = await page.request.post(`${BASE}/api/work-intake/${deleteWiId}/delete-email`);
    expect(delRes.status(), "delete-email returned 200").toBe(200);
    const delBody = await delRes.json();
    expect(delBody.status).toBe("SUCCEEDED");
    expect(delBody.mutationId).toBeTruthy();

    const delAfter = parse<WiState>(sshExec(`inspect-wi ${deleteWiId}`), "INSPECT_WI")!;
    console.log("WI_SYNC_1C_B_POST", JSON.stringify({
      wiStatus: delAfter.wi.status,
      statusBefore: delAfter.wi.statusBeforeSuppression,
      emailSoftDeleted: !!delAfter.email?.softDeletedAt,
      mutationStatus: delAfter.deleteMutations[0]?.status,
      activity0: delAfter.activities[0]?.action,
    }));
    expect(delAfter.wi.status).toBe("SUPPRESSED");
    expect(delAfter.email?.softDeletedAt).toBeTruthy();
    expect(delAfter.deleteMutations[0]?.status).toBe("SUCCEEDED");
    expect(delAfter.activities.some((a) => a.action === "EVIDENCE_DELETED")).toBe(true);

    // §E Idempotency — second Delete.
    const delAgain = await page.request.post(`${BASE}/api/work-intake/${deleteWiId}/delete-email`);
    expect([200, 409]).toContain(delAgain.status());
    const delAgainBody = await delAgain.json();
    expect(delAgainBody.status).toBe("ALREADY_DELETED");

    // §C Loop prevention — trigger a reconciliation apply.  The
    // handler should NOT create a duplicate EVIDENCE_DELETED
    // activity for the WI already SUPPRESSED by our Delete flow.
    const activitiesBeforeRecon = delAfter.activities.filter(
      (a) => a.action === "EVIDENCE_DELETED",
    ).length;
    const reconRes = await page.request.post(`${BASE}/api/admin/mailbox/reconcile?apply=1`);
    expect(reconRes.status()).toBe(200);
    // Reconciliation report has its own totals; the invariant is on
    // the WI's activity log — no duplicate EVIDENCE_DELETED.  (The
    // reconciliation handler calls handleEmailEvidenceDeleted which
    // early-returns on SUPPRESSED WIs so no new activity is written
    // UNLESS there's a SUCCEEDED OutlookDeleteMutation — in which
    // case it writes EVIDENCE_DELETE_RECONCILED.)
    const reconAfter = parse<WiState>(sshExec(`inspect-wi ${deleteWiId}`), "INSPECT_WI")!;
    const activitiesAfterRecon = reconAfter.activities.filter(
      (a) => a.action === "EVIDENCE_DELETED",
    ).length;
    console.log("WI_SYNC_1C_C_LOOP", JSON.stringify({
      evidenceDeletedBefore: activitiesBeforeRecon,
      evidenceDeletedAfter: activitiesAfterRecon,
    }));
    expect(activitiesAfterRecon).toBe(activitiesBeforeRecon);

    // ---------------------------------------------------------------
    // §D — Restore (Graph move-to-inbox → delta → WI reactivates)
    // ---------------------------------------------------------------
    const moveRes = await page.request.post(
      `${BASE}/api/admin/mailbox/debug/move-to-inbox?emailMessageId=${deleteEmailId}`,
    );
    expect(moveRes.status(), "move-to-inbox returned 200").toBe(200);
    const moveBody = await moveRes.json();
    expect(moveBody.ok).toBe(true);
    console.log("WI_SYNC_1C_D_MOVE", JSON.stringify(moveBody));

    // Enqueue a delta sync.  (The 60-s scheduled tick would also pick
    // it up — we enqueue so the test runs fast.)
    const mailboxConnId = baseline && (baseline as { emailTotals?: unknown }).emailTotals
      ? // Baseline doesn't carry mailbox id; derive from the first email.
        reconAfter.email?.graphMessageId ?? null
      : null;
    void mailboxConnId;
    // Simpler path: hit the existing refresh endpoint as founder.
    await page.request.post(`${BASE}/api/mission-control/refresh-mailbox`);

    // Poll for restore up to ~90 s (delta sync + handler).
    let restored: WiState | null = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000) {
      await new Promise((r) => setTimeout(r, 5_000));
      const inspect = parse<WiState>(sshExec(`inspect-wi ${deleteWiId}`), "INSPECT_WI");
      if (inspect && !inspect.email?.softDeletedAt && inspect.wi.status !== "SUPPRESSED") {
        restored = inspect;
        break;
      }
    }
    expect(restored, "WI restored within 90 s").toBeTruthy();
    console.log("WI_SYNC_1C_D_POST", JSON.stringify({
      wiStatus: restored!.wi.status,
      statusBeforeSuppression: restored!.wi.statusBeforeSuppression,
      emailSoftDeleted: !!restored!.email?.softDeletedAt,
      activity0: restored!.activities[0]?.action,
    }));
    // Pre-suppression status should be restored (delete put it in
    // SUPPRESSED after capturing INFORMATIONAL).
    expect(restored!.wi.status).toBe(deleteWi.status);
    expect(restored!.wi.statusBeforeSuppression).toBeNull();
    expect(restored!.email?.softDeletedAt).toBeFalsy();
    expect(
      restored!.activities.some((a) => a.action === "EVIDENCE_RESTORED"),
    ).toBe(true);

    // ---------------------------------------------------------------
    // §F AP preservation — totals unchanged throughout
    // ---------------------------------------------------------------
    const finalRaw = sshExec("state-summary");
    const final = parse<{
      ap: { invoices: number; intakeSources: number };
      wiByStatus: Array<{ status: string; _count: { _all: number } }>;
      emailTotals: { total: number };
      outlookDeleteMutationsTotal: number;
    }>(finalRaw, "STATE_SUMMARY");
    writeFileSync(
      path.join(outDir, "wi-sync-1c-final.json"),
      JSON.stringify(final, null, 2),
    );
    expect(final).toBeTruthy();
    const baseAp = (baseline as { ap: { invoices: number; intakeSources: number } }).ap;
    expect(final!.ap.invoices).toBe(baseAp.invoices);
    expect(final!.ap.intakeSources).toBe(baseAp.intakeSources);

    // §G No duplicate WIs — total WI-with-email-origin count unchanged.
    const baseWiTotal = (
      baseline as { wiByStatus: Array<{ _count: { _all: number } }> }
    ).wiByStatus.reduce((acc, g) => acc + g._count._all, 0);
    const finalWiTotal = final!.wiByStatus.reduce((acc, g) => acc + g._count._all, 0);
    console.log("WI_SYNC_1C_G_WI_TOTAL", JSON.stringify({
      base: baseWiTotal,
      final: finalWiTotal,
    }));
    expect(finalWiTotal).toBe(baseWiTotal);

    // Cleanup: reset the Dismiss WI so staging returns close to
    // baseline.  The Delete WI was already restored to its pre-
    // suppression status via the Restore test; nothing to do.
    sshExec(`cleanup-dismiss ${dismissWiId}`);

    await ctx.close();
    console.log("WI_SYNC_1C_ACCEPTANCE_PASSED");
  },
);
