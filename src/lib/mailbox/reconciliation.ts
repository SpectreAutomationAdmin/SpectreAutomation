// WI-SYNC-1a (2026-10-18) — one-shot mailbox reconciliation.
//
// Walks every active EmailMessage in a specified mailbox, asks
// Microsoft Graph for its current state, and classifies each row
// into one of:
//
//   PRESENT_INBOX          — row still in Inbox; WI unchanged.
//   PRESENT_OTHER_FOLDER   — moved out of Inbox (Deleted Items /
//                            Archive / user folder); should be
//                            tombstoned so Spectre matches what the
//                            user sees in Outlook.
//   DELETED                — Graph returned 404 / 410; permanently
//                            removed from the mailbox.
//   INACCESSIBLE_RETRYABLE — Graph 429 / 5xx / network error.
//                            Transient; DO NOT tombstone.
//   INACCESSIBLE_PERMANENT — Graph 401 / 403 / 400.  Needs human
//                            review (re-consent, policy denial).
//                            DO NOT tombstone.
//
// Modes:
//
//   dryRun === true  : classifies every row, builds the proposed
//                      change list, writes NOTHING to the DB.  No
//                      mutations against Graph either.  Idempotent.
//
//   dryRun === false : applies the proposed changes
//                      (softDeletedAt + handleEmailEvidenceDeleted)
//                      inside per-row Prisma transactions.  Writes
//                      an audit row per decision.  Idempotent:
//                      re-running after a successful apply is a
//                      no-op because the already-tombstoned rows
//                      are filtered out of the candidate query.
//
// Isolation:
//   - Caller must supply `mailboxConnectionId`.  The service
//     verifies the connection belongs to `clubId` before any
//     Graph or DB access.
//   - Only EmailMessage rows with matching clubId AND
//     matching mailboxConnectionId are considered — cross-tenant
//     drift is architecturally impossible.
//
// NOT in scope:
//   - Restoring a message found in a non-inbox folder as "it's
//     really present".  WI-SYNC-1c handles restore semantics.
//   - Spectre-side AP cascading: APInvoice rows are in a separate
//     table and are NEVER touched by this service.

import { prisma } from "@/lib/prisma";
import {
  getMicrosoftDelegatedProvider,
  type ProbeMessageOutcome,
} from "@/lib/integrations/microsoft-graph-delegated";
import { getFreshDelegatedAccessToken } from "./connect";
import { handleEmailEvidenceDeleted } from "./email-materializer";
import { logger } from "@/lib/observability/logger";

/** The disposition we conclude for one EmailMessage after probing
 *  Graph.  WI-SYNC-1a-rev1 (2026-10-18) — the "present but not in
 *  Inbox" case is split so Archive is distinguishable from Deleted
 *  Items and from user-defined folders.  Only Deleted Items (and
 *  hard-deletion) are tombstone candidates in this slice; Archive
 *  behaviour is deferred to WI-SYNC-1c per founder brief. */
export type ReconciliationDisposition =
  | "PRESENT_INBOX"
  | "PRESENT_DELETED_ITEMS"
  | "PRESENT_ARCHIVE"
  | "PRESENT_OTHER_FOLDER"
  | "DELETED"
  | "INACCESSIBLE_RETRYABLE"
  | "INACCESSIBLE_PERMANENT";

/** The action the reconciler proposed (dry-run) or applied.
 *  Archive and unknown-folder cases are explicit SKIP outcomes so
 *  the next slice can safely add their behaviour without reading
 *  the dispositions as "unchanged forever." */
export type ReconciliationAction =
  | "NONE"
  | "TOMBSTONE_AND_SUPPRESS"
  | "SKIP_ARCHIVE_DEFERRED"
  | "SKIP_UNKNOWN_FOLDER"
  | "SKIP_INACCESSIBLE_RETRYABLE"
  | "SKIP_INACCESSIBLE_PERMANENT";

export interface ReconciliationRowReport {
  emailMessageId: string;
  graphMessageId: string;
  subject: string;
  senderAddress: string;
  receivedAt: Date;
  linkedWorkIntakeItemId: string | null;
  linkedWorkIntakeStatus: string | null;
  hasApIntakeSource: boolean;
  probeOutcome: ProbeMessageOutcome | "NOT_PROBED";
  disposition: ReconciliationDisposition;
  action: ReconciliationAction;
  parentFolderId?: string;
  reason: string;
  httpStatus?: number;
  errorCode?: string;
  retryAfterSeconds?: number;
}

