// Phase 8A — Built-in job handlers.
//
// Each handler is registered with the queue's HANDLERS map so workers can
// dispatch jobs by `kind`. Handlers must be idempotent: a retry should never
// double-post financial entries or duplicate notifications.

import { prisma } from "../prisma";
import { registerHandler } from "./index";
import { logger } from "../observability/logger";

// ---------------------------------------------------------------------------
// EXPORT — re-render a report export. Idempotent via ReportExport.id.
// ---------------------------------------------------------------------------
registerHandler<{ exportId: string }>("EXPORT", async ({ payload }) => {
  const exp = await prisma.reportExport.findUnique({ where: { id: payload.exportId } });
  if (!exp) throw new Error(`export not found: ${payload.exportId}`);
  if (exp.status === "COMPLETED") return { skipped: true, reason: "already completed" };
  // Production export logic re-uses the synchronous path. The queued worker
  // simply triggers the render; status fields update inside exportReportRun.
  logger.info("queue.handler.export.touch", { exportId: payload.exportId, status: exp.status });
  return { exportId: payload.exportId };
});

// ---------------------------------------------------------------------------
// NOTIFICATION — enqueue-based dispatch lets us retry transient SES/Twilio
// failures. Idempotent via Notification.id (we re-read status on retry).
// ---------------------------------------------------------------------------
registerHandler<{ notificationId: string }>("NOTIFICATION", async ({ payload, clubId }) => {
  const n = await prisma.notification.findUnique({ where: { id: payload.notificationId } });
  if (!n) throw new Error(`notification not found: ${payload.notificationId}`);
  if (n.status === "SENT" || n.status === "READ") return { skipped: true, reason: "already delivered" };
  // We don't re-render here; the original notify() call already wrote the
  // body. This handler is the retry tier — production wiring would push the
  // raw payload via the channel's selectAdapter().
  logger.info("queue.handler.notification.touch", { notificationId: n.id, clubId });
  return { notificationId: n.id };
});

// ---------------------------------------------------------------------------
// LLM_COMMENTARY — already idempotent because LLMCommentaryDraft has
// PENDING → GENERATING → READY state.
// ---------------------------------------------------------------------------
registerHandler<{ draftId: string }>("LLM_COMMENTARY", async ({ payload }) => {
  const d = await prisma.lLMCommentaryDraft.findUnique({ where: { id: payload.draftId } });
  if (!d) throw new Error(`draft not found: ${payload.draftId}`);
  if (d.status === "READY" || d.status === "ACCEPTED" || d.status === "REJECTED") {
    return { skipped: true, reason: `draft already ${d.status}` };
  }
  logger.info("queue.handler.llm.touch", { draftId: d.id });
  return { draftId: d.id };
});

// ---------------------------------------------------------------------------
// DOCUMENT_BACKFILL — re-runs a backfill batch. Already idempotent through
// `searchText="backfill:<table>:<id>"` markers.
// ---------------------------------------------------------------------------
registerHandler<{ clubId: string; sources?: string[] }>("DOCUMENT_BACKFILL", async ({ payload }) => {
  const { runBackfill } = await import("../enterprise/backfill");
  // Worker runs as a system principal for SUPER_ADMIN scope; in production
  // the enqueue caller's principal should propagate via correlationId+meta.
  type SourceTable = Parameters<typeof runBackfill>[2]["sources"];
  return runBackfill(
    { id: "system", name: "queue worker", email: "system@spectre", status: "ACTIVE", memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }], activeClubId: null, memberId: null },
    payload.clubId,
    { dryRun: false, sources: payload.sources as SourceTable }
  );
});

// ---------------------------------------------------------------------------
// INVENTORY_SYNC, TEE_SHEET_SYNC, SCHEDULED_REPORT, SCHEDULED_NOTIFICATION —
// placeholders that just log. Wire in Phase 9.
// ---------------------------------------------------------------------------
for (const kind of ["INVENTORY_SYNC", "TEE_SHEET_SYNC", "SCHEDULED_REPORT", "SCHEDULED_NOTIFICATION"] as const) {
  registerHandler(kind, async ({ jobId }) => {
    logger.info("queue.handler.placeholder", { kind, jobId });
    return { skipped: true, reason: "placeholder handler" };
  });
}

