// WI-SYNC-1f (2026-10-18) — Final verification for WI-SYNC-1a..1e
// closure. Addresses the founder's three outstanding items:
//   (1) Valid synthetic AP preservation — per-record assertions
//       across Archive / Delete / Restore.
//   (2) Notification + fallback telemetry — 12-event controlled
//       sample with BackgroundJob attribution per event.
//   (3) Restore via Mission Control — real browser click-through
//       on the Work Intake detail page where the Restore button
//       is now rendered.

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

const OPS_LOCAL = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  "AppData/Local/Temp/claude/c--dev-SpectreAutomation/0024fdd7-1cbc-4a67-8903-1a917d6d43e4/scratchpad/wi-sync-1f-ops.mjs",
);

function sshExec(cmd: string): string {
  const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
  const full = `"${flyctl}" ssh console --app spectre-staging --command "sh -c 'cd /app && node wi-sync-1f-ops.mjs ${cmd}'"`;
  try {
    return execSync(full, { encoding: "utf8", timeout: 120_000 });
  } catch (e) {
    return `SSH_ERROR ${(e as Error).message}`;
  }
}

function parse<T>(stdout: string, prefix: string): T | null {
  const idx = stdout.indexOf(prefix + " ");
  if (idx < 0) return null;
  const body = stdout.slice(idx + prefix.length + 1);
  const next = body.search(/\n[A-Z_]+ /);
  const slice = next >= 0 ? body.slice(0, next) : body;
  try { return JSON.parse(slice) as T; } catch { return null; }
}