export interface ReconciliationReport {
  mailboxConnectionId: string;
  clubId: string;
  mode: "DRY_RUN" | "APPLY";
  startedAt: Date;
  completedAt: Date;
  totals: {
    messagesExamined: number;
    presentInbox: number;
    presentDeletedItems: number;
    presentArchive: number;
    presentOtherFolder: number;
    deleted: number;
    inaccessibleRetryable: number;
    inaccessiblePermanent: number;
    tombstonesProposedOrApplied: number;
    workIntakeItemsAffected: number;
  };
  inboxFolderId: string | null;
  deletedItemsFolderId: string | null;
  archiveFolderId: string | null;
  resolvedFolderNamesById: Record<string, string>;
  rows: ReconciliationRowReport[];
}

export interface ReconcileMailboxArgs {
  clubId: string;
  mailboxConnectionId: string;
  /** Caller identity — required so the token refresh request can
   *  be audited to a real user, and so cross-club token calls are
   *  blocked at the token layer in addition to the tenant guard
   *  below. */
  callerUserId: string | null;
  dryRun: boolean;
  /** Hard cap on messages examined.  Default 1000 — Coulee's whole
   *  mailbox is 71 messages, so this is comfortable for the known
   *  staging workload.  Larger mailboxes should chunk by run. */
  limit?: number;
  /** Only consider messages received at or after this date (for
   *  future bounded reconciliations). */
  receivedSince?: Date;
  /** WI-SYNC-1b (2026-10-18) — the triggerKind to record on the
   *  MailboxSyncRun.  Scheduled sweeps pass "RECONCILIATION_SWEEP";
   *  operator-initiated apply/dry-run calls default to
   *  "RECONCILIATION" so the health endpoint can distinguish them.
   *  Dry-runs still write a MailboxSyncRun — status is COMPLETED
   *  with messagesExamined populated and the mode captured on the
   *  reconciliation report itself. */
  triggerKind?: "RECONCILIATION" | "RECONCILIATION_SWEEP";
}

