// v206 Work Intake / Outlook parity reconciliation diagnostic.
//
// Founder direction (2026-08-15) §18: "Because existing staging items may
// already be out of sync, provide a safe diagnostic/reconciliation
// mechanism. At minimum report:
//   • Active Work Intake items whose source message is no longer in Outlook Inbox
//   • Completed Work Intake items whose source message remains in Inbox
// Do not bulk modify them automatically in this phase."
//
// This script is READ-ONLY. It never writes to Prisma, never enqueues
// jobs, never calls Graph. It prints a structured JSON report.
//
// Usage (via flyctl on staging):
//   flyctl ssh sftp put --app spectre-staging \
//     scripts/reconcile-work-intake-outlook-parity.mjs
//   flyctl ssh console --app spectre-staging --command \
//     "sh -c 'cd /app && CLUB_ID=<clubId> node reconcile-work-intake-outlook-parity.mjs'"

/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";

const CLUB_ID = process.env.CLUB_ID;
if (!CLUB_ID) {
  console.error("CLUB_ID env var required");
  process.exit(2);
}

const prisma = new PrismaClient();

async function main() {
  // 1) Active WIs whose source email is soft-deleted or gone from mailbox.
  //    "Active" = status not in RESOLVED / SUPPRESSED.
  //    EmailMessage.softDeletedAt != null means Graph delta reported the
  //    message as removed from the source folder (Inbox in our model).
  const activeWIs = await prisma.workIntakeItem.findMany({
    where: {
      clubId: CLUB_ID,
      status: { notIn: ["RESOLVED", "SUPPRESSED"] },
      emailOrigins: { some: { role: "PRIMARY" } },
    },
    select: {
      id: true,
      status: true,
      classification: true,
      displaySubject: true,
      createdAt: true,
      emailOrigins: {
        where: { role: "PRIMARY" },
        select: {
          emailMessageId: true,
          emailMessage: {
            select: {
              id: true, graphMessageId: true, softDeletedAt: true,
              subject: true, senderAddress: true, receivedAt: true,
            },
          },
        },
      },
    },
  });

  const activeButEmailGone = activeWIs
    .map((w) => {
      const primary = w.emailOrigins[0];
      const em = primary?.emailMessage;
      return { w, em };
    })
    .filter(({ em }) => em && em.softDeletedAt != null);

  // 2) Completed WIs whose email is NOT soft-deleted (should have been
  //    archived) AND has NO SUCCEEDED OutlookArchiveMutation.
  const completedWIs = await prisma.workIntakeItem.findMany({
    where: {
      clubId: CLUB_ID,
      status: { in: ["RESOLVED", "SUPPRESSED"] },
      emailOrigins: { some: { role: "PRIMARY" } },
    },
    select: {
      id: true, status: true, classification: true, displaySubject: true,
      resolvedAt: true,
      emailOrigins: {
        where: { role: "PRIMARY" },
        select: {
          emailMessageId: true,
          emailMessage: {
            select: {
              id: true, graphMessageId: true, softDeletedAt: true,
              subject: true, senderAddress: true, receivedAt: true,
            },
          },
        },
      },
    },
  });

  const outOfSyncCompleted = [];
  for (const w of completedWIs) {
    for (const o of w.emailOrigins) {
      if (!o.emailMessage) continue;
      if (o.emailMessage.softDeletedAt != null) continue; // already gone from inbox
      const mut = await prisma.outlookArchiveMutation.findFirst({
        where: { workIntakeId: w.id, emailMessageId: o.emailMessageId },
        select: { id: true, status: true, errorCode: true, lastAttemptAt: true, completedAt: true },
      });
      if (!mut || mut.status !== "SUCCEEDED") {
        outOfSyncCompleted.push({
          workIntakeItemId: w.id,
          status: w.status,
          classification: w.classification,
          displaySubject: w.displaySubject,
          resolvedAt: w.resolvedAt,
          emailMessageId: o.emailMessageId,
          graphMessageId: o.emailMessage.graphMessageId,
          emailSubject: o.emailMessage.subject,
          emailSender: o.emailMessage.senderAddress,
          archiveMutation: mut ?? null,
        });
      }
    }
  }

  // 3) All completion events + their archive fan-out status.
  const eventCount = await prisma.workCompletionEvent.count({ where: { clubId: CLUB_ID } });
  const archiveMutationCounts = await prisma.outlookArchiveMutation.groupBy({
    by: ["status"],
    where: { clubId: CLUB_ID },
    _count: true,
  });

  // 4) Mailbox connection state summary.
  const conns = await prisma.mailboxConnection.findMany({
    where: { clubId: CLUB_ID },
    select: { id: true, status: true, grantedScopes: true, userId: true },
  });
  const connSummary = conns.map((c) => ({
    id: c.id,
    status: c.status,
    hasMailReadWrite: (c.grantedScopes ?? "").toLowerCase().includes("mail.readwrite"),
  }));

  const report = {
    clubId: CLUB_ID,
    generatedAt: new Date().toISOString(),
    summary: {
      activeWorkIntakesWithEmail: activeWIs.length,
      activeButEmailGoneFromInbox: activeButEmailGone.length,
      completedWorkIntakesWithEmail: completedWIs.length,
      completedButEmailStillInInbox: outOfSyncCompleted.length,
      totalCompletionEvents: eventCount,
      archiveMutationsByStatus: Object.fromEntries(
        archiveMutationCounts.map((r) => [r.status, r._count]),
      ),
    },
    activeButEmailGoneFromInbox: activeButEmailGone.map(({ w, em }) => ({
      workIntakeItemId: w.id,
      status: w.status,
      classification: w.classification,
      displaySubject: w.displaySubject,
      emailMessageId: em.id,
      graphMessageId: em.graphMessageId,
      emailSubject: em.subject,
      softDeletedAt: em.softDeletedAt,
      note: "Active WI whose source email is no longer in Inbox. Likely orphaned — consider archiving/suppressing.",
    })),
    completedButEmailStillInInbox: outOfSyncCompleted,
    mailboxConnections: connSummary,
    remediationGuidance: {
      completedButEmailStillInInbox: outOfSyncCompleted.length === 0
        ? "None — all completed WIs' emails are out of the inbox."
        : `${outOfSyncCompleted.length} WIs completed but their source email is still in the inbox. Options: (a) re-enqueue MAILBOX_ARCHIVE_MESSAGE for their most recent WorkCompletionEvent; (b) leave as-is and archive on next completion. This diagnostic never bulk-modifies automatically.`,
      activeButEmailGoneFromInbox: activeButEmailGone.length === 0
        ? "None."
        : `${activeButEmailGone.length} active WIs whose source email is no longer in the inbox. Founder should decide per-item whether to Resolve (creates completion event; archive is no-op since email already gone) or Reopen the source email.`,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((e) => {
    console.error("RECONCILIATION_FAILED", e.message, e.stack);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
