// WI-SYNC-1h (2026-10-18) — Active Work Intake re-verification.
//
// Called from the manual Feed Sync refresh handler.  For every
// currently-active email-backed Work Intake item in the active
// club, calls Microsoft Graph directly to confirm the message's
// current folder.  If the message has moved to Deleted Items
// since Spectre last saw it, applies the same tombstone the
// 15-minute reconciliation sweep would — immediately, in-request.
//
// Why this exists:
//
//   Microsoft Graph's Inbox-scoped delta stream does NOT reliably
//   emit `@removed` markers when a user deletes a message in
//   Outlook.  WI-SYNC-1g acceptance observed six consecutive
//   Spectre-initiated deletes that converged inline but WI-SYNC-1h
//   confirmed that an Outlook-side delete can leave Spectre's
//   mirror stale for the full 15-minute reconciliation window.
//
//   The 60-second delta poll + the webhook-expedited delta both
//   depend on the same `@removed` channel and inherit the same
//   gap.  The 15-min reconciliation sweep closes it with active
//   probing, but 15 minutes is too long for a manual refresh
//   click.  This service runs the same probe path on the subset
//   of messages the user is currently looking at.
//
// Scope + bounds:
//
//   • Only OPEN / IN_PROGRESS / INFORMATIONAL / DEFERRED WIs.
//     RESOLVED / SUPPRESSED are already finalised.
//   • At most 50 WIs per call (same bound as the existing reverify).
//   • One Graph round-trip per message; grouped by mailbox so
//     one access token covers all its messages.
//   • Delete loop prevention is reused via `applyTombstone` →
//     `handleEmailEvidenceDeleted`, which already checks for a
//     SUCCEEDED OutlookDeleteMutation and records
//     EVIDENCE_DELETE_RECONCILED instead of double-tombstoning.
//
// Archive preservation (founder's §3 explicit ask):
//
//   PRESENT_ARCHIVE is classified SKIP_ARCHIVE_DEFERRED by
//   classifyProbe (reconciliation.ts §WI-SYNC-1a).  This service
//   inherits that semantic — archived messages are NEVER
//   tombstoned.
//
// Financial preservation:
//
//   Only EmailMessage.softDeletedAt and WorkIntakeItem.status are
//   mutated.  Approvals / invoices / journal entries / payments
//   are untouched.

import { prisma } from "@/lib/prisma";
import { getMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated";
import { getFreshDelegatedAccessToken } from "./connect";
import { classifyProbe } from "./reconciliation";
import { logger } from "@/lib/observability/logger";

// WI-SYNC-1h (2026-10-18) — the reverify path cannot delegate the
// WI side of the tombstone to handleEmailEvidenceDeleted because
// that function has a historical-archive guard: if ANY SUCCEEDED
// OutlookArchiveMutation exists for the (workIntakeItemId,
// emailMessageId) pair, the handler records
// EVIDENCE_ARCHIVED and short-circuits.  The guard was designed
// for the Inbox-scoped delta's `@removed` event, where the current
// folder is unknown and the mutation history is the only signal.
//
// In the reverify path, probeMessage has ALREADY confirmed that
// the current folder is Deleted Items (not Archive).  A past
// archive is historical and irrelevant to the current state —
// the user has moved the message to Deleted Items in Outlook
// since whatever archive we did previously, and the user's intent
// is clear.
//
// This helper is a reverify-specific tombstone that preserves the
// invariants the general handler cares about (RESOLVED /
// SUPPRESSED early return, userDismissedAt preservation,
// Spectre-initiated DELETE loop guard via OutlookDeleteMutation,
// statusBeforeSuppression capture) WITHOUT the archive guard.
async function completeOutlookDetectedDelete(args: {
  clubId: string;
  emailMessageId: string;
}): Promise<"SUPPRESSED" | "LOOP_RECONCILED" | "DISMISSED_PRESERVED" | "ALREADY_FINAL" | "NO_LINK"> {
  const existing = await prisma.emailMessage.findUnique({
    where: { id: args.emailMessageId },
    select: { id: true, clubId: true, softDeletedAt: true },
  });
  if (!existing) return "NO_LINK";
  if (existing.clubId !== args.clubId) return "NO_LINK";
  if (!existing.softDeletedAt) {
    await prisma.emailMessage.update({
      where: { id: existing.id },
      data: { softDeletedAt: new Date(), lastSyncedAt: new Date() },
    });
  }
  const link = await prisma.emailWorkIntakeOrigin.findFirst({
    where: { emailMessageId: args.emailMessageId, role: "PRIMARY" },
    include: {
      workIntakeItem: {
        select: {
          id: true, clubId: true, status: true,
          statusBeforeSuppression: true, userDismissedAt: true,
        },
      },
    },
  });
  if (!link) return "NO_LINK";
  if (link.workIntakeItem.clubId !== args.clubId) return "NO_LINK";
  if (link.workIntakeItem.status === "RESOLVED" || link.workIntakeItem.status === "SUPPRESSED") {
    return "ALREADY_FINAL";
  }
  if (link.workIntakeItem.userDismissedAt) {
    await prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: link.workIntakeItemId,
        action: "EVIDENCE_RESTORED_DISMISSED",
        note: "User dismissal preserved on Outlook-detected delete (reverify path).",
      },
    });
    return "DISMISSED_PRESERVED";
  }
  // Spectre-initiated DELETE loop guard — if we JUST issued the
  // delete via deleteOutlookMessageForWorkIntake, the WI is
  // already SUPPRESSED and this path should not re-fire the
  // transition.  (The RESOLVED/SUPPRESSED early return above
  // normally catches this, but the guard is kept for parity with
  // handleEmailEvidenceDeleted.)
  const ourDelete = await prisma.outlookDeleteMutation.findFirst({
    where: {
      workIntakeItemId: link.workIntakeItemId,
      emailMessageId: args.emailMessageId,
      status: "SUCCEEDED",
    },
    select: { id: true },
  });
  if (ourDelete) {
    await prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: link.workIntakeItemId,
        action: "EVIDENCE_DELETE_RECONCILED",
        note: "Graph confirmed Spectre-initiated Delete move (reverify path) — no additional state change.",
      },
    });
    return "LOOP_RECONCILED";
  }
  const captureBefore =
    link.workIntakeItem.statusBeforeSuppression == null
      ? link.workIntakeItem.status
      : link.workIntakeItem.statusBeforeSuppression;
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: link.workIntakeItemId },
      data: {
        status: "SUPPRESSED",
        statusBeforeSuppression: captureBefore,
      },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: link.workIntakeItemId,
        action: "EVIDENCE_DELETED",
        note: "Source email found in Outlook Deleted Items by manual-refresh reverify.",
      },
    }),
  ]);
  return "SUPPRESSED";
}