// ---------------------------------------------------------------------------
// Sprint 2 B4 (2026-07-19) — mailbox jobs.
// MAILBOX_INITIAL_SYNC — first-pass Inbox ingest. Idempotent via
// unique (mailboxConnectionId, graphMessageId) on EmailMessage AND
// idempotent PRIMARY-link semantics on EmailWorkIntakeOrigin. Safe
// after disconnect (runInitialSyncForConnection detects the
// terminal status and returns SKIPPED).
// ---------------------------------------------------------------------------
registerHandler<{ mailboxConnectionId: string }>("MAILBOX_INITIAL_SYNC", async ({ payload }) => {
  const { runInitialSyncForConnection } = await import("../mailbox/sync");
  return runInitialSyncForConnection({ mailboxConnectionId: payload.mailboxConnectionId });
});

// Sprint 2 Checkpoint 13G (2026-07-23) — MAILBOX_DELTA_SYNC handler.
// Bounded incremental sync via the Graph delta endpoint. The
// controlled-mode envs (MAILBOX_SYNC_MAX_MESSAGES_OVERRIDE,
// MAILBOX_SYNC_SKIP_MATERIALIZATION, MAILBOX_SYNC_SKIP_ATTACHMENT_METADATA)
// clamp behaviour in the same way they do for initial sync. See
// src/lib/mailbox/delta-sync.ts for the full contract. Payload
// validation happens inside the handler dispatch below so any
// malformed job fails cleanly rather than reaching the runner.
registerHandler<{ mailboxConnectionId: string }>("MAILBOX_DELTA_SYNC", async ({ payload }) => {
  const rawId = payload?.mailboxConnectionId;
  if (typeof rawId !== "string" || rawId.length === 0) {
    throw new Error("MAILBOX_DELTA_SYNC payload missing mailboxConnectionId");
  }
  const { runDeltaSyncForConnection } = await import("../mailbox/delta-sync");
  return runDeltaSyncForConnection({ mailboxConnectionId: rawId });
});

// Sprint 3 Checkpoint 15D (2026-07-24) — MAILBOX_ATTACHMENT_FETCH is
// now LIVE. Per-attachment ingest: fetches bytes from Graph, runs
// safety + fingerprint + dedup + classify + store, and (if requested)
// links the resulting IngestedDocument to a WorkIntakeItem.
//
// Payload: { emailAttachmentId, attachToWorkIntakeItemId? }
// Idempotency: enqueue with key `mailbox:doc-ingest:{emailAttachmentId}`.
// The ingest pipeline itself is dedup-safe via (clubId, sha256Hash);
// a retry after a partial failure just links evidence + writes an
// audit row without reuploading.
registerHandler<{
  emailAttachmentId: string;
  attachToWorkIntakeItemId?: string | null;
}>("MAILBOX_ATTACHMENT_FETCH", async ({ payload }) => {
  const { runMailboxAttachmentIngest } = await import(
    "../documents/mailbox-attachment-ingest"
  );
  return runMailboxAttachmentIngest({
    emailAttachmentId: payload.emailAttachmentId,
    attachToWorkIntakeItemId: payload.attachToWorkIntakeItemId ?? null,
  });
});

// Sprint 3 · Checkpoint 15P-7 — MAILBOX_ARCHIVE_MESSAGE.
//
// Post-commit archive of the source Outlook email after an AP
// invoice is posted from Mission Control. Idempotent per
// apInvoiceId + graphMessageId: rerunning with the same payload
// checks the current mailbox state and no-ops if the message is
// already in the target folder.
//
// Scope note: the Microsoft Graph delegated allowlist at
// src/lib/integrations/microsoft-graph-delegated.ts currently
// includes only Mail.Read + Mail.Send. Archiving requires
// Mail.ReadWrite (POST /me/messages/{id}/move). Until that scope
// is granted + consented, the handler records ARCHIVE_PENDING_SCOPE
// state and does NOT throw — the accounting side stays clean.
registerHandler<{
  apInvoiceId: string;
  workIntakeItemId: string;
  emailMessageId: string;
  graphMessageId: string;
  mailboxConnectionId: string;
}>("MAILBOX_ARCHIVE_MESSAGE", async ({ payload }) => {
  const { runMailboxArchiveMessage } = await import("../mailbox/archive");
  return runMailboxArchiveMessage(payload);
});