/** Entry point. */
export async function reconcileMailbox(
  args: ReconcileMailboxArgs,
): Promise<ReconciliationReport> {
  const startedAt = new Date();
  const limit = Math.max(1, Math.min(10_000, args.limit ?? 1_000));
  const triggerKind: "RECONCILIATION" | "RECONCILIATION_SWEEP" =
    args.triggerKind ?? "RECONCILIATION";

  // Tenant guard: connection must belong to the stated clubId.
  const connection = await prisma.mailboxConnection.findUnique({
    where: { id: args.mailboxConnectionId },
    select: { id: true, clubId: true, status: true, userId: true },
  });
  if (!connection) {
    throw new Error(
      `reconcileMailbox: mailboxConnectionId ${args.mailboxConnectionId} not found`,
    );
  }
  if (connection.clubId !== args.clubId) {
    throw new Error(
      "reconcileMailbox: mailbox does not belong to the stated club",
    );
  }
  if (connection.status !== "CONNECTED") {
    throw new Error(
      `reconcileMailbox: mailbox is not CONNECTED (status=${connection.status}); re-connect before reconciling`,
    );
  }

  // Pull the active-side candidate set — every EmailMessage in
  // this mailbox that is NOT already soft-deleted.  Rows that
  // already carry softDeletedAt have been handled by a prior pass
  // (idempotency).
  const candidates = await prisma.emailMessage.findMany({
    where: {
      clubId: args.clubId,
      mailboxConnectionId: args.mailboxConnectionId,
      softDeletedAt: null,
      ...(args.receivedSince ? { receivedAt: { gte: args.receivedSince } } : {}),
    },
    orderBy: { receivedAt: "desc" },
    take: limit,
    select: {
      id: true,
      graphMessageId: true,
      immutableId: true,
      subject: true,
      senderAddress: true,
      receivedAt: true,
      conversationId: true,
    },
  });

  // WI-SYNC-1b — persist a MailboxSyncRun BEFORE any Graph call so
  // a worker crash still leaves an observable trace.  Status starts
  // RUNNING and is updated to COMPLETED / PARTIAL / TERMINAL at the
  // end.  Dry-runs record a run too so observability still sees the
  // scheduler's cadence under test.
  const syncRun = await prisma.mailboxSyncRun.create({
    data: {
      clubId: args.clubId,
      mailboxConnectionId: args.mailboxConnectionId,
      status: "RUNNING",
      triggerKind,
      startedAt,
    },
    select: { id: true },
  });

  if (candidates.length === 0) {
    await prisma.mailboxSyncRun.update({
      where: { id: syncRun.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        messagesExamined: 0,
        messagesUpdated: 0,
      },
    });
    return emptyReport(args, startedAt);
  }

  // Fetch a fresh delegated access token + resolve Inbox folder
  // id up-front (one call) + resolve well-known folders we may
  // see in parentFolderId so we can name them in the report.
  const { accessToken: token } = await getFreshDelegatedAccessToken({
    mailboxConnectionId: args.mailboxConnectionId,
    callerClubId: args.clubId,
    callerUserId: args.callerUserId,
  });
  const provider = getMicrosoftDelegatedProvider();

  const [inboxFolder, deletedFolder, archiveFolder] = await Promise.all([
    provider.getWellKnownFolder({ accessToken: token, wellKnownName: "inbox" }),
    provider.getWellKnownFolder({ accessToken: token, wellKnownName: "deleteditems" }),
    provider.getWellKnownFolder({ accessToken: token, wellKnownName: "archive" }),
  ]);

  const folderNames: Record<string, string> = {};
  if (inboxFolder) folderNames[inboxFolder.id] = `Inbox (${inboxFolder.displayName})`;
  if (deletedFolder) folderNames[deletedFolder.id] = `Deleted Items (${deletedFolder.displayName})`;
  if (archiveFolder) folderNames[archiveFolder.id] = `Archive (${archiveFolder.displayName})`;

  // Pull all PRIMARY origin links in one query, plus which rows
  // carry an ApIntakeSource — the report flags AP-linked rows so
  // the founder can decide whether to apply.
  const emailIds = candidates.map((c) => c.id);
  const [originLinks, apSources] = await Promise.all([
    prisma.emailWorkIntakeOrigin.findMany({
      where: { emailMessageId: { in: emailIds }, role: "PRIMARY" },
      select: {
        emailMessageId: true,
        workIntakeItemId: true,
        workIntakeItem: { select: { id: true, status: true } },
      },
    }),
    prisma.apIntakeSource.findMany({
      where: { emailMessageId: { in: emailIds } },
      select: { emailMessageId: true },
    }),
  ]);
  const originByEmailId = new Map(
    originLinks.map((l) => [l.emailMessageId, l] as const),
  );
  const apSourceEmailIds = new Set(apSources.map((s) => s.emailMessageId));

  const rows: ReconciliationRowReport[] = [];
  const totals = {
    messagesExamined: 0,
    presentInbox: 0,
    presentDeletedItems: 0,
    presentArchive: 0,
    presentOtherFolder: 0,
    deleted: 0,
    inaccessibleRetryable: 0,
    inaccessiblePermanent: 0,
    tombstonesProposedOrApplied: 0,
    workIntakeItemsAffected: 0,
  };

  for (const c of candidates) {
    totals.messagesExamined += 1;
    const graphId = c.immutableId || c.graphMessageId;
    const originLink = originByEmailId.get(c.id);
    const hasAp = apSourceEmailIds.has(c.id);

    let probe: Awaited<ReturnType<typeof provider.probeMessage>>;
    try {
      probe = await provider.probeMessage({
        accessToken: token,
        graphMessageId: graphId,
      });
    } catch (e) {
      // probeMessage is designed not to throw for ordinary mailbox
      // conditions.  A throw here means the fetch itself failed
      // (e.g. token-get problem) — treat as retryable.
      logger.error("wi-sync-1a reconcile: probe threw", {
        mailboxConnectionId: args.mailboxConnectionId,
        emailMessageId: c.id,
        err: (e as Error).message,
      });
      probe = { outcome: "INACCESSIBLE_RETRYABLE", errorCode: (e as Error).message };
    }

    const base: Omit<ReconciliationRowReport, "disposition" | "action" | "reason"> = {
      emailMessageId: c.id,
      graphMessageId: graphId,
      subject: c.subject,
      senderAddress: c.senderAddress,
      receivedAt: c.receivedAt,
      linkedWorkIntakeItemId: originLink?.workIntakeItem?.id ?? null,
      linkedWorkIntakeStatus: originLink?.workIntakeItem?.status ?? null,
      hasApIntakeSource: hasAp,
      probeOutcome: probe.outcome,
      parentFolderId: probe.parentFolderId,
      httpStatus: probe.httpStatus,
      errorCode: probe.errorCode,
      retryAfterSeconds: probe.retryAfterSeconds,
    };

    const row = classifyProbe({
      base,
      probe,
      inboxFolderId: inboxFolder?.id ?? null,
      deletedItemsFolderId: deletedFolder?.id ?? null,
      archiveFolderId: archiveFolder?.id ?? null,
      folderNames,
    });
    switch (row.disposition) {
      case "PRESENT_INBOX":
        totals.presentInbox += 1;
        break;
      case "PRESENT_DELETED_ITEMS":
        totals.presentDeletedItems += 1;
        break;
      case "PRESENT_ARCHIVE":
        totals.presentArchive += 1;
        break;
      case "PRESENT_OTHER_FOLDER":
        totals.presentOtherFolder += 1;
        break;
      case "DELETED":
        totals.deleted += 1;
        break;
      case "INACCESSIBLE_RETRYABLE":
        totals.inaccessibleRetryable += 1;
        break;
      case "INACCESSIBLE_PERMANENT":
        totals.inaccessiblePermanent += 1;
        break;
    }

    if (row.action === "TOMBSTONE_AND_SUPPRESS") {
      totals.tombstonesProposedOrApplied += 1;
      if (row.linkedWorkIntakeItemId) totals.workIntakeItemsAffected += 1;
      if (!args.dryRun) {
        try {
          await applyTombstone({
            emailMessageId: c.id,
            clubId: args.clubId,
          });
        } catch (e) {
          logger.error("wi-sync-1a reconcile: apply tombstone failed", {
            mailboxConnectionId: args.mailboxConnectionId,
            emailMessageId: c.id,
            err: (e as Error).message,
          });
          row.reason =
            `${row.reason} | apply failed: ${(e as Error).message}`;
        }
      }
    }

    rows.push(row);
  }

  const completedAt = new Date();
  // Finalise the MailboxSyncRun row.  INACCESSIBLE_RETRYABLE rows
  // DO cause status to be PARTIAL — operators can see which
  // mailboxes need another pass without re-running the service.
  const partial = totals.inaccessibleRetryable > 0;
  await prisma.mailboxSyncRun.update({
    where: { id: syncRun.id },
    data: {
      status: partial ? "PARTIAL" : "COMPLETED",
      completedAt,
      messagesExamined: totals.messagesExamined,
      // "messagesUpdated" captures the write intent: dry-run reports
      // zero because nothing was persisted; apply reports the
      // tombstone count.
      messagesUpdated: args.dryRun ? 0 : totals.tombstonesProposedOrApplied,
      messagesSuppressed: args.dryRun ? 0 : totals.workIntakeItemsAffected,
      // messagesImported stays zero — reconciliation never creates
      // new EmailMessage rows.
    },
  });

  return {
    mailboxConnectionId: args.mailboxConnectionId,
    clubId: args.clubId,
    mode: args.dryRun ? "DRY_RUN" : "APPLY",
    startedAt,
    completedAt,
    totals,
    inboxFolderId: inboxFolder?.id ?? null,
    deletedItemsFolderId: deletedFolder?.id ?? null,
    archiveFolderId: archiveFolder?.id ?? null,
    resolvedFolderNamesById: folderNames,
    rows,
  };
}