export interface ReverifyResult {
  reverifiedCount: number;
  tombstonedCount: number;
  isReadUpdatedCount: number;
  archivePreservedCount: number;
  otherFolderCount: number;
  deletedCount: number;
  errors: number;
  // Per-message outcomes for diagnostic reports.
  details: Array<{
    emailMessageId: string;
    graphMessageId: string;
    disposition: string;
    action: string;
  }>;
}

export async function reverifyWorkIntakeEmails(args: {
  clubId: string;
  callerUserId: string;
  limit?: number;
}): Promise<ReverifyResult> {
  const limit = Math.min(100, Math.max(1, args.limit ?? 50));
  const result: ReverifyResult = {
    reverifiedCount: 0,
    tombstonedCount: 0,
    isReadUpdatedCount: 0,
    archivePreservedCount: 0,
    otherFolderCount: 0,
    deletedCount: 0,
    errors: 0,
    details: [],
  };

  const openIntakes = await prisma.workIntakeItem.findMany({
    where: {
      clubId: args.clubId,
      status: { in: ["OPEN", "IN_PROGRESS", "DEFERRED", "INFORMATIONAL"] },
      emailOrigins: { some: { role: "PRIMARY" } },
    },
    select: {
      id: true,
      emailOrigins: {
        where: { role: "PRIMARY" },
        take: 1,
        select: {
          emailMessage: {
            select: {
              id: true,
              graphMessageId: true,
              mailboxConnectionId: true,
              isRead: true,
              softDeletedAt: true,
            },
          },
        },
      },
    },
    take: limit,
    orderBy: { createdAt: "desc" },
  });

  type Row = {
    emailId: string;
    graphMessageId: string;
    currentIsRead: boolean;
    currentSoftDeletedAt: Date | null;
  };
  const byMailbox = new Map<string, Row[]>();
  for (const it of openIntakes) {
    const em = it.emailOrigins[0]?.emailMessage;
    if (!em) continue;
    if (!em.graphMessageId) continue;
    if (em.softDeletedAt) continue; // already tombstoned — nothing to reverify
    if (!byMailbox.has(em.mailboxConnectionId)) byMailbox.set(em.mailboxConnectionId, []);
    byMailbox.get(em.mailboxConnectionId)!.push({
      emailId: em.id,
      graphMessageId: em.graphMessageId,
      currentIsRead: em.isRead,
      currentSoftDeletedAt: em.softDeletedAt,
    });
  }

  const provider = getMicrosoftDelegatedProvider();

  for (const [mailboxId, rows] of byMailbox.entries()) {
    try {
      const tok = await getFreshDelegatedAccessToken({
        mailboxConnectionId: mailboxId,
        callerClubId: args.clubId,
        callerUserId: args.callerUserId,
      });

      // Resolve the three well-known folder ids once per mailbox —
      // same shape the main sweep uses.
      const [inboxFolder, deletedFolder, archiveFolder] = await Promise.all([
        provider.getWellKnownFolder({ accessToken: tok.accessToken, wellKnownName: "inbox" }),
        provider.getWellKnownFolder({ accessToken: tok.accessToken, wellKnownName: "deleteditems" }),
        provider.getWellKnownFolder({ accessToken: tok.accessToken, wellKnownName: "archive" }),
      ]);
      const folderNames: Record<string, string> = {};
      if (inboxFolder) folderNames[inboxFolder.id] = `Inbox (${inboxFolder.displayName})`;
      if (deletedFolder) folderNames[deletedFolder.id] = `Deleted Items (${deletedFolder.displayName})`;
      if (archiveFolder) folderNames[archiveFolder.id] = `Archive (${archiveFolder.displayName})`;

      for (const r of rows) {
        try {
          const probe = await provider.probeMessage({
            accessToken: tok.accessToken,
            graphMessageId: r.graphMessageId,
          });
          const row = classifyProbe({
            base: {
              emailMessageId: r.emailId,
              graphMessageId: r.graphMessageId,
              subject: "",
              senderAddress: "",
              receivedAt: new Date(0),
              linkedWorkIntakeItemId: null,
              linkedWorkIntakeStatus: null,
              hasApIntakeSource: false,
              probeOutcome: probe.outcome,
              httpStatus: probe.httpStatus,
              errorCode: probe.errorCode,
              retryAfterSeconds: probe.retryAfterSeconds,
            },
            probe,
            inboxFolderId: inboxFolder?.id ?? null,
            deletedItemsFolderId: deletedFolder?.id ?? null,
            archiveFolderId: archiveFolder?.id ?? null,
            folderNames,
          });
          result.reverifiedCount += 1;
          result.details.push({
            emailMessageId: r.emailId,
            graphMessageId: r.graphMessageId,
            disposition: row.disposition,
            action: row.action,
          });

          switch (row.disposition) {
            case "PRESENT_INBOX": {
              // Still in Inbox — update isRead if Graph has changed it.
              if (
                typeof probe.isRead === "boolean" &&
                probe.isRead !== r.currentIsRead
              ) {
                await prisma.emailMessage.update({
                  where: { id: r.emailId },
                  data: { isRead: probe.isRead, lastSyncedAt: new Date() },
                });
                result.isReadUpdatedCount += 1;
              }
              break;
            }
            case "PRESENT_DELETED_ITEMS": {
              // Reverify-specific tombstone — bypasses the general
              // handler's historical-archive guard, because the
              // probe has already proved the message is CURRENTLY
              // in Deleted Items (not Archive).  Preserves the
              // RESOLVED/SUPPRESSED early return, userDismissedAt
              // preservation, DELETE-loop guard, and
              // statusBeforeSuppression capture.
              await completeOutlookDetectedDelete({
                emailMessageId: r.emailId,
                clubId: args.clubId,
              });
              result.tombstonedCount += 1;
              break;
            }
            case "PRESENT_ARCHIVE": {
              // Archive is NOT equivalent to deletion (founder's §3).
              // Leave softDeletedAt alone.
              result.archivePreservedCount += 1;
              break;
            }
            case "PRESENT_OTHER_FOLDER": {
              result.otherFolderCount += 1;
              break;
            }
            case "DELETED": {
              // 404 — the message is gone entirely.  Same reverify-
              // specific tombstone path as PRESENT_DELETED_ITEMS:
              // Graph confirms the message cannot be the result of
              // an archive, so the historical-archive guard would
              // be wrong here too.
              await completeOutlookDetectedDelete({
                emailMessageId: r.emailId,
                clubId: args.clubId,
              });
              result.deletedCount += 1;
              break;
            }
            // INACCESSIBLE_RETRYABLE / INACCESSIBLE_PERMANENT are
            // left to the next sweep tick — don't tombstone on a
            // transient Graph error.
            default:
              break;
          }
        } catch (err) {
          result.errors += 1;
          logger.warn("mailbox.reverify.probe_failed", {
            emailMessageIdTail: r.emailId.slice(-6),
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      // Mailbox-level token / token-refresh failure — count every
      // message as an error but keep going on the next mailbox.
      result.errors += rows.length;
      logger.warn("mailbox.reverify.mailbox_failed", {
        mailboxIdTail: mailboxId.slice(-6),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