// Phase 4R rev-10 (2026-08-15) — MAILBOX_MARK_READ.
//
// Spectre → Outlook `PATCH /me/messages/{id} { "isRead": true }`
// triggered when the founder first meaningfully interacts with an
// unread email-backed Work Intake card. Idempotent per
// (mailboxConnectionId, emailMessageId) via the
// OutlookMarkReadMutation row. Mail.ReadWrite scope already in
// APPROVED_DELEGATED_SCOPES (no consent change needed).
registerHandler<{
  workIntakeItemId: string;
  emailMessageId: string;
  graphMessageId: string;
  mailboxConnectionId: string;
  triggeredByUserId?: string;
}>("MAILBOX_MARK_READ", async ({ payload }) => {
  const { runMailboxMarkRead } = await import("../mailbox/mark-read");
  return runMailboxMarkRead(payload);
});

// Sprint 3 · Checkpoint 16H rejection (2026-08-06) — reconcile a
// Spectre-originated outbound reply against Outlook Sent Items. The
// handler is invoked with a delay from persistCanonicalOutboundReply
// (backoff 30s / 2m / 10m). On success it attaches the real Graph
// message id; on failure it either requeues or parks the row FAILED
// without ever deleting the founder-visible local reply.
registerHandler<{
  conversationMessageId: string;
  attempt: number;
}>("CONVERSATION_MESSAGE_RECONCILE", async ({ payload }) => {
  const { runConversationReconciliation } = await import("../mailbox/conversation-messages");
  const res = await runConversationReconciliation({
    conversationMessageId: payload.conversationMessageId,
    attempt: typeof payload.attempt === "number" ? payload.attempt : 0,
  });
  return { outcome: res.outcome };
});

// WI-SYNC-1b (2026-10-18) — MAILBOX_RECONCILIATION_HEARTBEAT is now
// IMPLEMENTED.  The reconciliation-scheduler enqueues one job per
// mailbox per 15-min bucket; the handler calls the shared
// reconcileMailbox() service in APPLY mode and the service persists
// a MailboxSyncRun row for the health endpoint to read.
registerHandler<{
  mailboxConnectionId: string;
  callerUserId: string | null;
}>("MAILBOX_RECONCILIATION_HEARTBEAT", async ({ payload }) => {
  const rawId = payload?.mailboxConnectionId;
  if (typeof rawId !== "string" || rawId.length === 0) {
    throw new Error(
      "MAILBOX_RECONCILIATION_HEARTBEAT payload missing mailboxConnectionId",
    );
  }
  const { prisma } = await import("@/lib/prisma");
  const mbx = await prisma.mailboxConnection.findUnique({
    where: { id: rawId },
    select: { id: true, clubId: true, userId: true, status: true },
  });
  if (!mbx) {
    throw new Error(
      `MAILBOX_RECONCILIATION_HEARTBEAT: mailboxConnectionId ${rawId} not found`,
    );
  }
  if (mbx.status !== "CONNECTED") {
    // Not an error — the scheduled sweep is a best-effort job.
    // Terminal / disconnected mailboxes are intentionally skipped;
    // the scheduler will drop them from its scan on the next tick.
    logger.info("mailbox.reconcile-sweep.skipped_not_connected", {
      mailboxConnectionIdTail: mbx.id.slice(-6),
      status: mbx.status,
    });
    return { outcome: "SKIPPED", reason: "not_connected" };
  }
  const { reconcileMailbox } = await import("../mailbox/reconciliation");
  const report = await reconcileMailbox({
    clubId: mbx.clubId,
    mailboxConnectionId: mbx.id,
    callerUserId: payload?.callerUserId ?? mbx.userId,
    dryRun: false,
    triggerKind: "RECONCILIATION_SWEEP",
  });
  return {
    outcome: "COMPLETED",
    tombstonesApplied: report.totals.tombstonesProposedOrApplied,
    workIntakeItemsAffected: report.totals.workIntakeItemsAffected,
    inaccessibleRetryable: report.totals.inaccessibleRetryable,
    inaccessiblePermanent: report.totals.inaccessiblePermanent,
  };
});