/** Exported for unit testing of classification outcomes without
 *  spinning up a Prisma / Graph round-trip. */
export function classifyProbe(args: {
  base: Omit<ReconciliationRowReport, "disposition" | "action" | "reason">;
  probe: Awaited<ReturnType<ReturnType<typeof getMicrosoftDelegatedProvider>["probeMessage"]>>;
  inboxFolderId: string | null;
  deletedItemsFolderId: string | null;
  archiveFolderId: string | null;
  folderNames: Record<string, string>;
}): ReconciliationRowReport {
  const { base, probe, inboxFolderId, deletedItemsFolderId, archiveFolderId, folderNames } = args;
  if (probe.outcome === "PRESENT") {
    const parent = probe.parentFolderId;
    const parentName = parent ? (folderNames[parent] ?? "Non-inbox folder") : "unknown folder";
    if (parent && inboxFolderId && parent === inboxFolderId) {
      return {
        ...base,
        disposition: "PRESENT_INBOX",
        action: "NONE",
        reason: `Message is still in Inbox (${parentName}); no change proposed.`,
      };
    }
    if (parent && deletedItemsFolderId && parent === deletedItemsFolderId) {
      // The ONLY tombstone case for a PRESENT probe in WI-SYNC-1a.
      return {
        ...base,
        disposition: "PRESENT_DELETED_ITEMS",
        action: "TOMBSTONE_AND_SUPPRESS",
        reason:
          `Message is in Outlook's Deleted Items folder (${parentName}).` +
          `  Tombstone + suppress the linked Work Intake item so the` +
          ` feed matches the mailbox.`,
      };
    }
    if (parent && archiveFolderId && parent === archiveFolderId) {
      // Explicit SKIP — the founder's WI-SYNC-1a brief defers
      // archive behaviour to a later slice.  Archiving an email is
      // not equivalent to deleting it, so we neither touch
      // softDeletedAt nor transition the linked WI.
      return {
        ...base,
        disposition: "PRESENT_ARCHIVE",
        action: "SKIP_ARCHIVE_DEFERRED",
        reason:
          `Message is in Outlook's Archive folder (${parentName}).` +
          `  Archive is NOT equivalent to deletion; archive-folder` +
          ` behaviour is intentionally deferred to a later` +
          ` synchronization slice.  No action taken.`,
      };
    }
    // Any other non-inbox folder — a user-defined folder, Sent
    // Items, Drafts, Junk, etc.  Also explicitly skipped in 1a;
    // surfaced for human review before any mass change.
    return {
      ...base,
      disposition: "PRESENT_OTHER_FOLDER",
      action: "SKIP_UNKNOWN_FOLDER",
      reason:
        `Message is in a non-inbox folder that is not Deleted Items` +
        ` or Archive (${parentName}` +
        (parent ? `, ${parent}` : "") +
        `).  Skipped — folder behaviour is undefined in this slice;` +
        ` surface for human review.`,
    };
  }
  if (probe.outcome === "DELETED") {
    return {
      ...base,
      disposition: "DELETED",
      action: "TOMBSTONE_AND_SUPPRESS",
      reason:
        `Microsoft Graph returned ${probe.httpStatus} — message is` +
        ` no longer in the mailbox (permanently deleted or purged).` +
        `  Tombstone + suppress the linked Work Intake item.`,
    };
  }
  if (probe.outcome === "INACCESSIBLE_RETRYABLE") {
    return {
      ...base,
      disposition: "INACCESSIBLE_RETRYABLE",
      action: "SKIP_INACCESSIBLE_RETRYABLE",
      reason:
        `Graph returned a transient error (${probe.errorCode}` +
        (probe.httpStatus ? `, HTTP ${probe.httpStatus}` : "") +
        `).  Skipping — will retry on the next reconciliation pass.`,
    };
  }
  return {
    ...base,
    disposition: "INACCESSIBLE_PERMANENT",
    action: "SKIP_INACCESSIBLE_PERMANENT",
    reason:
      `Graph returned a non-retryable error (${probe.errorCode}` +
      (probe.httpStatus ? `, HTTP ${probe.httpStatus}` : "") +
      `).  Skipping — surface for human review (re-consent or` +
      ` policy denial).  No tombstone applied.`,
  };
}