function ensureOutDir(): string {
  const d = path.join("test-results");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function uploadOps(): void {
  const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
  const dir = path.dirname(OPS_LOCAL);
  try {
    execSync(
      `"${flyctl}" ssh console --app spectre-staging --command "rm -f /app/wi-sync-1f-ops.mjs"`,
      { encoding: "utf8", timeout: 60_000 },
    );
  } catch {}
  execSync(
    `cd "${dir}" && "${flyctl}" ssh sftp put --app spectre-staging wi-sync-1f-ops.mjs`,
    { encoding: "utf8", timeout: 60_000 },
  );
}

async function waitUntil<T>(
  check: () => Promise<T | null>,
  acceptable: (v: T) => boolean,
  timeoutMs: number,
  pollMs = 3_000,
): Promise<{ ok: boolean; value: T | null; elapsedMs: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await check();
    if (v && acceptable(v)) return { ok: true, value: v, elapsedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, value: null, elapsedMs: Date.now() - t0 };
}

async function postJson(page: Page, url: string): Promise<{ status: number; body: unknown }> {
  const res = await page.request.post(url);
  const status = res.status();
  let body: unknown = null;
  try { body = await res.json(); } catch { try { body = await res.text(); } catch {} }
  return { status, body };
}

runAt(
  "WI-SYNC-1f · final verification — valid AP preservation + notification telemetry + Restore via Mission Control",
  async ({ browser }) => {
    test.setTimeout(1_800_000); // 30 min
    const outDir = ensureOutDir();
    uploadOps();

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);

    // ======= Baseline =============================================
    const baseline = parse<Record<string, unknown>>(sshExec("state-summary"), "STATE_SUMMARY")!;
    writeFileSync(path.join(outDir, "wi-sync-1f-baseline.json"), JSON.stringify(baseline, null, 2));
    expect(baseline).toBeTruthy();

    // ============================================================
    // ITEM 1 — Valid synthetic AP preservation (per-record)
    // ============================================================
    const vendor = parse<{ id: string; legalName: string }>(sshExec("pick-vendor"), "PICK_VENDOR");
    const expenseAccount = parse<{ id: string; accountNumber: string; name: string }>(
      sshExec("pick-expense-account"), "PICK_EXPENSE_ACCOUNT",
    );
    const target = parse<{
      workIntakeItemId: string | null;
      primaryEmail: { id: string; isRead: boolean; subject: string } | null;
    }>(sshExec("pick-active-email-origin-wi"), "PICK_ACTIVE")!;

    expect(vendor?.id, "a non-DRAFT vendor exists in Coulee").toBeTruthy();
    expect(expenseAccount?.id, "a postable EXPENSE account exists in Coulee").toBeTruthy();
    expect(target.workIntakeItemId, "active email-backed WI target exists").toBeTruthy();
    expect(target.primaryEmail?.id, "target email id").toBeTruthy();

    const apTargetWi = target.workIntakeItemId!;
    const apTargetEmail = target.primaryEmail!.id;

    const apCreate = parse<{
      invoiceId: string | null;
      lineId: string | null;
      approvalId: string | null;
      intakeSourceId: string | null;
    }>(
      sshExec(`create-valid-ap ${apTargetEmail} ${vendor!.id} ${expenseAccount!.id}`),
      "CREATE_VALID_AP",
    );
    writeFileSync(path.join(outDir, "wi-sync-1f-ap-create.json"), JSON.stringify(apCreate, null, 2));
    expect(apCreate?.invoiceId, "APInvoice created").toBeTruthy();
    expect(apCreate?.lineId, "APInvoiceLine created").toBeTruthy();
    expect(apCreate?.approvalId, "ApprovalRequest created").toBeTruthy();
    const invoiceId = apCreate!.invoiceId!;

    const snap0 = parse<{
      invoice: {
        id: string; status: string; total: string; subtotal: string; taxTotal: string;
        invoiceNumber: string; vendorId: string; approvalRequestId: string | null;
        postedJournalEntryId: string | null; voidedAt: string | null;
        lines: Array<{ id: string; amount: string; taxAmount: string; lineNumber: number }>;
      };
      approval: { id: string; status: string; amount: string };
      totals: { invoices: number; lines: number; intakeSources: number; approvalRequests: number };
    }>(sshExec(`assert-ap-detail ${invoiceId}`), "ASSERT_AP_DETAIL")!;
    const baselineLinesCount = snap0.invoice.lines.length;
    const baselineTotal = snap0.invoice.total;
    const baselineApprovalStatus = snap0.approval.status;
    const baselineInvoiceStatus = snap0.invoice.status;
    writeFileSync(path.join(outDir, "wi-sync-1f-ap-snap-0.json"), JSON.stringify(snap0, null, 2));
    console.log("ITEM1_BASELINE", JSON.stringify({
      invoiceStatus: baselineInvoiceStatus, total: baselineTotal, lines: baselineLinesCount,
      approvalStatus: baselineApprovalStatus,
    }));

    // --- Archive ---------------------------------------------------
    const archiveResp = await postJson(page, `${BASE}/api/work-intake/${apTargetWi}/archive-email`);
    expect(archiveResp.status, "archive-email → 200").toBe(200);
    await new Promise((r) => setTimeout(r, 10_000));
    const snap1 = parse<typeof snap0>(sshExec(`assert-ap-detail ${invoiceId}`), "ASSERT_AP_DETAIL")!;
    writeFileSync(path.join(outDir, "wi-sync-1f-ap-snap-1-after-archive.json"), JSON.stringify(snap1, null, 2));
    expect(snap1.invoice, "APInvoice survives archive").toBeTruthy();
    expect(snap1.invoice.id).toBe(invoiceId);
    expect(snap1.invoice.status).toBe(baselineInvoiceStatus);
    expect(snap1.invoice.total).toBe(baselineTotal);
    expect(snap1.invoice.lines.length).toBe(baselineLinesCount);
    expect(snap1.invoice.postedJournalEntryId).toBe(null);
    expect(snap1.invoice.voidedAt).toBe(null);
    expect(snap1.approval.status).toBe(baselineApprovalStatus);
    console.log("ITEM1_AFTER_ARCHIVE", JSON.stringify({ status: snap1.invoice.status, approval: snap1.approval.status }));

    // --- Delete ----------------------------------------------------
    const delResp = await postJson(page, `${BASE}/api/work-intake/${apTargetWi}/delete-email`);
    expect(delResp.status, "delete-email → 200").toBe(200);
    await new Promise((r) => setTimeout(r, 15_000));
    const snap2 = parse<typeof snap0>(sshExec(`assert-ap-detail ${invoiceId}`), "ASSERT_AP_DETAIL")!;
    writeFileSync(path.join(outDir, "wi-sync-1f-ap-snap-2-after-delete.json"), JSON.stringify(snap2, null, 2));
    expect(snap2.invoice, "APInvoice survives delete").toBeTruthy();
    expect(snap2.invoice.id).toBe(invoiceId);
    expect(snap2.invoice.status).toBe(baselineInvoiceStatus);
    expect(snap2.invoice.total).toBe(baselineTotal);
    expect(snap2.invoice.lines.length).toBe(baselineLinesCount);
    expect(snap2.invoice.postedJournalEntryId).toBe(null);
    expect(snap2.invoice.voidedAt).toBe(null);
    expect(snap2.approval.status).toBe(baselineApprovalStatus);
    expect(snap2.totals.invoices).toBe(snap0.totals.invoices);
    expect(snap2.totals.lines).toBe(snap0.totals.lines);
    expect(snap2.totals.intakeSources).toBe(snap0.totals.intakeSources);
    expect(snap2.totals.approvalRequests).toBe(snap0.totals.approvalRequests);
    console.log("ITEM1_AFTER_DELETE", JSON.stringify({ status: snap2.invoice.status, approval: snap2.approval.status }));

    // --- Restore ---------------------------------------------------
    await postJson(page, `${BASE}/api/admin/mailbox/debug/move-to-inbox?emailMessageId=${apTargetEmail}`);
    const restoreWait = await waitUntil(
      async () => parse<{ wi: { status: string }; email: { softDeletedAt: string | null } | null }>(
        sshExec(`inspect-wi ${apTargetWi}`),
        "INSPECT_WI",
      ),
      (v) => !v.email?.softDeletedAt && v.wi.status !== "SUPPRESSED",
      120_000,
    );
    expect(restoreWait.ok, "WI restored out of SUPPRESSED").toBe(true);
    const snap3 = parse<typeof snap0>(sshExec(`assert-ap-detail ${invoiceId}`), "ASSERT_AP_DETAIL")!;
    writeFileSync(path.join(outDir, "wi-sync-1f-ap-snap-3-after-restore.json"), JSON.stringify(snap3, null, 2));
    expect(snap3.invoice).toBeTruthy();
    expect(snap3.invoice.id).toBe(invoiceId);
    expect(snap3.invoice.status).toBe(baselineInvoiceStatus);
    expect(snap3.invoice.total).toBe(baselineTotal);
    expect(snap3.invoice.lines.length).toBe(baselineLinesCount);
    expect(snap3.approval.status).toBe(baselineApprovalStatus);

    // --- Cleanup --------------------------------------------------
    const cleanup = parse<{ ok: boolean; invoiceId: string }>(
      sshExec(`cleanup-valid-ap ${invoiceId}`), "CLEANUP_VALID_AP",
    );
    writeFileSync(path.join(outDir, "wi-sync-1f-ap-cleanup.json"), JSON.stringify(cleanup, null, 2));
    expect(cleanup?.ok, "cleanup removed synthetic AP").toBe(true);
    console.log("ITEM1_PASS");

    // ============================================================
    // ITEM 2 — Notification + fallback telemetry (12 events)
    // ============================================================
    const picked = parse<{ id: string; subject: string }>(
      sshExec("pick-soft-deleted-email"), "PICK_SOFT_DELETED",
    );
    expect(picked?.id, "latency target email exists").toBeTruthy();
    const emailId = picked!.id;
    const linkedWi = parse<{ workIntakeItemId: string | null }>(
      sshExec(`find-wi-for-email ${emailId}`), "FIND_WI_FOR_EMAIL",
    )!.workIntakeItemId!;
    expect(linkedWi).toBeTruthy();

    type Event = {
      i: number; action: "restore" | "delete"; T0: number;
      stateFlippedMs: number | null;
      jobsInWindow: Array<{ source: string; createdAt: string; status: string }>;
      webhookJobs: number;
      pollJobs: number;
      beforeLastNotificationAt: string | null;
      afterLastNotificationAt: string | null;
      lastNotificationBumped: boolean;
      classification: string;
    };
    const events: Event[] = [];
    let currentState: "deleted" | "inbox" = "deleted";
    const TOTAL_EVENTS = 12;

    for (let i = 0; i < TOTAL_EVENTS; i++) {
      const action: "restore" | "delete" = currentState === "deleted" ? "restore" : "delete";
      const subBefore = parse<{ lastNotificationAt: string | null }>(sshExec("latest-sub"), "LATEST_SUB")!;
      const T0 = Date.now();
      const mut = action === "restore"
        ? await postJson(page, `${BASE}/api/admin/mailbox/debug/move-to-inbox?emailMessageId=${emailId}`)
        : await postJson(page, `${BASE}/api/work-intake/${linkedWi}/delete-email`);
      if (mut.status !== 200) {
        console.log(`ITEM2_event_${i + 1}_mut_fail`, mut.status, mut.body);
        break;
      }
      // Wait up to 180s for the EmailMessage state to flip.
      const flip = await waitUntil(
        async () => parse<{ email: { softDeletedAt: string | null } | null }>(
          sshExec(`inspect-wi ${linkedWi}`), "INSPECT_WI",
        ),
        (v) => action === "restore"
          ? !v.email?.softDeletedAt
          : !!v.email?.softDeletedAt,
        180_000,
      );
      const stateFlippedMs = flip.ok ? flip.elapsedMs : null;

      // Query BackgroundJob rows in [T0, now].
      const jobs = parse<{
        count: number;
        rows: Array<{ source: string; status: string; createdAt: string; idemKey: string }>;
      }>(sshExec(`job-window ${T0} ${Date.now()}`), "JOB_WINDOW")!;
      const webhookJobs = jobs.rows.filter((r) => r.source === "WEBHOOK").length;
      const pollJobs = jobs.rows.filter((r) => r.source === "POLL").length;
      const subAfter = parse<{ lastNotificationAt: string | null }>(sshExec("latest-sub"), "LATEST_SUB")!;
      const bumped = subAfter.lastNotificationAt !== subBefore.lastNotificationAt;

      let classification = "";
      if (webhookJobs > 0 && bumped && flip.ok) classification = "GRAPH_DELIVERED_SPECTRE_PROCESSED_FLIP_OK";
      else if (webhookJobs > 0 && !bumped) classification = "GRAPH_DELIVERED_UPDATE_RACE";
      else if (webhookJobs === 0 && pollJobs > 0 && flip.ok) classification = "NOTIFICATION_MISSED_POLL_RECOVERED";
      else if (webhookJobs === 0 && pollJobs === 0 && flip.ok) classification = "NO_JOB_SEEN_BUT_FLIPPED";
      else classification = "NEITHER_DELIVERED";

      events.push({
        i: i + 1, action, T0, stateFlippedMs,
        jobsInWindow: jobs.rows.map((r) => ({ source: r.source, createdAt: r.createdAt, status: r.status })),
        webhookJobs, pollJobs,
        beforeLastNotificationAt: subBefore.lastNotificationAt,
        afterLastNotificationAt: subAfter.lastNotificationAt,
        lastNotificationBumped: bumped,
        classification,
      });
      console.log(`ITEM2_event_${i + 1}`, JSON.stringify({
        action, stateFlippedMs, webhookJobs, pollJobs, bumped, classification,
      }));
      currentState = action === "restore" ? "inbox" : "deleted";
      // Brief settle before next event — matches the cadence a human would use.
      await new Promise((r) => setTimeout(r, 7_000));
    }

    const landed = events.filter((e) => e.classification === "GRAPH_DELIVERED_SPECTRE_PROCESSED_FLIP_OK");
    const recovered = events.filter((e) => e.classification === "NOTIFICATION_MISSED_POLL_RECOVERED");
    const race = events.filter((e) => e.classification === "GRAPH_DELIVERED_UPDATE_RACE");
    const stillMissing = events.filter((e) => e.classification === "NEITHER_DELIVERED");
    const anomaly = events.filter((e) => e.classification === "NO_JOB_SEEN_BUT_FLIPPED");

    const flipMs = events.map((e) => e.stateFlippedMs).filter((v): v is number => v != null).sort((a, b) => a - b);
    const latency = {
      events,
      totalEvents: events.length,
      graphDeliveredAndProcessed: landed.length,
      graphDeliveredUpdateRace: race.length,
      notificationMissedPollRecovered: recovered.length,
      neitherDelivered: stillMissing.length,
      noJobSeenAnomaly: anomaly.length,
      flipLatency: {
        fastestMs: flipMs[0] ?? null,
        medianMs: flipMs[Math.floor(flipMs.length / 2)] ?? null,
        slowestMs: flipMs[flipMs.length - 1] ?? null,
        p90Ms: flipMs[Math.floor(flipMs.length * 0.9)] ?? null,
      },
      // Spectre's actual production cadences (from env defaults).
      productionCadence: {
        deltaPollerIntervalMs: 60_000,
        deltaPollerMinGapMs: 30_000,
        fullReconciliationIntervalMs: 15 * 60_000,
      },
    };
    writeFileSync(path.join(outDir, "wi-sync-1f-latency.json"), JSON.stringify(latency, null, 2));
    console.log("ITEM2_SUMMARY", JSON.stringify({
      total: events.length,
      graphDeliveredAndProcessed: landed.length,
      graphDeliveredUpdateRace: race.length,
      notificationMissedPollRecovered: recovered.length,
      neitherDelivered: stillMissing.length,
      medianFlipMs: latency.flipLatency.medianMs,
    }));
    // The acceptance bar: no event may end up in NEITHER_DELIVERED
    // (that would indicate correctness regression — Spectre failed
    // to converge).  The breakdown of race vs delivered vs
    // poll-recovered is informational, not pass/fail.
    expect(stillMissing.length, "every event converged via notification OR poll").toBe(0);
    console.log("ITEM2_PASS");

    // ============================================================
    // ITEM 3 — Restore via Mission Control (real browser click)
    // ============================================================
    // Pick a WI that is currently SUPPRESSED + softDeleted so the
    // Restore button renders.  If none exists, create one by
    // deleting an active email first.
    let suppressed = parse<{
      workIntakeItemId: string | null;
      primaryEmail: { id: string } | null;
    }>(sshExec("pick-wi-in-suppressed-state"), "PICK_SUPPRESSED");

    let item3Wi: string;
    let item3Email: string;
    if (!suppressed?.workIntakeItemId) {
      const freshActive = parse<{
        workIntakeItemId: string | null;
        primaryEmail: { id: string } | null;
      }>(sshExec("pick-active-email-origin-wi"), "PICK_ACTIVE")!;
      expect(freshActive.workIntakeItemId, "fallback active WI target").toBeTruthy();
      item3Wi = freshActive.workIntakeItemId!;
      item3Email = freshActive.primaryEmail!.id;
      const r = await postJson(page, `${BASE}/api/work-intake/${item3Wi}/delete-email`);
      expect(r.status).toBe(200);
      const sw = await waitUntil(
        async () => parse<{ wi: { status: string }; email: { softDeletedAt: string | null } | null }>(
          sshExec(`inspect-wi ${item3Wi}`), "INSPECT_WI",
        ),
        (v) => v.wi.status === "SUPPRESSED" && !!v.email?.softDeletedAt,
        180_000,
      );
      expect(sw.ok, "fresh WI entered SUPPRESSED+softDeleted").toBe(true);
    } else {
      item3Wi = suppressed.workIntakeItemId!;
      item3Email = suppressed.primaryEmail!.id;
    }
    console.log("ITEM3_target", JSON.stringify({ wi: item3Wi, email: item3Email }));

    // Navigate to the WI detail page.
    await page.goto(`${BASE}/app/admin/work-intake/${item3Wi}`, {
      waitUntil: "domcontentloaded", timeout: 60_000,
    });
    await page.waitForTimeout(2_000);

    // The MailboxActionsRow is rendered in the Email evidence card.
    const row = page.locator('[data-testid="mailbox-actions-row"]').first();
    await row.waitFor({ state: "visible", timeout: 15_000 });
    const restoreBtn = row.locator('[data-testid="mailbox-action-restore"]');
    const restoreVisible = (await restoreBtn.count()) > 0 && (await restoreBtn.first().isVisible());
    expect(restoreVisible, "Restore button renders on a suppressed-by-delete WI").toBe(true);
    await page.screenshot({
      path: path.join(outDir, "wi-sync-1f-item3-restore-visible.png"),
      fullPage: false,
    });
    console.log("ITEM3_restore_button_visible", restoreVisible);

    // Click Restore through the UI.
    await restoreBtn.first().click();
    // The restore handler kicks off a Graph move-to-inbox + delta
    // sync, which can take 10–30 s.  Wait for state to flip.
    const restoredFlip = await waitUntil(
      async () => parse<{ wi: { status: string }; email: { softDeletedAt: string | null } | null }>(
        sshExec(`inspect-wi ${item3Wi}`), "INSPECT_WI",
      ),
      (v) => v.wi.status !== "SUPPRESSED" && !v.email?.softDeletedAt,
      180_000,
    );
    expect(restoredFlip.ok, "WI status + email softDeletedAt both cleared").toBe(true);

    // Also validate the Outlook message is back in Inbox (Graph
    // getWellKnownFolder-ish check — we observe it via the
    // probeMessage pipeline that produces PRESENT_INBOX, which is
    // reflected in the EmailMessage no longer being softDeleted).
    const postRestore = parse<{ wi: { status: string }; email: { softDeletedAt: string | null } | null }>(
      sshExec(`inspect-wi ${item3Wi}`), "INSPECT_WI",
    )!;
    writeFileSync(
      path.join(outDir, "wi-sync-1f-item3-post-restore.json"),
      JSON.stringify(postRestore, null, 2),
    );
    expect(postRestore.wi.status).not.toBe("SUPPRESSED");
    expect(postRestore.email?.softDeletedAt).toBeFalsy();
    await page.screenshot({
      path: path.join(outDir, "wi-sync-1f-item3-after-restore.png"),
      fullPage: false,
    });
    console.log("ITEM3_PASS", JSON.stringify({
      wiStatus: postRestore.wi.status,
      emailSoftDeletedAt: postRestore.email?.softDeletedAt,
      flipMs: restoredFlip.elapsedMs,
    }));

    // ======= Final ================================================
    const finalState = parse<Record<string, unknown>>(sshExec("state-summary"), "STATE_SUMMARY")!;
    writeFileSync(path.join(outDir, "wi-sync-1f-final.json"), JSON.stringify(finalState, null, 2));
    const b = baseline as { ap: { invoices: number; intakeSources: number; approvalRequests: number } };
    const f = finalState as { ap: { invoices: number; intakeSources: number; approvalRequests: number } };
    expect(f.ap.invoices, "AP invoices unchanged post-cleanup").toBe(b.ap.invoices);
    expect(f.ap.intakeSources, "AP intake sources unchanged post-cleanup").toBe(b.ap.intakeSources);
    expect(f.ap.approvalRequests, "AP approval requests unchanged post-cleanup").toBe(b.ap.approvalRequests);
    console.log("WI_SYNC_1F_FINAL_VERIFICATION_PASSED");

    await ctx.close();
  },
);