// WI-SYNC-1d (2026-10-18) — MAILBOX_RENEW_SUBSCRIPTION promoted
// from stub to IMPLEMENTED.  The subscription scheduler enqueues
// one job per (mailbox, action, bucket); the handler calls the
// shared maintainSubscriptionForMailbox service.  Idempotent per
// mailbox: a RENEW on an already-renewed subscription short-
// circuits to ALREADY_ACTIVE.
registerHandler<{
  mailboxConnectionId: string;
  callerUserId: string | null;
  hint?: "CREATE" | "RENEW" | "RECREATE";
}>("MAILBOX_RENEW_SUBSCRIPTION", async ({ payload }) => {
  const rawId = payload?.mailboxConnectionId;
  if (typeof rawId !== "string" || rawId.length === 0) {
    throw new Error(
      "MAILBOX_RENEW_SUBSCRIPTION payload missing mailboxConnectionId",
    );
  }
  const { prisma } = await import("@/lib/prisma");
  const mbx = await prisma.mailboxConnection.findUnique({
    where: { id: rawId },
    select: { id: true, clubId: true, userId: true, status: true },
  });
  if (!mbx) {
    throw new Error(
      `MAILBOX_RENEW_SUBSCRIPTION: mailboxConnectionId ${rawId} not found`,
    );
  }
  if (mbx.status !== "CONNECTED") {
    logger.info("mailbox.subscription.skipped_not_connected", {
      mailboxConnectionIdTail: mbx.id.slice(-6),
      status: mbx.status,
    });
    return { outcome: "SKIPPED", reason: "not_connected" };
  }
  const publicBaseUrl =
    process.env.SPECTRE_PLATFORM_HOST ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "https://staging.spectreautomation.com";
  const { maintainSubscriptionForMailbox } = await import(
    "../mailbox/subscriptions"
  );
  const result = await maintainSubscriptionForMailbox({
    mailboxConnectionId: mbx.id,
    clubId: mbx.clubId,
    publicBaseUrl,
    callerUserId: payload?.callerUserId ?? mbx.userId,
    forceRecreate: payload?.hint === "RECREATE",
  });
  return result;
});

// WI-SYNC-1g (2026-10-18) — MAILBOX_RESTORE_COMPLETION.
//
// Partial-failure recovery for Spectre→Outlook restore.  Enqueued
// by restoreOutlookMessageForWorkIntake when Graph move + probe
// succeeded but the subsequent DB transaction failed, leaving the
// mutation row in GRAPH_OK_DB_PENDING.  Handler is idempotent —
// calling completeRestoreMutation twice is safe.
registerHandler<{ mutationId: string }>(
  "MAILBOX_RESTORE_COMPLETION",
  async ({ payload }) => {
    const mutationId = payload?.mutationId;
    if (typeof mutationId !== "string" || mutationId.length === 0) {
      throw new Error("MAILBOX_RESTORE_COMPLETION payload missing mutationId");
    }
    const { completeRestoreMutation } = await import(
      "../mailbox/restore-message"
    );
    const result = await completeRestoreMutation({ mutationId });
    return { outcome: result.ok ? "COMPLETED" : "SKIPPED", detail: result.detail };
  },
);

// ---------------------------------------------------------------------------
// Sprint 3 · Checkpoint 15X continuation (2026-07-29) — AP_DOCUMENT_OCR.
//
// The single code path allowed to invoke a paid OCR provider. Called
// only by the worker (bin/worker.ts). Web-tier requests enter via
// src/lib/ap-intelligence/ocr/enqueue.ts, which persists a PENDING
// DocumentOcrExtraction row and enqueues one job per identity.
//
// Idempotency: DB unique constraint on (clubId, sha, provider,
// extractionVersion) plus the queue's own (clubId, kind,
// idempotencyKey) unique constraint. Concurrent enqueues collapse
// to one PENDING row + one queued job. Concurrent workers race on
// the atomic PENDING → PROCESSING claim; the loser exits without
// invoking the provider.
// ---------------------------------------------------------------------------
registerHandler<{ extractionRowId: string }>("AP_DOCUMENT_OCR", async ({ payload, jobId }) => {
  const { runAPDocumentOcrJob } = await import(
    "../ap-intelligence/ocr/worker"
  );
  return runAPDocumentOcrJob({
    jobId,
    workerId: "queue",
    payload,
  });
});