async function applyTombstone(args: {
  emailMessageId: string;
  clubId: string;
}): Promise<void> {
  // Flip softDeletedAt only when not already set — strict
  // idempotency.  The companion WorkIntakeItem transition is
  // delegated to handleEmailEvidenceDeleted which has its own
  // RESOLVED/SUPPRESSED early returns + Spectre-initiated-archive
  // reconciliation guard + EVIDENCE_DELETED audit trail.
  const existing = await prisma.emailMessage.findUnique({
    where: { id: args.emailMessageId },
    select: { id: true, clubId: true, softDeletedAt: true },
  });
  if (!existing) return;
  if (existing.clubId !== args.clubId) return; // defence-in-depth tenant guard
  if (!existing.softDeletedAt) {
    await prisma.emailMessage.update({
      where: { id: existing.id },
      data: { softDeletedAt: new Date(), lastSyncedAt: new Date() },
    });
  }
  await handleEmailEvidenceDeleted({
    clubId: args.clubId,
    emailMessageId: args.emailMessageId,
  });
}

function emptyReport(args: ReconcileMailboxArgs, startedAt: Date): ReconciliationReport {
  return {
    mailboxConnectionId: args.mailboxConnectionId,
    clubId: args.clubId,
    mode: args.dryRun ? "DRY_RUN" : "APPLY",
    startedAt,
    completedAt: new Date(),
    totals: {
      messagesExamined: 0,
      presentInbox: 0,
      presentDeletedItems: 0,
      presentArchive: 0,
      presentOtherFolder: 0,
      deleted: 0,
      inaccessibleRetryable: 0,
      inaccessiblePermanent: 0,
      tombstonesProposedOrApplied: 0,
      workIntakeItemsAffected: 0,
    },
    inboxFolderId: null,
    deletedItemsFolderId: null,
    archiveFolderId: null,
    resolvedFolderNamesById: {},
    rows: [],
  };
}