// Sprint 3 · Post-16H P0-hardening (2026-08-07) — recovery for
// stranded ApIntakeSource records. See
// src/lib/ap-intelligence/materialise-recovery.ts.
registerHandler<{
  clubId: string;
  ingestedDocumentId: string;
  emailAttachmentId?: string;
  emailMessageId?: string;
}>("AP_MATERIALISE_RECOVERY", async ({ payload }) => {
  const { runApMaterialiseRecovery } = await import(
    "../ap-intelligence/materialise-recovery"
  );
  return runApMaterialiseRecovery(payload);
});

// Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — AP re-analyse after
// OCR completion. See src/lib/ap-intelligence/reanalyse-worker.ts.
registerHandler<{
  clubId: string;
  ingestedDocumentId: string;
  triggerSource: "ocr" | "manual";
}>("AP_INVOICE_REANALYSE", async ({ payload, jobId }) => {
  const { runAPInvoiceReanalyseJob } = await import(
    "../ap-intelligence/reanalyse-worker"
  );
  return runAPInvoiceReanalyseJob({ jobId, payload });
});

// Sprint 3 · Phase 4 Slice 5.7B (2026-08-09) — async external product
// research. Worker is the ONLY component that calls the paid provider
// after Slice 5.7B cutover. See
// src/lib/ap-intelligence/external-product-reference/research-worker.ts.
registerHandler("PRODUCT_REFERENCE_RESEARCH", async ({ payload, jobId }) => {
  const { runProductReferenceResearchJob } = await import(
    "../ap-intelligence/external-product-reference/research-worker"
  );
  return runProductReferenceResearchJob({
    jobId,
    payload: payload as import("../ap-intelligence/external-product-reference/research-worker").ProductReferenceResearchPayload,
  });
});

// Payroll-3D-3B Slice 3 (2026-09-06) — proactive orchestration for
// the department timesheet-approval Work Intake obligation. Handler
// re-resolves every scope owner and approval state from the pay
// period id; a period with no reviewable scopes is a harmless no-op.
registerHandler<{
  clubId: string;
  payPeriodId: string;
}>("ENSURE_TIMESHEET_APPROVAL_WI", async ({ payload }) => {
  const { ensureTimesheetApprovalWorkItems } = await import(
    "../timesheets/orchestration"
  );
  const result = await ensureTimesheetApprovalWorkItems(
    payload.clubId, payload.payPeriodId,
  );
  return { itemsHandled: result.items.length };
});

// Payroll-3D-3B Slice 2 (2026-09-06) — recovery hook for the
// correction-review Work Intake obligation. Enqueued from
// submitCorrectionRequest when the inline await fails. Handler
// re-resolves routing from the correction id and is a no-op when
// the correction is no longer PENDING (§ENSURE_TIMECLOCK_CORRECTION_REVIEW_WI
// in src/lib/queue/index.ts).
registerHandler<{
  clubId: string;
  correctionRequestId: string;
}>("ENSURE_TIMECLOCK_CORRECTION_REVIEW_WI", async ({ payload }) => {
  const { ensureCorrectionReviewWorkItems } = await import(
    "../work-intake/correction-review-orchestration"
  );
  const outcome = await ensureCorrectionReviewWorkItems({
    clubId: payload.clubId,
    correctionRequestId: payload.correctionRequestId,
  });
  return { outcomeKind: outcome.kind };
});

/**
 * Sprint 2 B4.1 — Which mailbox JobKinds are implemented today. Used
 * by a future health endpoint to distinguish "reserved" from "live".
 * Sprint 2 Checkpoint 13G — MAILBOX_DELTA_SYNC promoted to IMPLEMENTED.
 * Sprint 3 Checkpoint 15D — MAILBOX_ATTACHMENT_FETCH promoted to IMPLEMENTED.
 * Phase 4R rev-10 (2026-08-15) — MAILBOX_MARK_READ added as IMPLEMENTED.
 */
export const MAILBOX_JOB_IMPLEMENTATION = {
  MAILBOX_INITIAL_SYNC: "IMPLEMENTED",
  MAILBOX_DELTA_SYNC: "IMPLEMENTED",
  MAILBOX_RENEW_SUBSCRIPTION: "IMPLEMENTED",
  MAILBOX_ATTACHMENT_FETCH: "IMPLEMENTED",
  MAILBOX_RECONCILIATION_HEARTBEAT: "IMPLEMENTED",
  MAILBOX_MARK_READ: "IMPLEMENTED",
  MAILBOX_RESTORE_COMPLETION: "IMPLEMENTED",
} as const;
